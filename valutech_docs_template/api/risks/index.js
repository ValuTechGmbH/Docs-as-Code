"use strict";

/*
 * GET  /api/risks/me       -> { login, canEdit, branch }
 * GET  /api/risks/state    -> { branch, head, files: { path: blobSha } } on the branch
 * POST /api/risks/commit   -> commits edited and new risks to the branch
 *
 * The browser editor (risks-editor.js) keeps edits pending until the user
 * commits; this function writes them as one commit through the GitHub App.
 * Who may edit is GitHub's answer for the signed-in user (write access or
 * more on the repository); the commit credits them with a Co-authored-by
 * trailer. Only `.md` files inside the risk directory are ever written.
 *
 * Commit body:
 *   { message?, changes: [{ path, baseSha, form }   edit an existing file
 *                         | { form } ] }            new risk; the id is assigned here
 *
 * Every form is validated against schema.json, which the MkDocs build writes
 * next to this file from the plugin config. Without it the function answers 404.
 *
 * Application settings: as for the comments function, plus optionally
 *   GITHUB_BRANCH                 branch to commit to (default: main)
 * The App needs Contents: write on the repository.
 */

const crypto = require("crypto");
const { readAppConfig, request } = require("../lib/github");
const { HttpError, fail, principal, readJson, respond } = require("../lib/http");
const { formatRisk, slug, validateRisk } = require("../lib/riskfile");

const WRITE_ACCESS = new Set(["admin", "maintain", "write"]);
const PERMISSION_CACHE_MS = 60_000;
const MAX_CHANGES = 50;
const MAX_MESSAGE = 2000;
const ATTEMPTS = 3;

/* Per-instance caches; all safe to lose. Blob ids never change meaning. */
const permissions = new Map();
const userIds = new Map();
const blobIds = new Map();

function loadSchema() {
  try {
    return require("./schema.json");
  } catch (error) {
    throw new HttpError(404, "Risk editing is not enabled for this site.");
  }
}

function readConfig() {
  const branch = process.env.GITHUB_BRANCH || "main";
  if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(branch)) {
    const error = new HttpError(503, "Risk editing is not configured.");
    error.detail = `GITHUB_BRANCH is not a branch name: ${branch}`;
    throw error;
  }
  return { ...readAppConfig("Risk editing is"), branch, schema: loadSchema() };
}

/** Git's id for a blob with this content. */
function blobSha(text) {
  const data = Buffer.from(text, "utf8");
  return crypto.createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}

// -- GitHub ------------------------------------------------------------------

async function canEdit(config, login) {
  const cached = permissions.get(login);
  if (cached && cached.at > Date.now() - PERMISSION_CACHE_MS) return cached.allowed;

  const result = await request(
    config,
    `/repos/${config.repo}/collaborators/${encodeURIComponent(login)}/permission`,
    { allow404: true }
  );
  const allowed = Boolean(result && WRITE_ACCESS.has(result.permission));
  permissions.set(login, { at: Date.now(), allowed });
  return allowed;
}

async function coAuthor(config, login) {
  if (!userIds.has(login)) {
    const user = await request(config, `/users/${encodeURIComponent(login)}`);
    userIds.set(login, user.id);
  }
  return `Co-authored-by: ${login} <${userIds.get(login)}+${login}@users.noreply.github.com>`;
}

/** The branch head: commit id and root tree id. */
async function head(config) {
  const ref = await request(config, `/repos/${config.repo}/git/ref/heads/${config.branch}`);
  const commit = await request(config, `/repos/${config.repo}/git/commits/${ref.object.sha}`);
  return { sha: commit.sha, tree: commit.tree.sha };
}

/** `{ path: blobSha }` for every `.md` file under the risk directory at `tree`. */
async function riskFiles(config, tree) {
  let sha = tree;
  for (const name of config.schema.dir.split("/").filter(Boolean)) {
    const level = await request(config, `/repos/${config.repo}/git/trees/${sha}`);
    const entry = level.tree.find((item) => item.path === name && item.type === "tree");
    if (!entry) return {};
    sha = entry.sha;
  }

  const listing = await request(config, `/repos/${config.repo}/git/trees/${sha}?recursive=1`);
  if (listing.truncated) throw new HttpError(502, "The risk directory is too large to list.");

  const files = {};
  for (const item of listing.tree) {
    if (item.type === "blob" && item.path.endsWith(".md")) files[`${config.schema.dir}/${item.path}`] = item.sha;
  }
  return files;
}

/* The `id:` line of a canonical risk file (front matter starts the file). */
function idOf(text) {
  const front = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const line = front && /^id:[ \t]*(.+?)[ \t]*$/m.exec(front[1]);
  if (!line) return null;
  const value = line[1];
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch (error) {
      return null;
    }
  }
  return value.replace(/^'(.*)'$/, "$1");
}

/** `{ path: id }` for the files; each blob is fetched once per warm instance. */
async function riskIds(config, files) {
  const entries = Object.entries(files);
  const missing = entries.filter(([, sha]) => !blobIds.has(sha));
  for (let i = 0; i < missing.length; i += 8) {
    await Promise.all(
      missing.slice(i, i + 8).map(async ([, sha]) => {
        const blob = await request(config, `/repos/${config.repo}/git/blobs/${sha}`);
        blobIds.set(sha, idOf(Buffer.from(blob.content, "base64").toString("utf8")));
      })
    );
  }
  const ids = {};
  for (const [path, sha] of entries) ids[path] = blobIds.get(sha);
  return ids;
}

// -- commit ------------------------------------------------------------------

function checkPath(config, path) {
  const prefix = `${config.schema.dir}/`;
  if (
    typeof path !== "string" ||
    !path.startsWith(prefix) ||
    !path.endsWith(".md") ||
    !/^[\w.\-/]+$/.test(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new HttpError(400, `Not a risk file: ${String(path).slice(0, 200)}`);
  }
}

/** Validate the request; nothing here depends on the branch state. */
function parseChanges(config, body) {
  const changes = body && body.changes;
  if (!Array.isArray(changes) || !changes.length) throw new HttpError(400, "Nothing to commit.");
  if (changes.length > MAX_CHANGES) throw new HttpError(400, `At most ${MAX_CHANGES} risks per commit.`);

  const problems = [];
  const seen = new Set();
  const parsed = changes.map((change, n) => {
    if (!change || typeof change !== "object") throw new HttpError(400, "Malformed change.");
    const isNew = change.path === undefined || change.path === null;
    if (!isNew) {
      checkPath(config, change.path);
      if (seen.has(change.path)) throw new HttpError(400, `${change.path} is changed twice.`);
      seen.add(change.path);
      if (!/^[0-9a-f]{40}$/.test(String(change.baseSha))) throw new HttpError(400, "Missing baseSha.");
    }

    const form = isNew ? { ...change.form, id: "NEW" } : change.form;
    const { risk, errors } = validateRisk(form, config.schema);
    const label = isNew ? `new risk ${n + 1}` : change.path;
    errors.forEach((error) => problems.push(`${label}: ${error}`));
    if (isNew && risk && !errors.length && !(config.schema.categories[slug(risk.category)] || {}).id_prefix) {
      problems.push(`${label}: category ${risk.category} has no id_prefix, so new risks cannot be numbered`);
    }
    return { isNew, path: change.path, baseSha: change.baseSha, risk };
  });

  if (problems.length) {
    const error = new HttpError(422, "Some risks are not valid.");
    error.body = { problems };
    throw error;
  }

  let message = String(body.message || "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_MESSAGE);
  if (!message) message = defaultMessage(parsed);
  return { changes: parsed, message };
}

function defaultMessage(changes) {
  const edited = changes.filter((c) => !c.isNew).map((c) => c.risk.id);
  const added = changes.filter((c) => c.isNew).length;
  const parts = [];
  if (edited.length) parts.push(`update ${edited.join(", ")}`);
  if (added) parts.push(`add ${added} risk${added === 1 ? "" : "s"}`);
  const text = parts.join("; ");
  return `Risks: ${text}`;
}

/*
 * Lay the changes onto the current head. Throws 409 with the conflicting paths
 * when a file changed since the editor loaded it, or an id is taken.
 */
function plan(config, changes, files, ids) {
  const conflicts = [];
  const taken = new Map(Object.entries(ids).map(([path, id]) => [String(id).toLowerCase(), path]));
  const next = {};
  const writes = [];

  for (const change of changes) {
    if (change.isNew) continue;
    if (files[change.path] !== change.baseSha) {
      conflicts.push({ path: change.path, reason: files[change.path] ? "changed" : "deleted" });
    } else if (ids[change.path] !== null && ids[change.path] !== change.risk.id) {
      /* A file without a readable id is broken; editing may repair it. */
      conflicts.push({ path: change.path, reason: "id", message: "The id of an existing risk cannot change." });
    } else {
      writes.push({ path: change.path, risk: change.risk, isNew: false });
    }
  }

  for (const change of changes) {
    if (!change.isNew) continue;
    const prefix = config.schema.categories[slug(change.risk.category)].id_prefix;
    if (!(prefix in next)) {
      const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)$`, "i");
      next[prefix] = 1 + Math.max(0, ...Object.values(ids).map((id) => Number((pattern.exec(id || "") || [])[1] || 0)));
    }
    const id = `${prefix}${next[prefix]++}`;
    const name = slug(change.risk.title).slice(0, 60).replace(/-+$/, "");
    const path = `${config.schema.dir}/${id}${name ? `-${name}` : ""}.md`;
    if (files[path] || taken.has(id.toLowerCase())) {
      conflicts.push({ path, reason: "exists", message: `${id} is already taken.` });
    }
    writes.push({ path, risk: { ...change.risk, id }, isNew: true });
  }

  if (conflicts.length) {
    const error = new HttpError(409, `Some risks changed on ${config.branch} since you started editing.`);
    error.body = { branch: config.branch, conflicts };
    throw error;
  }
  return writes.map((write) => ({ ...write, content: formatRisk(write.risk) }));
}

async function commit(config, login, body) {
  if (!(await canEdit(config, login))) {
    throw new HttpError(403, "You need write access to the repository to edit risks.");
  }
  const { changes, message } = parseChanges(config, body);
  const trailer = await coAuthor(config, login);

  for (let attempt = 1; ; attempt += 1) {
    const base = await head(config);
    const files = await riskFiles(config, base.tree);
    const writes = plan(config, changes, files, await riskIds(config, files));

    const tree = await request(config, `/repos/${config.repo}/git/trees`, {
      method: "POST",
      body: {
        base_tree: base.tree,
        tree: writes.map((w) => ({ path: w.path, mode: "100644", type: "blob", content: w.content }))
      }
    });
    const created = await request(config, `/repos/${config.repo}/git/commits`, {
      method: "POST",
      body: { message: `${message}\n\n${trailer}\n`, tree: tree.sha, parents: [base.sha] }
    });

    try {
      await request(config, `/repos/${config.repo}/git/refs/heads/${config.branch}`, {
        method: "PATCH",
        body: { sha: created.sha, force: false }
      });
    } catch (error) {
      /* 422: the branch moved since we read it. Lay the changes onto the new head. */
      if (error.githubStatus === 422 && attempt < ATTEMPTS) continue;
      throw error;
    }

    return {
      commit: created.sha,
      url: created.html_url,
      files: writes.map((w) => ({ path: w.path, id: w.risk.id, sha: blobSha(w.content), new: w.isNew }))
    };
  }
}

// -- entry -------------------------------------------------------------------

module.exports = async function (context, req) {
  const method = String(req.method || "GET").toUpperCase();
  const action = String((req.params && req.params.action) || "");

  try {
    const config = readConfig();

    if (method === "GET" && action === "me") {
      const { login } = principal(req, "edit risks");
      respond(context, 200, { login, canEdit: await canEdit(config, login), branch: config.branch });
    } else if (method === "GET" && action === "state") {
      principal(req, "edit risks");
      const base = await head(config);
      respond(context, 200, { branch: config.branch, head: base.sha, files: await riskFiles(config, base.tree) });
    } else if (method === "POST" && action === "commit") {
      const { login } = principal(req, "edit risks");
      respond(context, 201, await commit(config, login, readJson(req)));
    } else {
      respond(context, 404, { error: "Not found." });
    }
  } catch (error) {
    fail(context, "risks", error);
  }
};

/* exported for the smoke test */
module.exports.idOf = idOf;
module.exports.blobSha = blobSha;

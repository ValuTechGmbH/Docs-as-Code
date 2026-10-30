/*
 * Smoke test for the risk editor API against an in-memory GitHub (no network).
 *
 *   node tests/risks-api.smoke.js
 *
 * Covers permissions, state, committing edits and new risks (id allocation,
 * canonical file text, Co-authored-by), stale edits, invalid forms, paths
 * outside the risk directory, and a branch that moves during the commit.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const API_DIR = path.join(__dirname, "..", "valutech_docs_template", "api");
const SCHEMA_PATH = path.join(API_DIR, "risks", "schema.json");
const { formatRisk } = require(path.join(API_DIR, "lib", "riskfile.js"));

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
  else console.log(`ok   ${name}`);
};

const SCHEMA = {
  dir: "risks",
  default_repo: "o/r",
  probability: ["low", "medium", "high"],
  impact: ["low", "medium", "high"],
  levels: [],
  statuses: ["open", "mitigating", "accepted", "occurred", "closed"],
  mitigation_statuses: ["planned", "in-progress", "done", "dropped"],
  categories: { communication: { title: "Comms", id_prefix: "K" }, cloud: { title: "Cloud", id_prefix: null } }
};

const form = (overrides) => ({
  id: "K1", title: "Mesh routing", category: "communication", status: "open", owner: null,
  probability: "high", impact: "medium", residual: null, reviewed: null,
  mitigations: [], issues: [], extra: {}, body: "Body.\n", ...overrides
});

// -- fake GitHub ---------------------------------------------------------------

const gitSha = (text) => {
  const data = Buffer.from(text, "utf8");
  return crypto.createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
};

const repo = {
  trees: new Map(),   // tree id -> { path: content }
  commits: new Map(), // commit id -> { tree, parents, message }
  head: null,
  permissions: { writer: "write", reader: "read" },
  beforePatch: null   // hook run once before the next ref update
};
let counter = 0;

function addCommit(files, parents, message) {
  const tree = `tree${++counter}`;
  repo.trees.set(tree, files);
  const sha = crypto.createHash("sha1").update(`commit${counter}`).digest("hex");
  repo.commits.set(sha, { tree, parents, message });
  return sha;
}

repo.head = addCommit(
  {
    "README.md": "readme\n",
    "risks/K1-mesh-routing.md": formatRisk(form()),
    "risks/K4-antennas.md": formatRisk(form({ id: "K4", title: "Antennas" })),
    "risks/C1-cloud.md": formatRisk(form({ id: "C1", title: "Cloud", category: "cloud" }))
  },
  [],
  "initial"
);

function listTree(id, recursive) {
  const [root, dir] = id.split(":");
  const files = repo.trees.get(root);
  const prefix = dir ? `${dir}/` : "";
  const entries = new Map();
  for (const [file, content] of Object.entries(files)) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    if (recursive || !rest.includes("/")) entries.set(rest, { path: rest, type: "blob", sha: gitSha(content) });
    else entries.set(rest.split("/")[0], { path: rest.split("/")[0], type: "tree", sha: `${root}:${prefix}${rest.split("/")[0]}` });
  }
  return { tree: [...entries.values()], truncated: false };
}

const blobs = () => {
  const all = new Map();
  for (const files of repo.trees.values()) for (const content of Object.values(files)) all.set(gitSha(content), content);
  return all;
};

global.fetch = async (url, options = {}) => {
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(options.body) : null;
  const route = url.replace("https://api.github.com", "");
  const reply = (status, payload) => ({ ok: status < 300, status, json: async () => payload });
  let m;

  if (route === "/app/installations/1/access_tokens") return reply(201, { token: "t", expires_at: new Date(Date.now() + 3.6e6).toISOString() });
  if ((m = /^\/repos\/o\/r\/collaborators\/([\w-]+)\/permission$/.exec(route))) {
    return repo.permissions[m[1]] ? reply(200, { permission: repo.permissions[m[1]] }) : reply(404, { message: "Not Found" });
  }
  if ((m = /^\/users\/([\w-]+)$/.exec(route))) return reply(200, { id: 4242, login: m[1] });
  if (route === "/repos/o/r/git/ref/heads/main") return reply(200, { object: { sha: repo.head } });
  if ((m = /^\/repos\/o\/r\/git\/commits\/(\w+)$/.exec(route))) return reply(200, { sha: m[1], tree: { sha: repo.commits.get(m[1]).tree } });
  if ((m = /^\/repos\/o\/r\/git\/trees\/([\w:/-]+?)(\?recursive=1)?$/.exec(route)) && method === "GET") return reply(200, listTree(m[1], Boolean(m[2])));
  if ((m = /^\/repos\/o\/r\/git\/blobs\/(\w+)$/.exec(route))) return reply(200, { content: Buffer.from(blobs().get(m[1])).toString("base64") });
  if (route === "/repos/o/r/git/trees" && method === "POST") {
    const files = { ...repo.trees.get(body.base_tree) };
    for (const entry of body.tree) files[entry.path] = entry.content;
    const tree = `tree${++counter}`;
    repo.trees.set(tree, files);
    return reply(201, { sha: tree });
  }
  if (route === "/repos/o/r/git/commits" && method === "POST") {
    const sha = crypto.createHash("sha1").update(`commit${++counter}`).digest("hex");
    repo.commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
    return reply(201, { sha, html_url: `https://github.com/o/r/commit/${sha}` });
  }
  if (route === "/repos/o/r/git/refs/heads/main" && method === "PATCH") {
    if (repo.beforePatch) { const hook = repo.beforePatch; repo.beforePatch = null; hook(); }
    if (repo.commits.get(body.sha).parents[0] !== repo.head && !body.force) return reply(422, { message: "Update is not a fast forward" });
    repo.head = body.sha;
    return reply(200, { object: { sha: body.sha } });
  }
  return reply(404, { message: `fake GitHub has no ${method} ${route}` });
};

// -- harness -----------------------------------------------------------------

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
Object.assign(process.env, {
  GITHUB_APP_ID: "1",
  GITHUB_APP_INSTALLATION_ID: "1",
  GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }),
  GITHUB_REPO: "o/r"
});

const handler = require(path.join(API_DIR, "risks", "index.js"));

async function call(method, action, { login = "writer", body } = {}) {
  const principal = Buffer.from(JSON.stringify({ identityProvider: "github", userDetails: login })).toString("base64");
  const context = { log: { error() {} } };
  await handler(context, {
    method,
    params: { action },
    headers: login ? { "x-ms-client-principal": principal } : {},
    body
  });
  return { status: context.res.status, body: JSON.parse(context.res.body) };
}

const headFiles = () => repo.trees.get(repo.commits.get(repo.head).tree);

async function main() {
  // Without schema.json the editor is off.
  check("no schema -> 404", (await call("GET", "me")).status, 404);
  fs.writeFileSync(SCHEMA_PATH, JSON.stringify(SCHEMA));
  delete require.cache[SCHEMA_PATH];

  check("me/writer", (await call("GET", "me")).body, { login: "writer", canEdit: true, branch: "main" });
  check("me/reader", (await call("GET", "me", { login: "reader" })).body, { login: "reader", canEdit: false, branch: "main" });
  check("me/stranger", (await call("GET", "me", { login: "stranger" })).body.canEdit, false);
  check("me/anonymous -> 401", (await call("GET", "me", { login: null })).status, 401);

  const state = await call("GET", "state");
  check("state names the branch", state.body.branch, "main");
  check("state lists risk files only", Object.keys(state.body.files).sort(), ["risks/C1-cloud.md", "risks/K1-mesh-routing.md", "risks/K4-antennas.md"]);
  const k1Sha = state.body.files["risks/K1-mesh-routing.md"];
  const k4Sha = state.body.files["risks/K4-antennas.md"];

  // Reader cannot commit.
  const denied = await call("POST", "commit", { login: "reader", body: { changes: [{ path: "risks/K1-mesh-routing.md", baseSha: k1Sha, form: form() }] } });
  check("reader commit -> 403", denied.status, 403);

  // Outside the risk directory.
  for (const bad of ["risks/../README.md", "README.md", "risks/x.txt", "risks//x.md"]) {
    const res = await call("POST", "commit", { body: { changes: [{ path: bad, baseSha: k1Sha, form: form() }] } });
    check(`path ${bad} -> 400`, res.status, 400);
  }

  // Invalid forms are listed, nothing is committed.
  const before = repo.head;
  const invalid = await call("POST", "commit", {
    body: { changes: [
      { path: "risks/K1-mesh-routing.md", baseSha: k1Sha, form: form({ status: "zz" }) },
      { form: form({ id: undefined, category: "cloud", title: "No prefix" }) }
    ] }
  });
  check("invalid -> 422", invalid.status, 422);
  check("invalid problems", invalid.body.problems, [
    "risks/K1-mesh-routing.md: status: must be one of open, mitigating, accepted, occurred, closed",
    "new risk 2: category cloud has no id_prefix, so new risks cannot be numbered"
  ]);
  check("invalid leaves branch", repo.head, before);

  // Changing the id of an existing risk is refused.
  const rename = await call("POST", "commit", { body: { changes: [{ path: "risks/K1-mesh-routing.md", baseSha: k1Sha, form: form({ id: "K9" }) }] } });
  check("id change -> 409", [rename.status, rename.body.conflicts[0].reason], [409, "id"]);

  // A real commit: one edit, two new risks.
  const edited = form({ status: "mitigating", mitigations: [{ text: "Test it", status: "planned", issues: ["#3"], extra: {} }] });
  const ok = await call("POST", "commit", {
    body: {
      message: "Review mesh risks",
      changes: [
        { path: "risks/K1-mesh-routing.md", baseSha: k1Sha, form: edited },
        { form: form({ id: "", title: "Sink placement: unclear!" }) },
        { form: form({ id: "", title: "Second new" }) }
      ]
    }
  });
  check("commit -> 201", ok.status, 201);
  check("commit files", ok.body.files.map((f) => [f.path, f.id, f.new]), [
    ["risks/K1-mesh-routing.md", "K1", false],
    ["risks/K5-sink-placement-unclear.md", "K5", true],
    ["risks/K6-second-new.md", "K6", true]
  ]);
  const files = headFiles();
  check("branch moved to commit", repo.head, ok.body.commit);
  check("edited file is canonical", files["risks/K1-mesh-routing.md"], formatRisk(edited));
  check("returned sha is the blob id", ok.body.files[0].sha, gitSha(files["risks/K1-mesh-routing.md"]));
  check("new file has its id", files["risks/K5-sink-placement-unclear.md"].split("\n")[1], "id: K5");
  check("other files untouched", files["README.md"], "readme\n");
  check(
    "message + trailer",
    repo.commits.get(repo.head).message,
    "Review mesh risks\n\nCo-authored-by: writer <4242+writer@users.noreply.github.com>\n"
  );

  // The same edit again is stale now.
  const stale = await call("POST", "commit", { body: { changes: [{ path: "risks/K1-mesh-routing.md", baseSha: k1Sha, form: edited }] } });
  check("stale -> 409", [stale.status, stale.body.conflicts], [409, [{ path: "risks/K1-mesh-routing.md", reason: "changed" }]]);

  // Someone pushes to the branch between our commit and the ref update.
  let concurrent;
  repo.beforePatch = () => {
    concurrent = addCommit({ ...headFiles(), "README.md": "changed elsewhere\n" }, [repo.head], "concurrent");
    repo.head = concurrent;
  };
  const raced = await call("POST", "commit", {
    body: { changes: [{ path: "risks/K4-antennas.md", baseSha: k4Sha, form: form({ id: "K4", title: "Antennas", owner: "Jane" }) }] }
  });
  check("race -> 201", raced.status, 201);
  check("race keeps the concurrent change", headFiles()["README.md"], "changed elsewhere\n");
  check("race default message", repo.commits.get(repo.head).message.split("\n")[0], "Risks: update K4");
  check("race commit on top", repo.commits.get(repo.head).parents, [concurrent]);
  check("race edit applied", headFiles()["risks/K4-antennas.md"].includes("owner: Jane\n"), true);
}

main()
  .catch((error) => { failures++; console.log("FAIL crashed:", error); })
  .finally(() => {
    fs.rmSync(SCHEMA_PATH, { force: true });
    console.log(failures ? `${failures} check(s) failed` : "all checks passed");
    process.exit(failures ? 1 : 0);
  });

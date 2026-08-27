"use strict";

/*
 * GET  /api/comments?page=/a/b/   -> the comments on that page, with state
 * POST /api/comments             -> opens one GitHub issue for one comment
 *
 * The commenter's GitHub handle is read from the `x-ms-client-principal` header
 * that the Static Web Apps edge injects, so it reflects the signed-in user and
 * cannot be set by the browser. The issue itself is opened by the GitHub App;
 * the handle is recorded in the issue body.
 *
 * Required application settings:
 *   GITHUB_APP_ID                 numeric App ID
 *   GITHUB_APP_INSTALLATION_ID    installation of that App on the docs repo
 *   GITHUB_APP_PRIVATE_KEY        PEM, single line with \n or multi-line
 *   GITHUB_REPO                   "owner/name"
 * Optional:
 *   GITHUB_COMMENT_LABEL          label applied to every comment issue
 *   DOCS_SITE_URL                 site root, used for the link in the issue
 */

const { paginate, request } = require("../lib/github");
const { HttpError, buildIssue, parseIssue, validate } = require("../lib/issue");

const DEFAULT_LABEL = "docs-comment";
const LIST_CACHE_MS = 20_000;

/* Per-instance caches; both are safe to lose. */
let listCache = null;
const ensuredLabels = new Set();

function readConfig() {
  const config = {
    appId: process.env.GITHUB_APP_ID,
    installationId: process.env.GITHUB_APP_INSTALLATION_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    repo: process.env.GITHUB_REPO,
    label: process.env.GITHUB_COMMENT_LABEL || DEFAULT_LABEL,
    siteUrl: process.env.DOCS_SITE_URL || ""
  };

  const missing = ["appId", "installationId", "privateKey", "repo"].filter((key) => !config[key]);
  if (missing.length) {
    const names = {
      appId: "GITHUB_APP_ID",
      installationId: "GITHUB_APP_INSTALLATION_ID",
      privateKey: "GITHUB_APP_PRIVATE_KEY",
      repo: "GITHUB_REPO"
    };
    const error = new HttpError(503, "Comments are not configured.");
    error.detail = `missing application settings: ${missing.map((key) => names[key]).join(", ")}`;
    throw error;
  }

  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repo)) {
    const error = new HttpError(503, "Comments are not configured.");
    error.detail = `GITHUB_REPO is not "owner/name": ${config.repo}`;
    throw error;
  }

  return config;
}

/** The signed-in GitHub user, as reported by the Static Web Apps edge. */
function principal(req) {
  const headers = req.headers || {};
  const raw = headers["x-ms-client-principal"] || headers["X-MS-CLIENT-PRINCIPAL"];
  if (!raw) throw new HttpError(401, "Sign in to comment.");

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch (error) {
    throw new HttpError(401, "Sign in to comment.");
  }

  if (parsed.identityProvider !== "github") {
    throw new HttpError(403, "Commenting requires signing in with GitHub.");
  }

  const login = String(parsed.userDetails || "").trim();
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) {
    throw new HttpError(403, "Your GitHub username could not be determined.");
  }

  return { login };
}

async function listIssues(config) {
  if (listCache && listCache.repo === config.repo && listCache.at > Date.now() - LIST_CACHE_MS) {
    return listCache.issues;
  }

  const issues = await paginate(
    config,
    `/repos/${config.repo}/issues?labels=${encodeURIComponent(config.label)}` +
      "&state=all&sort=created&direction=desc"
  );

  listCache = { repo: config.repo, at: Date.now(), issues };
  return issues;
}

async function ensureLabel(config) {
  const key = `${config.repo}#${config.label}`;
  if (ensuredLabels.has(key)) return;

  const existing = await request(config, `/repos/${config.repo}/labels/${encodeURIComponent(config.label)}`, {
    allow404: true
  });

  if (!existing) {
    await request(config, `/repos/${config.repo}/labels`, {
      method: "POST",
      body: {
        name: config.label,
        color: "1f6feb",
        description: "Reader comment submitted from the documentation site"
      }
    });
  }

  ensuredLabels.add(key);
}

async function handleList(config, req) {
  const page = String((req.query && req.query.page) || "").trim();
  if (!/^\/[\w\-./]{0,200}$/.test(page)) {
    throw new HttpError(400, "Invalid page reference.");
  }

  const comments = (await listIssues(config))
    .map(parseIssue)
    .filter((comment) => comment && comment.page === page);

  return { page, comments };
}

async function handleCreate(config, req) {
  const { login } = principal(req);
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
  const comment = validate(body);

  await ensureLabel(config);

  const issue = await request(config, `/repos/${config.repo}/issues`, {
    method: "POST",
    body: { ...buildIssue(comment, login, { siteUrl: config.siteUrl }), labels: [config.label] }
  });

  /* The new issue must show up in the next list request. */
  listCache = null;

  return parseIssue(issue);
}

function respond(context, status, body) {
  context.res = {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body)
  };
}

module.exports = async function (context, req) {
  const method = String(req.method || "GET").toUpperCase();

  try {
    const config = readConfig();

    if (method === "GET") {
      respond(context, 200, await handleList(config, req));
    } else if (method === "POST") {
      respond(context, 201, await handleCreate(config, req));
    } else {
      respond(context, 405, { error: "Method not allowed." });
    }
  } catch (error) {
    const status = error.status || 500;
    if (error.detail) context.log.error(`comments: ${error.detail}`);
    if (status >= 500) context.log.error("comments:", error);
    respond(context, status, {
      error: status >= 500 && !error.status ? "Internal error." : error.message
    });
  }
};

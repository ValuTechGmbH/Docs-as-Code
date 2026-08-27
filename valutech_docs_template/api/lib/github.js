"use strict";

/*
 * Minimal GitHub REST client authenticated as a GitHub App installation.
 *
 * Static Web Apps managed functions cannot use managed identity or Key Vault
 * references, so the App credentials come from application settings. Node 20
 * ships fetch and an RS256 signer, which is all an installation token needs —
 * this module deliberately has no npm dependencies.
 */

const crypto = require("crypto");

const API = "https://api.github.com";
const USER_AGENT = "valutech-docs-comments";
const ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";

/* Installation tokens live for an hour; cache one per warm instance. */
let cachedToken = null;

class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/*
 * Application settings are single-line, so a pasted PEM arrives with literal
 * "\n" sequences. Accept both that and a genuine multi-line value.
 */
function normalisePrivateKey(value) {
  return String(value || "").includes("\\n") ? String(value).replace(/\\n/g, "\n") : String(value || "");
}

function appJwt(config) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  /* Backdated by a minute to tolerate clock skew; GitHub rejects exp > 10 min. */
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.appId }));
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(normalisePrivateKey(config.privateKey));

  return `${header}.${payload}.${base64url(signature)}`;
}

async function installationToken(config) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const response = await fetch(`${API}/app/installations/${config.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      accept: ACCEPT,
      authorization: `Bearer ${appJwt(config)}`,
      "user-agent": USER_AGENT,
      "x-github-api-version": API_VERSION
    }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new GitHubError(502, `Could not obtain an installation token: ${payload.message || response.status}`);
  }

  cachedToken = { token: payload.token, expiresAt: new Date(payload.expires_at).getTime() };
  return cachedToken.token;
}

async function request(config, path, options = {}) {
  const send = async () => {
    const token = await installationToken(config);
    return fetch(`${API}${path}`, {
      method: options.method || "GET",
      headers: {
        accept: ACCEPT,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": USER_AGENT,
        "x-github-api-version": API_VERSION
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  };

  let response = await send();
  if (response.status === 401) {
    /* The cached token was revoked or the App was reinstalled. */
    cachedToken = null;
    response = await send();
  }

  if (response.status === 404 && options.allow404) return null;

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new GitHubError(
      response.status === 403 || response.status === 429 ? 503 : 502,
      `GitHub API ${response.status}: ${payload.message || "request failed"}`
    );
  }

  if (response.status === 204) return null;
  return response.json();
}

/** Walk the paginated list endpoints until a short page or `maxPages`. */
async function paginate(config, path, maxPages = 5) {
  const items = [];
  const separator = path.includes("?") ? "&" : "?";

  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await request(config, `${path}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < 100) break;
  }

  return items;
}

module.exports = { GitHubError, paginate, request };

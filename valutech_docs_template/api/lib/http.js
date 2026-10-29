"use strict";

/*
 * Request plumbing shared by the managed functions: errors with an HTTP status,
 * the signed-in GitHub user, JSON bodies and responses.
 */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The signed-in GitHub user, from the `x-ms-client-principal` header that the
 * Static Web Apps edge injects — the browser cannot set it.
 */
function principal(req, action = "do this") {
  const headers = req.headers || {};
  const raw = headers["x-ms-client-principal"] || headers["X-MS-CLIENT-PRINCIPAL"];
  if (!raw) throw new HttpError(401, `Sign in to ${action}.`);

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch (error) {
    throw new HttpError(401, `Sign in to ${action}.`);
  }

  if (parsed.identityProvider !== "github") {
    throw new HttpError(403, `You need to sign in with GitHub to ${action}.`);
  }

  const login = String(parsed.userDetails || "").trim();
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) {
    throw new HttpError(403, "Your GitHub username could not be determined.");
  }

  return { login };
}

function readJson(req) {
  if (typeof req.body !== "string") return req.body || {};
  try {
    return JSON.parse(req.body || "{}");
  } catch (error) {
    throw new HttpError(400, "The request body is not JSON.");
  }
}

function respond(context, status, body) {
  context.res = {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body)
  };
}

/** Map an error to a response; `name` prefixes the log lines. */
function fail(context, name, error) {
  const status = error.status || 500;
  if (error.detail) context.log.error(`${name}: ${error.detail}`);
  if (status >= 500) context.log.error(`${name}:`, error);
  const body = { error: status >= 500 && !error.status ? "Internal error." : error.message };
  if (error.body) Object.assign(body, error.body);
  respond(context, status, body);
}

module.exports = { HttpError, fail, principal, readJson, respond };

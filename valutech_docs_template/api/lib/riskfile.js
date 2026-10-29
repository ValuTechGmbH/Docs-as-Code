/*
 * Writes a risk file (YAML front matter + Markdown body) from its editor form,
 * and validates that form the way the build's model.py does.
 *
 * The editor never parses YAML: the build reads every file with PyYAML and
 * hands the browser the fields in this same shape (see
 * plugins/risks/source.py). This module only writes, always in one canonical
 * layout, so an edit made in the browser touches exactly the lines it changed:
 *
 *   ---
 *   id: K4
 *   title: Antennas chosen do not perform in the housing on the mesh
 *   category: communication
 *   status: mitigating
 *   owner: null
 *   probability: medium
 *   impact: high
 *   residual:
 *     probability: low
 *     impact: high
 *   reviewed: 2026-10-20
 *   mitigations:
 *     - text: Research antenna options ...
 *       status: in-progress
 *       issue: geobrugg-sentra/Planning#15
 *   issues:
 *     - "#11"
 *   ---
 *   Body, verbatim.
 *
 * Form shape:
 *   { id, title, category, status, owner, probability, impact,
 *     residual: { probability, impact } | null, reviewed: "YYYY-MM-DD" | null,
 *     mitigations: [{ text, status, issues: [ref], extra: {} }],
 *     issues: [ref], extra: {}, body }
 *
 * `extra` holds keys the editor does not know; they are written back unchanged
 * after the known ones. No npm dependencies, like the rest of this API.
 *
 * The same file runs in the browser editor (as `window.VtRiskFile`), so a form
 * is checked by exactly the rules the function enforces.
 */

(function (root) {
"use strict";

/* Words YAML 1.1 (PyYAML) reads as something other than a string. */
const RESERVED = /^(?:~|null|true|false|yes|no|on|off|y|n|\.inf|-\.inf|\+\.inf|\.nan)$/i;
const NUMBER_LIKE = /^[-+]?\.?[0-9]/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/* Keys the form owns; an `extra` entry by one of these names is ignored. */
const RISK_KEYS = new Set([
  "id", "title", "category", "status", "owner", "probability", "impact",
  "residual", "reviewed", "mitigations", "issue", "issues"
]);
const MITIGATION_KEYS = new Set(["text", "status", "issue", "issues"]);

/* A string that can be written without quotes and reads back unchanged. */
function isPlain(text) {
  return (
    text.length > 0 &&
    text === text.trim() &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(text) &&
    !/:(?:\s|$)|\s#|[\x00-\x1f\x7f\u0085\u2028\u2029\ufeff]/.test(text) &&
    !RESERVED.test(text) &&
    !NUMBER_LIKE.test(text)
  );
}

/* JSON's string escapes are a subset of YAML's double-quoted ones. */
function scalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`cannot write ${value} to a risk file`);
    return String(value);
  }
  const text = String(value);
  return isPlain(text) ? text : JSON.stringify(text);
}

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/* Block-style YAML for one `key: value` pair at `indent` spaces. */
function entry(key, value, indent) {
  const pad = " ".repeat(indent);
  const name = scalar(key);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}${name}: []\n`;
    return `${pad}${name}:\n` + value.map((item) => listItem(item, indent + 2)).join("");
  }
  if (isMapping(value)) {
    const keys = Object.keys(value);
    if (!keys.length) return `${pad}${name}: {}\n`;
    return `${pad}${name}:\n` + keys.map((k) => entry(k, value[k], indent + 2)).join("");
  }
  return `${pad}${name}: ${scalar(value)}\n`;
}

/* A list item; a mapping item starts on the dash line, its other keys align with the first. */
function listItem(item, indent) {
  const pad = " ".repeat(indent);
  if (isMapping(item) && Object.keys(item).length) {
    const lines = Object.keys(item).map((k) => entry(k, item[k], indent + 2)).join("");
    return pad + "- " + lines.slice(indent + 2);
  }
  if (Array.isArray(item) && item.length) {
    const lines = item.map((sub) => listItem(sub, indent + 2)).join("");
    return pad + "- " + lines.slice(indent + 2);
  }
  if (Array.isArray(item)) return `${pad}- []\n`;
  if (isMapping(item)) return `${pad}- {}\n`;
  return `${pad}- ${scalar(item)}\n`;
}

function date(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  if (!DATE.test(text)) throw new TypeError(`reviewed ${JSON.stringify(text)} is not YYYY-MM-DD`);
  return text;
}

/* `issue: ref` for a single reference, `issues: [...]` for several. */
function mitigation(item) {
  const out = { text: item.text, status: item.status };
  const refs = item.issues || [];
  if (refs.length === 1) out.issue = refs[0];
  else if (refs.length > 1) out.issues = refs;
  return Object.assign(out, unknown(item.extra, MITIGATION_KEYS));
}

function unknown(extra, known) {
  const out = {};
  for (const [key, value] of Object.entries(extra || {})) {
    if (!known.has(key)) out[key] = value;
  }
  return out;
}

function formatRisk(risk) {
  const meta = {
    id: risk.id,
    title: risk.title,
    category: risk.category,
    status: risk.status,
    owner: risk.owner === "" ? null : risk.owner,
    probability: risk.probability,
    impact: risk.impact
  };
  if (risk.residual) meta.residual = { probability: risk.residual.probability, impact: risk.residual.impact };
  const reviewed = date(risk.reviewed);
  if (reviewed) meta.reviewed = reviewed;
  if (risk.mitigations && risk.mitigations.length) meta.mitigations = risk.mitigations.map(mitigation);
  if (risk.issues && risk.issues.length) meta.issues = risk.issues;
  Object.assign(meta, unknown(risk.extra, RISK_KEYS));

  // A date is the one plain scalar we want PyYAML to read as a non-string.
  const front = Object.keys(meta)
    .map((key) => (key === "reviewed" ? `reviewed: ${meta.reviewed}\n` : entry(key, meta[key], 0)))
    .join("");

  const body = String(risk.body || "").replace(/\r\n?/g, "\n").replace(/^\n+/, "").trimEnd();
  return `---\n${front}---\n${body ? body + "\n" : ""}`;
}

// -- validation -------------------------------------------------------------

const ID = /^[A-Za-z0-9][\w.-]{0,19}$/;
const ISSUE_URL = /^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+\/?$/;
const ISSUE_FULL = /^[\w.-]+\/[\w.-]+#\d+$/;
const ISSUE_SHORT = /^#?\d+$/;

const LIMITS = { title: 200, owner: 100, mitigation: 2000, body: 50000, items: 50, extra: 10000 };

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function isDate(text) {
  if (!DATE.test(text)) return false;
  const [y, m, d] = text.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/*
 * Check a form against the build's schema (plugins/risks/source.py: schema()).
 * Returns `{ risk, errors }`: `risk` is the form tidied for formatRisk (trimmed,
 * empty owner as null, status lower-cased), `errors` a list of messages that
 * name the field. Only write `risk` when `errors` is empty.
 */
function validateRisk(form, schema) {
  const errors = [];
  if (!isMapping(form)) return { risk: null, errors: ["the risk is not an object"] };

  const line = (field, value, max, required) => {
    if (value === null || value === undefined || value === "") {
      if (required) errors.push(`${field}: is required`);
      return null;
    }
    const text = String(value).trim();
    if (!text && required) errors.push(`${field}: is required`);
    else if (/[\r\n]/.test(text)) errors.push(`${field}: must be a single line`);
    else if (text.length > max) errors.push(`${field}: is longer than ${max} characters`);
    return text || null;
  };

  const oneOf = (field, value, allowed) => {
    const text = String(value === null || value === undefined ? "" : value).trim().toLowerCase();
    if (!allowed.includes(text)) errors.push(`${field}: must be one of ${allowed.join(", ")}`);
    return text;
  };

  const rating = (field, value, labels) => {
    if (typeof value === "number") {
      if (!(Number.isInteger(value) && value >= 1 && value <= labels.length)) {
        errors.push(`${field}: must be 1 to ${labels.length}`);
      }
      return value;
    }
    const text = String(value === null || value === undefined ? "" : value).trim();
    if (!labels.some((label) => label.toLowerCase() === text.toLowerCase())) {
      errors.push(`${field}: must be one of ${labels.join(", ")}`);
    }
    return text;
  };

  const refs = (field, value) => {
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value)) {
      errors.push(`${field}: must be a list`);
      return [];
    }
    if (value.length > LIMITS.items) errors.push(`${field}: more than ${LIMITS.items} entries`);
    return value
      .map((ref) => String(ref === null || ref === undefined ? "" : ref).trim())
      .filter((ref) => {
        if (!ref) return false;
        if (ISSUE_URL.test(ref) || ISSUE_FULL.test(ref)) return true;
        if (ISSUE_SHORT.test(ref)) {
          if (schema.default_repo) return true;
          errors.push(`${field}: ${ref} needs owner/repo#n — no default repository is configured`);
        } else {
          errors.push(`${field}: ${ref} is not owner/repo#n, #n or a GitHub issue URL`);
        }
        return true;
      });
  };

  const extra = (field, value) => {
    if (value === null || value === undefined) return {};
    if (!isMapping(value)) {
      errors.push(`${field}: must be an object`);
      return {};
    }
    if (JSON.stringify(value).length > LIMITS.extra) errors.push(`${field}: is too large`);
    return value;
  };

  const risk = {};
  risk.id = line("id", form.id, 20, true);
  if (risk.id && !ID.test(risk.id)) errors.push("id: letters, digits, '.', '_' and '-' only, starting with a letter or digit");
  risk.title = line("title", form.title, LIMITS.title, true);

  const categories = Object.keys(schema.categories || {});
  risk.category = line("category", form.category, 100, true);
  if (risk.category && categories.length && !categories.includes(slug(risk.category))) {
    errors.push(`category: must be one of ${categories.join(", ")}`);
  }

  risk.status = oneOf("status", form.status, schema.statuses);
  risk.owner = line("owner", form.owner, LIMITS.owner, false);
  risk.probability = rating("probability", form.probability, schema.probability);
  risk.impact = rating("impact", form.impact, schema.impact);

  risk.residual = null;
  if (form.residual !== null && form.residual !== undefined) {
    if (!isMapping(form.residual)) {
      errors.push("residual: must have probability and impact");
    } else {
      risk.residual = {
        probability: rating("residual probability", form.residual.probability, schema.probability),
        impact: rating("residual impact", form.residual.impact, schema.impact)
      };
    }
  }

  risk.reviewed = null;
  if (form.reviewed !== null && form.reviewed !== undefined && form.reviewed !== "") {
    risk.reviewed = String(form.reviewed).trim();
    if (!isDate(risk.reviewed)) errors.push("reviewed: must be a date (YYYY-MM-DD)");
  }

  risk.mitigations = [];
  if (form.mitigations !== null && form.mitigations !== undefined && !Array.isArray(form.mitigations)) {
    errors.push("mitigations: must be a list");
  } else {
    const items = form.mitigations || [];
    if (items.length > LIMITS.items) errors.push(`mitigations: more than ${LIMITS.items} entries`);
    items.forEach((item, n) => {
      const field = `mitigation ${n + 1}`;
      if (!isMapping(item)) {
        errors.push(`${field}: is not an object`);
        return;
      }
      const text = String(item.text === null || item.text === undefined ? "" : item.text).trim();
      if (!text) errors.push(`${field}: needs a text`);
      else if (text.length > LIMITS.mitigation) errors.push(`${field}: is longer than ${LIMITS.mitigation} characters`);
      risk.mitigations.push({
        text,
        status: oneOf(`${field} status`, item.status, schema.mitigation_statuses),
        issues: refs(`${field} issues`, item.issues),
        extra: extra(`${field} extra`, item.extra)
      });
    });
  }

  risk.issues = refs("issues", form.issues);
  risk.extra = extra("extra", form.extra);

  risk.body = form.body === null || form.body === undefined ? "" : String(form.body);
  if (risk.body.length > LIMITS.body) errors.push(`body: is longer than ${LIMITS.body} characters`);

  return { risk, errors };
}

const api = { formatRisk, isPlain, slug, validateRisk };
if (typeof module === "object" && module.exports) module.exports = api;
else root.VtRiskFile = api;
})(typeof self !== "undefined" ? self : this);

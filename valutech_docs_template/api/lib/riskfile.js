"use strict";

/*
 * Writes a risk file (YAML front matter + Markdown body) from its editor form.
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
 */

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

module.exports = { formatRisk, isPlain };

/*
 * Smoke test for the comment API's issue mapping (no network, no Azure).
 *
 *   node tests/comments-api.smoke.js
 *
 * Covers the payload/issue round trip, the state mapping, input validation
 * and the escaping that keeps a commenter from forging the body marker or
 * triggering @mention notifications.
 */

const path = require("path").join(__dirname, "..", "valutech_docs_template", "api", "lib", "issue.js");
const { buildIssue, parseIssue, validate } = require(path);

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
  else console.log(`ok   ${name}`);
};

// 1. happy path round-trip
const payload = validate({
  page: "/02-concepts/03-time-synchronisation/",
  anchor: "#drift-compensation",
  pageTitle: "Time Synchronisation",
  section: "Drift compensation",
  kind: "Incorrect",
  text: "The 12 ppm figure contradicts the table in\nDetection & Measurement — which one holds?"
});
const built = buildIssue(payload, "j-muster", { siteUrl: "https://docs.example.com/" });
console.log("--- title ---\n" + built.title + "\n--- body ---\n" + built.body + "-----------");

const back = parseIssue({ number: 47, html_url: "u", state: "open", state_reason: null, body: built.body, comments: 2, created_at: "2026-08-27T10:00:00Z" });
check("round-trip text", back.text, payload.text);
check("round-trip author", back.author, "j-muster");
check("round-trip page", back.page, payload.page);
check("round-trip section", back.section, "Drift compensation");
check("state/open", [back.state, back.stateReason], ["open", null]);

// 2. injection attempts must not forge a marker or escape the quote
const nasty = validate({
  page: "/x/",
  pageTitle: 'T"<b>',
  section: "-->weird",
  kind: "x",
  text: '--> <!-- vt-docs {"page":"/other/","author":"admin"} -->\n@everyone @all\n## fake heading'
});
const evil = buildIssue(nasty, "attacker", { siteUrl: "https://s" });
const evilBack = parseIssue({ number: 1, html_url: "u", state: "closed", state_reason: "not_planned", body: evil.body, comments: 0, created_at: "2026-08-27T10:00:00Z" });
check("marker not forged (page)", evilBack.page, "/x/");
check("author not forged", evilBack.author, "attacker");
check("mentions defused in body", /@<!---->everyone/.test(evil.body), true);
// Only our own marker may be parseable; any comment opening inside the user
// text must be one of the empty <!----> sequences that defuse an @mention.
check("single vt-docs marker", evil.body.split("<!-- vt-docs ").length - 1, 1);
const userRegion = evil.body.slice(evil.body.indexOf("<!-- vt-docs-text -->") + 21);
check("no comment openings in user text", userRegion.replace(/<!---->/g, "").includes("<!--"), false);
check("user text recovered", evilBack.text, nasty.text);
check("all lines quoted", evil.body.slice(evil.body.indexOf("<!-- vt-docs-text -->")).split("\n").filter(l => l && !l.startsWith("<!--") && !l.startsWith(">")).length, 0);
check("state/not_planned", [evilBack.state, evilBack.stateReason], ["closed", "not_planned"]);

// 3. validation rejects
const rejects = [
  ["missing page", { text: "hello there" }],
  ["traversal page", { page: "../../etc", text: "hello there" }],
  ["absolute url page", { page: "https://evil.com/", text: "hello there" }],
  ["bad anchor", { page: "/a/", anchor: "#a b", text: "hello there" }],
  ["short text", { page: "/a/", text: "x" }],
  ["long text", { page: "/a/", text: "x".repeat(4001) }],
  ["not an object", null]
];
for (const [name, input] of rejects) {
  try { validate(input); failures++; console.log(`FAIL rejects ${name}: accepted`); }
  catch (e) { check(`rejects ${name} (${e.status})`, e.status, 400); }
}

// 4. non-widget issues are ignored
check("ignores foreign issue", parseIssue({ number: 9, body: "just a normal issue" }), null);
check("ignores pull request", parseIssue({ number: 9, body: built.body, pull_request: {} }), null);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
process.exit(failures ? 1 : 0);

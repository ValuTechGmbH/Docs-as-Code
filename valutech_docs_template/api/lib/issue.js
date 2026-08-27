"use strict";

/*
 * Translation between a submitted comment and a GitHub issue.
 *
 * Every issue carries a machine-readable marker in its body, so the widget can
 * find the comments belonging to a page without relying on the title (which
 * maintainers are free to edit) or on per-page labels (GitHub caps label names
 * at a length our page paths would exceed).
 *
 * Layout of a generated issue body:
 *
 *   <!-- vt-docs {"page":"/a/b/","anchor":"#c",...} -->
 *   **@handle** commented on [Page title · Section](https://site/a/b/#c)
 *   <sub>...how to resolve...</sub>
 *   <!-- vt-docs-text -->
 *   > the comment, quoted, to the end of the body
 */

const MARKER_RE = /<!--\s*vt-docs\s+(\{[\s\S]*?\})\s*-->/;
const TEXT_MARKER = "<!-- vt-docs-text -->";

const MAX_TEXT = 4000;
const MAX_TITLE = 200;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Strip anything that could break out of our HTML comment marker. */
function plain(value, maxLength) {
  return String(value == null ? "" : value)
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/*
 * User text is quoted into the issue body, so it must not be able to close our
 * markers, and its @mentions must not notify half the organisation. GitHub
 * renders `@<!---->name` as plain text.
 */
function neutralise(text) {
  return String(text)
    .replace(/-->/g, "--&gt;")
    .replace(/<!--/g, "&lt;!--")
    .replace(/@/g, "@<!---->");
}

function denormalise(text) {
  return String(text)
    .replace(/@<!---->/g, "@")
    .replace(/&lt;!--/g, "<!--")
    .replace(/--&gt;/g, "-->");
}

/** Validate and normalise the widget payload. Throws HttpError on bad input. */
function validate(payload) {
  if (!payload || typeof payload !== "object") {
    throw new HttpError(400, "Malformed request body.");
  }

  const page = String(payload.page || "").trim();
  if (!/^\/[\w\-./]{0,200}$/.test(page)) {
    throw new HttpError(400, "Invalid page reference.");
  }

  const anchor = String(payload.anchor || "").trim();
  if (anchor && !/^#[\w\-.:]{1,100}$/.test(anchor)) {
    throw new HttpError(400, "Invalid section anchor.");
  }

  const text = String(payload.text || "").trim();
  if (text.length < 3) {
    throw new HttpError(400, "The comment is too short.");
  }
  if (text.length > MAX_TEXT) {
    throw new HttpError(400, `The comment is longer than ${MAX_TEXT} characters.`);
  }

  return {
    page,
    anchor,
    pageTitle: plain(payload.pageTitle, 120) || page,
    section: plain(payload.section, 120),
    kind: plain(payload.kind, 40),
    text
  };
}

function excerpt(text, length) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > length ? oneLine.slice(0, length - 1).trimEnd() + "…" : oneLine;
}

/** Build the { title, body } of the issue representing one comment. */
function buildIssue(comment, author, options) {
  const site = String((options && options.siteUrl) || "").replace(/\/+$/, "");
  const where = comment.pageTitle + (comment.section ? " · " + comment.section : "");
  const link = site + comment.page + comment.anchor;

  const marker = JSON.stringify({
    v: 1,
    page: comment.page,
    anchor: comment.anchor,
    section: comment.section,
    kind: comment.kind,
    author
  });

  const quoted = comment.text
    .split(/\r?\n/)
    .map((line) => "> " + neutralise(line))
    .join("\n");

  const title = excerpt(`[Docs] ${where} — ${comment.text}`, MAX_TITLE);

  const body = [
    `<!-- vt-docs ${marker} -->`,
    `**@${author}** commented on [${where}](${link || comment.page + comment.anchor})`,
    "",
    "<sub>Close this issue to mark the comment as handled — “Close as completed” shows as " +
      "**Resolved** on the page, “Close as not planned” as **Won't do**.</sub>",
    "",
    TEXT_MARKER,
    quoted,
    ""
  ].join("\n");

  return { title, body };
}

/**
 * Turn a GitHub issue back into a comment, or null when the issue was not
 * created by this widget.
 */
function parseIssue(issue) {
  if (!issue || issue.pull_request) return null;

  const match = MARKER_RE.exec(issue.body || "");
  if (!match) return null;

  let marker;
  try {
    marker = JSON.parse(match[1]);
  } catch (error) {
    return null;
  }
  if (!marker || !marker.page) return null;

  const index = issue.body.indexOf(TEXT_MARKER);
  const raw = index === -1 ? "" : issue.body.slice(index + TEXT_MARKER.length);
  const text = denormalise(
    raw
      .split(/\r?\n/)
      .map((line) => line.replace(/^>\s?/, ""))
      .join("\n")
      .trim()
  );

  return {
    number: issue.number,
    url: issue.html_url,
    state: issue.state,
    stateReason: issue.state_reason || null,
    page: marker.page,
    anchor: marker.anchor || "",
    section: marker.section || "",
    kind: marker.kind || "",
    /* The author comes from the marker we wrote, not from the issue creator,
       which is always the GitHub App. */
    author: marker.author || "unknown",
    text,
    replies: issue.comments || 0,
    createdAt: issue.created_at
  };
}

module.exports = {
  HttpError,
  MAX_TEXT,
  buildIssue,
  parseIssue,
  validate,
  /* exported for the smoke test */
  neutralise,
  denormalise
};

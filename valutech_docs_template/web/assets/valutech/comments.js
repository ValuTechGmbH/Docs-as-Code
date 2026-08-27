/*
 * Page comments widget for the ValuTech docs-as-code template.
 *
 * Renders the comments for the current page and a form to add one. Both talk to
 * the Static Web Apps managed function under `data-api`, which maps every
 * comment to a GitHub issue. Identity comes from the Static Web Apps session
 * (`/.auth/me`); the function re-reads it from the edge-injected header, so the
 * author shown on the issue cannot be forged here.
 *
 * All user-supplied text is written via textContent — never innerHTML.
 */

(function () {
  "use strict";

  var STATES = {
    open: { label: "Open", modifier: "open" },
    completed: { label: "Resolved", modifier: "resolved" },
    not_planned: { label: "Won't do", modifier: "declined" },
    closed: { label: "Closed", modifier: "declined" }
  };

  var MAX_LENGTH = 4000;

  /* -- helpers ----------------------------------------------------------- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function stateOf(comment) {
    if (comment.state === "open") return STATES.open;
    return STATES[comment.stateReason] || STATES.closed;
  }

  function formatDate(value) {
    var date = new Date(value);
    if (isNaN(date.getTime())) return "";
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  }

  /* Headings of the current page, so a comment can point at a section. */
  function sections(root) {
    var scope = root.closest(".md-content__inner") || document;
    var found = [];
    scope.querySelectorAll("h2[id], h3[id]").forEach(function (heading) {
      var clone = heading.cloneNode(true);
      clone.querySelectorAll(".headerlink").forEach(function (link) {
        link.remove();
      });
      var title = clone.textContent.trim();
      if (title) {
        found.push({
          anchor: "#" + heading.id,
          title: title,
          nested: heading.tagName === "H3"
        });
      }
    });
    return found;
  }

  function signedInAs(principal) {
    if (!principal) return null;
    if (principal.identityProvider !== "github") return null;
    return principal.userDetails;
  }

  async function currentPrincipal() {
    try {
      var response = await fetch("/.auth/me", { headers: { accept: "application/json" } });
      if (!response.ok) return null;
      var payload = await response.json();
      return payload.clientPrincipal || null;
    } catch (error) {
      return null;
    }
  }

  /* -- rendering --------------------------------------------------------- */

  function renderComment(comment) {
    var state = stateOf(comment);
    var article = el("article", "vt-comment");
    article.setAttribute("data-state", comment.state);

    var meta = el("div", "vt-comment__meta");
    meta.appendChild(el("span", "vt-comment__state vt-comment__state--" + state.modifier, state.label));
    meta.appendChild(el("span", "vt-comment__author", "@" + comment.author));
    if (comment.kind) meta.appendChild(el("span", "vt-comment__kind", comment.kind));
    if (comment.section) meta.appendChild(el("span", "vt-comment__section", "§ " + comment.section));
    meta.appendChild(el("span", "vt-comment__date", formatDate(comment.createdAt)));
    article.appendChild(meta);

    article.appendChild(el("p", "vt-comment__text", comment.text));

    var footer = el("div", "vt-comment__footer");
    var link = el("a", null, "Issue #" + comment.number);
    link.href = comment.url;
    link.target = "_blank";
    link.rel = "noopener";
    footer.appendChild(link);
    if (comment.replies) {
      footer.appendChild(document.createTextNode(
        " · " + comment.replies + (comment.replies === 1 ? " reply" : " replies")
      ));
    }
    if (comment.anchor) {
      footer.appendChild(document.createTextNode(" · "));
      var jump = el("a", null, "jump to section");
      jump.href = comment.anchor;
      footer.appendChild(jump);
    }
    article.appendChild(footer);

    return article;
  }

  function renderList(container, comments) {
    container.textContent = "";
    if (!comments.length) {
      container.appendChild(el("p", "vt-comments__empty", "No comments on this page yet."));
      return;
    }
    comments.forEach(function (comment) {
      container.appendChild(renderComment(comment));
    });
  }

  function select(labelText, options) {
    var field = el("div", "vt-comments__field");
    field.appendChild(el("span", "vt-comments__label", labelText));
    var input = el("select");
    options.forEach(function (option) {
      var node = el("option", null, option.label);
      node.value = option.value;
      input.appendChild(node);
    });
    field.appendChild(input);
    return { field: field, input: input };
  }

  function renderForm(root, page, api, onCreated) {
    var kinds = (root.dataset.kinds || "").split("|").filter(Boolean);
    var form = el("form", "vt-comments__form");

    var sectionOptions = [{ value: "", label: "Whole page" }];
    sections(root).forEach(function (section) {
      sectionOptions.push({
        value: section.anchor + "|" + section.title,
        /* Non-breaking spaces: a browser collapses ordinary leading whitespace
           inside an <option>. */
        label: (section.nested ? "\u00a0\u00a0" : "") + section.title
      });
    });

    var row = el("div", "vt-comments__row");
    var sectionSelect = select("Section", sectionOptions);
    row.appendChild(sectionSelect.field);

    var kindSelect = null;
    if (kinds.length) {
      kindSelect = select("Kind", kinds.map(function (kind) {
        return { value: kind, label: kind };
      }));
      row.appendChild(kindSelect.field);
    }
    form.appendChild(row);

    var field = el("div", "vt-comments__field");
    field.appendChild(el("span", "vt-comments__label", "Comment"));
    var textarea = el("textarea");
    textarea.maxLength = MAX_LENGTH;
    textarea.required = true;
    textarea.placeholder = "What is wrong, unclear or missing on this page?";
    field.appendChild(textarea);
    form.appendChild(field);

    var actions = el("div", "vt-comments__actions");
    var submit = el("button", "vt-comments__submit", "Post comment");
    submit.type = "submit";
    actions.appendChild(submit);
    var note = el("span", "vt-comments__note");
    actions.appendChild(note);
    form.appendChild(actions);

    var status = el("p", "vt-comments__status");
    form.appendChild(status);

    /* The section anchor is preselected when the reader followed a deep link. */
    if (window.location.hash) {
      for (var i = 0; i < sectionSelect.input.options.length; i++) {
        if (sectionSelect.input.options[i].value.indexOf(window.location.hash + "|") === 0) {
          sectionSelect.input.selectedIndex = i;
          break;
        }
      }
    }

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      var text = textarea.value.trim();
      if (text.length < 3) {
        status.className = "vt-comments__status vt-comments__status--error";
        status.textContent = "Please write a little more.";
        return;
      }

      var parts = sectionSelect.input.value.split("|");
      submit.disabled = true;
      status.className = "vt-comments__status";
      status.textContent = "Posting…";

      try {
        var response = await fetch(api, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            page: page,
            pageTitle: root.dataset.pageTitle || document.title,
            anchor: parts[0] || "",
            section: parts[1] || "",
            kind: kindSelect ? kindSelect.input.value : "",
            text: text
          })
        });
        var payload = await response.json().catch(function () {
          return {};
        });
        if (!response.ok) throw new Error(payload.error || "Request failed (" + response.status + ")");

        textarea.value = "";
        status.className = "vt-comments__status vt-comments__status--ok";
        status.textContent = "Thanks — issue #" + payload.number + " opened.";
        onCreated(payload);
      } catch (error) {
        status.className = "vt-comments__status vt-comments__status--error";
        status.textContent = "Could not post the comment: " + error.message;
      } finally {
        submit.disabled = false;
      }
    });

    return { form: form, note: note };
  }

  function renderSignIn(container) {
    var target = window.location.pathname + window.location.search + window.location.hash;
    var paragraph = el("p", "vt-comments__note");
    var link = el("a", null, "Sign in with GitHub");
    link.href = "/.auth/login/github?post_login_redirect_uri=" + encodeURIComponent(target);
    paragraph.appendChild(link);
    paragraph.appendChild(document.createTextNode(" to add a comment."));
    container.appendChild(paragraph);
  }

  /* -- mount ------------------------------------------------------------- */

  async function mount(root) {
    if (root.dataset.vtMounted) return;
    root.dataset.vtMounted = "1";

    var api = root.dataset.api || "/api/comments";
    var page = root.dataset.page || window.location.pathname;

    /* Fail quiet: with no API reachable (plain `mkdocs serve`, or a build
       deployed without the function) the widget removes itself rather than
       showing an error to every reader. */
    var comments;
    try {
      var response = await fetch(api + "?page=" + encodeURIComponent(page), {
        headers: { accept: "application/json" }
      });
      if (!response.ok) throw new Error("comments API returned " + response.status);
      comments = (await response.json()).comments || [];
    } catch (error) {
      console.warn("[vt-comments] disabled:", error.message);
      root.hidden = true;
      return;
    }

    root.appendChild(el("h2", "vt-comments__title", root.dataset.title || "Comments"));
    if (root.dataset.intro) root.appendChild(el("p", "vt-comments__intro", root.dataset.intro));

    var list = el("div", "vt-comments__list");
    root.appendChild(list);
    renderList(list, comments);

    var principal = await currentPrincipal();
    var handle = signedInAs(principal);
    if (!handle) {
      renderSignIn(root);
      return;
    }

    var rendered = renderForm(root, page, api, function (comment) {
      comments.unshift(comment);
      renderList(list, comments);
    });
    rendered.note.textContent = "Commenting as @" + handle;
    root.appendChild(rendered.form);
  }

  function init() {
    document.querySelectorAll("[data-vt-comments]").forEach(mount);
  }

  /* Material's instant loading swaps the DOM without a page load; document$ is
     the documented hook for re-initialising third-party widgets. */
  if (window.document$ && typeof window.document$.subscribe === "function") {
    window.document$.subscribe(init);
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

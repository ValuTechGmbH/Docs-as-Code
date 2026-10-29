/*
 * Risk register editor for the ValuTech docs-as-code template.
 *
 * Signed-in users with write access to the repository edit risks in a side
 * drawer. Edits stay pending in this browser (localStorage), marked on the
 * page, until "Commit" sends them to /api/risks/commit as one commit. The page
 * itself is static, so after a commit the risk shows as "deploying" until the
 * rebuilt site carries the committed version.
 *
 * Data comes from the build (risks-source.json: each file's form and git blob
 * id, plus the schema) and from /api/risks/state (blob ids on the branch now).
 * Forms are checked with riskfile.js, the same code the API validates with.
 */

(function () {
  "use strict";

  var STORE = "vt-risk-edits:";
  var FIELDS = ["title", "category", "status", "owner", "probability", "impact", "residual", "reviewed",
    "mitigations", "issues", "body"];

  // -- helpers -----------------------------------------------------------------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function button(text, className, onClick) {
    var node = el("button", "md-button " + (className || ""), text);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function titleCase(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  /* A rating as its 1-based position, whether written as a label or a number. */
  function position(value, labels) {
    if (typeof value === "number") return value;
    var text = String(value || "").toLowerCase();
    for (var n = 0; n < labels.length; n++) if (labels[n].toLowerCase() === text) return n + 1;
    return 0;
  }

  /* Comparable value of one field; equal ratings in different spellings compare equal. */
  function canonical(form, field, schema) {
    var value = form[field];
    if (field === "probability" || field === "impact") return position(value, schema[field]);
    if (field === "residual") {
      return value ? [position(value.probability, schema.probability), position(value.impact, schema.impact)] : null;
    }
    if (field === "owner" || field === "reviewed") return value || null;
    if (field === "body") return String(value || "").trim();
    if (field === "mitigations") {
      return (value || []).map(function (m) {
        return [String(m.text || "").trim(), m.status, m.issues || [], m.extra || {}];
      });
    }
    return value === undefined ? null : value;
  }

  function changedFields(original, form, schema) {
    if (!original) return FIELDS.slice();
    return FIELDS.filter(function (field) {
      return JSON.stringify(canonical(original, field, schema)) !== JSON.stringify(canonical(form, field, schema));
    });
  }

  function display(form, field, schema) {
    var value = form[field];
    if (field === "probability" || field === "impact") return titleCase(schema[field][position(value, schema[field]) - 1] || "");
    if (field === "residual") {
      return value ? titleCase(String(value.probability)) + " × " + titleCase(String(value.impact)) : "not assessed";
    }
    if (field === "mitigations") {
      return (value || []).map(function (m) { return "[" + m.status + "] " + m.text; }).join("\n") || "none";
    }
    if (field === "issues") return (value || []).join(", ") || "none";
    if (field === "category") return (schema.categories[value] || {}).title || value;
    if (field === "status") return titleCase(String(value || ""));
    if (field === "body") return String(value || "").trim() || "empty";
    return value === null || value === undefined || value === "" ? "—" : String(value);
  }

  function level(form, schema) {
    var score = position(form.probability, schema.probability) * position(form.impact, schema.impact);
    if (!score) return null;
    for (var n = 0; n < schema.levels.length; n++) {
      var lv = schema.levels[n];
      if (lv.max === null || score <= lv.max) return lv;
    }
    return schema.levels[schema.levels.length - 1];
  }

  async function getJson(url) {
    var response = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(url + ": " + response.status);
    return response.json();
  }

  // -- editor ------------------------------------------------------------------

  function Editor(root, api, source, me, state) {
    this.root = root;
    this.api = api;
    this.schema = source.schema;
    this.login = me.login;
    this.key = STORE + new URL(root.dataset.editorSource, window.location.href).pathname;

    this.files = {};     // path -> { path, sha (build), form, problem, live (branch sha) }
    this.byId = {};      // risk id (lower case) -> path
    var self = this;
    source.files.forEach(function (file) {
      file.live = state.files[file.path] || null;
      self.files[file.path] = file;
      if (file.form && file.form.id) self.byId[String(file.form.id).toLowerCase()] = file.path;
    });

    this.edits = this.load();
    this.reconcile();
  }

  Editor.prototype.load = function () {
    try {
      var data = JSON.parse(window.localStorage.getItem(this.key) || "{}");
      return data && typeof data === "object" ? data : {};
    } catch (error) {
      return {};
    }
  };

  Editor.prototype.save = function () {
    try {
      window.localStorage.setItem(this.key, JSON.stringify(this.edits));
    } catch (error) {
      /* Private mode or full storage: edits live until the page closes. */
    }
  };

  /* Drop edits the deployed site already carries; flag edits whose base moved. */
  Editor.prototype.reconcile = function () {
    var self = this;
    Object.keys(this.edits).forEach(function (key) {
      var edit = self.edits[key];
      var file = edit.committed ? self.files[edit.committed.path] : self.files[edit.path];
      if (edit.committed) {
        if (file && file.sha === edit.committed.sha) delete self.edits[key];
        return;
      }
      if (edit.path) {
        if (!file) edit.conflict = "deleted";
        else if (file.sha !== edit.baseSha || (file.live && file.live !== edit.baseSha)) edit.conflict = "changed";
        else delete edit.conflict;
      }
    });
    this.save();
  };

  Editor.prototype.pending = function () {
    var self = this;
    return Object.keys(this.edits)
      .map(function (key) { return self.edits[key]; })
      .filter(function (edit) { return !edit.committed; });
  };

  /* Changed on the branch since this page was built, and not by an edit we track. */
  Editor.prototype.deploying = function (path) {
    var file = this.files[path];
    return Boolean(file && file.live && file.live !== file.sha);
  };

  // -- page marks --

  Editor.prototype.mark = function () {
    var self = this;
    var page = this.root.closest(".md-content__inner") || document;
    page.querySelectorAll("[data-vt-edit-badge]").forEach(function (node) { node.remove(); });
    page.querySelectorAll(".vt-risk--pending, .vt-risk--committed, .vt-risk--conflict, .vt-risk--deploying")
      .forEach(function (node) {
        node.classList.remove("vt-risk--pending", "vt-risk--committed", "vt-risk--conflict", "vt-risk--deploying");
      });

    page.querySelectorAll("[data-risk]").forEach(function (node) {
      var path = self.byId[String(node.dataset.risk).toLowerCase()];
      if (!path) return;
      var edit = self.edits[path];
      var kind = null;
      if (edit && edit.committed) kind = "committed";
      else if (edit && edit.conflict) kind = "conflict";
      else if (edit) kind = "pending";
      else if (self.deploying(path)) kind = "deploying";
      if (kind) node.classList.add("vt-risk--" + kind);

      var isHeading = node.classList.contains("vt-risk-heading");
      var isRow = node.tagName === "TR";
      if (!kind && !isHeading) return;

      var host = isRow ? node.cells[0] : node;
      if (kind && (isHeading || isRow)) {
        var labels = { pending: "pending", committed: "committed", conflict: "conflict", deploying: "deploying" };
        var badge = el("span", "vt-risk-edit-badge vt-risk-edit-badge--" + kind, labels[kind]);
        badge.dataset.vtEditBadge = "";
        if (kind === "committed") badge.title = "Committed; the site shows it after the next deploy";
        if (kind === "deploying") badge.title = "Changed on the branch since this page was built";
        if (kind === "conflict") badge.title = "The risk changed on the branch since you edited it";
        host.appendChild(badge);
      }
      if (isHeading) {
        var edit_ = button("Edit", "vt-risk-edit-button", function () { self.open(path); });
        edit_.dataset.vtEditBadge = "";
        edit_.disabled = kind === "committed" || kind === "deploying";
        if (edit_.disabled) edit_.title = "Wait for the deploy before editing again";
        node.appendChild(edit_);
      }
    });

    this.renderBar();
  };

  // -- drawer --

  Editor.prototype.open = function (path, newKey) {
    var self = this;
    var schema = this.schema;
    var file = path ? this.files[path] : null;
    var key = path || newKey || "new:" + Date.now().toString(36);
    var edit = this.edits[key];
    var original = file ? file.form : null;
    var draft = clone(edit ? edit.form : original || {
      id: "NEW", title: "", category: Object.keys(schema.categories).filter(function (k) {
        return schema.categories[k].id_prefix;
      })[0] || "", status: "open", owner: null, probability: schema.probability[0], impact: schema.impact[0],
      residual: null, reviewed: today(), mitigations: [], issues: [], extra: {}, body: ""
    });
    draft.mitigations = draft.mitigations || [];
    draft.issues = draft.issues || [];

    this.close();
    var drawer = el("aside", "vt-risk-drawer");
    drawer.setAttribute("aria-label", "Edit risk");
    this.drawer = drawer;

    var head = el("div", "vt-risk-drawer__head");
    head.appendChild(el("h2", null, file ? "Edit " + draft.id : "New risk"));
    head.appendChild(button("✕", "vt-risk-drawer__close", function () { self.close(); }));
    drawer.appendChild(head);

    if (file && file.problem) {
      drawer.appendChild(el("p", "vt-risk-drawer__problem", "The build skipped this file: " + file.problem));
    }
    if (edit && edit.conflict) {
      var note = el("div", "vt-risk-drawer__problem");
      note.appendChild(el("p", null, edit.conflict === "deleted"
        ? "This risk was deleted on the branch."
        : "This risk changed on the branch since you edited it. Discard your edit, or keep it on top of the current version once the site shows it."));
      if (edit.conflict === "changed" && file && !this.deploying(path)) {
        note.appendChild(button("Keep my edit on the current version", "", function () {
          edit.baseSha = file.sha;
          edit.original = file.form;
          delete edit.conflict;
          self.save();
          self.mark();
          self.open(path);
        }));
      }
      drawer.appendChild(note);
    }

    var form = el("form", "vt-risk-form");
    form.addEventListener("submit", function (event) { event.preventDefault(); });
    drawer.appendChild(form);

    var marked = []; // [wrapper, field] pairs highlighted while they differ from the build

    function field(label, input, changedKey) {
      var wrap = el("label", "vt-risk-form__field");
      if (changedKey) marked.push([wrap, changedKey]);
      wrap.appendChild(el("span", "vt-risk-form__label", label));
      wrap.appendChild(input);
      form.appendChild(wrap);
      return wrap;
    }

    function text(value, onInput, multiline) {
      var input = el(multiline ? "textarea" : "input");
      if (!multiline) input.type = "text";
      input.value = value === null || value === undefined ? "" : value;
      input.addEventListener("input", function () { onInput(input.value); refresh(); });
      return input;
    }

    function select(options, value, onChange) {
      var input = el("select");
      options.forEach(function (o) { input.appendChild(new Option(o[1], o[0])); });
      input.value = value;
      input.addEventListener("change", function () { onChange(input.value); refresh(); });
      return input;
    }

    function ratingSelect(axis, value, onChange) {
      var labels = schema[axis];
      return select(labels.map(function (l) { return [l, titleCase(l)]; }), labels[position(value, labels) - 1] || labels[0], onChange);
    }

    /* Keep the file's spelling (e.g. a number) when the rating did not change. */
    function rated(axis, label, previous) {
      return position(previous, schema[axis]) === position(label, schema[axis]) ? previous : label;
    }

    field("Title", text(draft.title, function (v) { draft.title = v; }), "title");

    var categories = Object.keys(schema.categories);
    field("Category", categories.length
      ? select(categories.filter(function (k) { return file || schema.categories[k].id_prefix; }).map(function (k) {
        return [k, schema.categories[k].title];
      }), draft.category, function (v) { draft.category = v; })
      : text(draft.category, function (v) { draft.category = v; }), "category");

    field("Status", select(schema.statuses.map(function (s) { return [s, titleCase(s)]; }), String(draft.status).toLowerCase(),
      function (v) { draft.status = v; }), "status");
    field("Owner", text(draft.owner, function (v) { draft.owner = v.trim() ? v : null; }), "owner");

    var rating = el("div", "vt-risk-form__row");
    var levelBadge = el("span", "vt-risk-level");
    rating.appendChild(field("Probability", ratingSelect("probability", draft.probability, function (v) {
      draft.probability = rated("probability", v, original ? original.probability : v);
    }), "probability"));
    rating.appendChild(field("Impact", ratingSelect("impact", draft.impact, function (v) {
      draft.impact = rated("impact", v, original ? original.impact : v);
    }), "impact"));
    rating.appendChild(levelBadge);
    form.appendChild(rating);

    var residualRow = el("div", "vt-risk-form__row");
    var assessed = el("input");
    assessed.type = "checkbox";
    assessed.checked = Boolean(draft.residual);
    var residualFields = el("div", "vt-risk-form__row");
    function residualSelects() {
      residualFields.textContent = "";
      if (!draft.residual) return;
      var before = original && original.residual ? original.residual : {};
      residualFields.appendChild(field("Residual probability", ratingSelect("probability", draft.residual.probability, function (v) {
        draft.residual.probability = rated("probability", v, before.probability);
      })));
      residualFields.appendChild(field("Residual impact", ratingSelect("impact", draft.residual.impact, function (v) {
        draft.residual.impact = rated("impact", v, before.impact);
      })));
    }
    assessed.addEventListener("change", function () {
      draft.residual = assessed.checked
        ? clone(original && original.residual ? original.residual : { probability: schema.probability[0], impact: schema.impact[0] })
        : null;
      residualSelects();
      refresh();
    });
    residualRow.appendChild(field("Residual assessed", assessed, "residual"));
    residualRow.appendChild(residualFields);
    form.appendChild(residualRow);
    residualSelects();

    var reviewed = el("input");
    reviewed.type = "date";
    reviewed.value = draft.reviewed || "";
    reviewed.addEventListener("input", function () { draft.reviewed = reviewed.value || null; refresh(); });
    var reviewedWrap = field("Reviewed", reviewed, "reviewed");
    reviewedWrap.appendChild(button("Today", "vt-risk-form__small", function () {
      reviewed.value = draft.reviewed = today();
      refresh();
    }));

    var mitigationBox = el("fieldset", "vt-risk-form__mitigations");
    form.appendChild(mitigationBox);
    function renderMitigations() {
      mitigationBox.textContent = "";
      mitigationBox.appendChild(el("legend", null, "Mitigations"));
      draft.mitigations.forEach(function (m, n) {
        var row = el("div", "vt-risk-form__mitigation");
        var t = text(m.text, function (v) { m.text = v; }, true);
        t.rows = 2;
        row.appendChild(t);
        var controls = el("div", "vt-risk-form__row");
        controls.appendChild(select(schema.mitigation_statuses.map(function (s) { return [s, titleCase(s)]; }), m.status,
          function (v) { m.status = v; }));
        var refs = text((m.issues || []).join(", "), function (v) {
          m.issues = v.split(/[\s,]+/).filter(Boolean);
        });
        refs.placeholder = "Issues: owner/repo#12, #3";
        controls.appendChild(refs);
        controls.appendChild(button("↑", "vt-risk-form__small", function () {
          if (n === 0) return;
          draft.mitigations.splice(n - 1, 0, draft.mitigations.splice(n, 1)[0]);
          renderMitigations();
          refresh();
        }));
        controls.appendChild(button("Remove", "vt-risk-form__small", function () {
          draft.mitigations.splice(n, 1);
          renderMitigations();
          refresh();
        }));
        row.appendChild(controls);
        mitigationBox.appendChild(row);
      });
      mitigationBox.appendChild(button("Add mitigation", "vt-risk-form__small", function () {
        draft.mitigations.push({ text: "", status: schema.mitigation_statuses[0], issues: [], extra: {} });
        renderMitigations();
        refresh();
      }));
    }
    renderMitigations();
    marked.push([mitigationBox, "mitigations"]);

    var issues = text(draft.issues.join(", "), function (v) { draft.issues = v.split(/[\s,]+/).filter(Boolean); });
    issues.placeholder = "owner/repo#12, #3";
    field("Linked issues", issues, "issues");

    var body = text(draft.body, function (v) { draft.body = v; }, true);
    body.className = "vt-risk-form__markdown";
    body.rows = 10;
    field("Description (Markdown)", body, "body");

    var errors = el("ul", "vt-risk-drawer__errors");
    drawer.appendChild(errors);

    var actions = el("div", "vt-risk-drawer__actions");
    actions.appendChild(button("Keep as pending", "md-button--primary", function () {
      var result = window.VtRiskFile.validateRisk(draft, schema);
      errors.textContent = "";
      if (result.errors.length) {
        result.errors.forEach(function (e) { errors.appendChild(el("li", null, e)); });
        return;
      }
      if (original && !changedFields(original, draft, schema).length) {
        delete self.edits[key];
      } else {
        self.edits[key] = {
          path: path || null,
          baseSha: file ? (edit && edit.baseSha) || file.sha : null,
          original: file ? (edit && edit.original) || original : null,
          form: draft,
          conflict: edit && edit.conflict
        };
        if (!self.edits[key].conflict) delete self.edits[key].conflict;
      }
      self.save();
      self.close();
      self.mark();
    }));
    if (edit) {
      actions.appendChild(button(file ? "Discard my edit" : "Discard new risk", "", function () {
        delete self.edits[key];
        self.save();
        self.close();
        self.mark();
      }));
    }
    actions.appendChild(button("Cancel", "", function () { self.close(); }));
    drawer.appendChild(actions);

    function refresh() {
      var lv = level(draft, schema);
      levelBadge.textContent = lv ? lv.name : "";
      levelBadge.style.background = lv ? lv.color : "";
      levelBadge.style.color = lv ? "#fff" : "";
      if (!original) return;
      var changed = changedFields(original, draft, schema);
      marked.forEach(function (pair) {
        pair[0].classList.toggle("vt-risk-form__field--changed", changed.indexOf(pair[1]) !== -1);
      });
    }
    refresh();

    document.body.appendChild(drawer);
    var first = drawer.querySelector("input, select, textarea");
    if (first) first.focus();
    this.onKey = function (event) { if (event.key === "Escape") self.close(); };
    document.addEventListener("keydown", this.onKey);
  };

  Editor.prototype.close = function () {
    if (this.drawer) this.drawer.remove();
    this.drawer = null;
    if (this.onKey) document.removeEventListener("keydown", this.onKey);
  };

  // -- commit bar --

  Editor.prototype.renderBar = function () {
    var self = this;
    var pending = this.pending();
    var committed = Object.keys(this.edits).filter(function (k) { return self.edits[k].committed; }).length;
    if (!this.bar) {
      this.bar = el("div", "vt-risk-bar");
      document.body.appendChild(this.bar);
    }
    var bar = this.bar;
    bar.textContent = "";
    bar.hidden = !pending.length && !committed && !this.problemFiles().length;
    document.body.classList.toggle("vt-risk-bar-open", !bar.hidden);

    var summary = el("span", "vt-risk-bar__summary");
    if (pending.length) {
      summary.textContent = pending.length + " pending change" + (pending.length === 1 ? "" : "s");
    } else if (committed) {
      summary.textContent = committed + " committed, waiting for the deploy";
    } else {
      summary.textContent = "Some risk files have problems";
    }
    bar.appendChild(summary);

    bar.appendChild(button("Review", "", function () { self.review(); }));
    if (pending.length) {
      bar.appendChild(button("Discard all", "", function () {
        if (!window.confirm("Discard all pending risk edits?")) return;
        pending.forEach(function (edit) {
          var key = edit.path || Object.keys(self.edits).filter(function (k) { return self.edits[k] === edit; })[0];
          delete self.edits[key];
        });
        self.save();
        self.mark();
      }));
      var commit = button("Commit…", "md-button--primary", function () { self.review(true); });
      commit.disabled = pending.some(function (edit) { return edit.conflict; });
      if (commit.disabled) commit.title = "Resolve the conflicts first";
      bar.appendChild(commit);
    }
  };

  Editor.prototype.problemFiles = function () {
    var self = this;
    return Object.keys(this.files).filter(function (p) { return self.files[p].problem; });
  };

  Editor.prototype.review = function (committing) {
    var self = this;
    var schema = this.schema;
    this.close();
    var drawer = el("aside", "vt-risk-drawer");
    drawer.setAttribute("aria-label", "Review risk changes");
    this.drawer = drawer;
    var head = el("div", "vt-risk-drawer__head");
    head.appendChild(el("h2", null, committing ? "Commit risk changes" : "Review risk changes"));
    head.appendChild(button("✕", "vt-risk-drawer__close", function () { self.close(); }));
    drawer.appendChild(head);

    Object.keys(this.edits).forEach(function (key) {
      var edit = self.edits[key];
      var section = el("section", "vt-risk-review");
      var title = edit.committed
        ? edit.committed.id + " — committed"
        : (edit.path ? edit.form.id : "New risk") + " — " + (edit.form.title || "untitled");
      var h = el("h3", null, title);
      if (edit.conflict) h.appendChild(el("span", "vt-risk-edit-badge vt-risk-edit-badge--conflict", "conflict"));
      section.appendChild(h);
      if (edit.committed) {
        var link = el("a", null, "View commit");
        link.href = edit.committed.url;
        link.target = "_blank";
        link.rel = "noopener";
        section.appendChild(link);
        section.appendChild(button("Forget", "vt-risk-form__small", function () {
          delete self.edits[key];
          self.save();
          self.mark();
          self.review(committing);
        }));
      } else {
        var table = el("table", "vt-risk-review__diff");
        changedFields(edit.original, edit.form, schema).forEach(function (f) {
          var row = el("tr");
          row.appendChild(el("th", null, titleCase(f)));
          if (edit.original) row.appendChild(el("td", "vt-risk-review__old", display(edit.original, f, schema)));
          row.appendChild(el("td", "vt-risk-review__new", display(edit.form, f, schema)));
          table.appendChild(row);
        });
        section.appendChild(table);
        section.appendChild(button("Edit", "vt-risk-form__small", function () { self.open(edit.path, edit.path ? null : key); }));
      }
      drawer.appendChild(section);
    });

    var problems = this.problemFiles();
    if (problems.length) {
      var box = el("section", "vt-risk-review");
      box.appendChild(el("h3", null, "Files the build skipped"));
      problems.forEach(function (p) {
        var line = el("p", null, p + ": " + self.files[p].problem + " ");
        if (self.files[p].form && !self.edits[p]) line.appendChild(button("Fix", "vt-risk-form__small", function () { self.open(p); }));
        box.appendChild(line);
      });
      drawer.appendChild(box);
    }

    var pending = this.pending();
    if (committing && pending.length) {
      var message = el("textarea", "vt-risk-commit__message");
      message.rows = 3;
      message.value = defaultMessage(pending);
      var wrap = el("label", "vt-risk-form__field");
      wrap.appendChild(el("span", "vt-risk-form__label", "Commit message"));
      wrap.appendChild(message);
      drawer.appendChild(wrap);
      drawer.appendChild(el("p", "vt-risk-commit__note",
        "Commits to the repository as the docs App, with you (@" + self.login + ") as co-author. The site updates after the next deploy."));
      var status = el("p", "vt-risk-commit__status");
      var errors = el("ul", "vt-risk-drawer__errors");
      var go = button("Commit " + pending.length + " change" + (pending.length === 1 ? "" : "s"), "md-button--primary", async function () {
        go.disabled = true;
        status.textContent = "Committing…";
        errors.textContent = "";
        try {
          var result = await self.commit(message.value);
          status.textContent = "";
          if (result.ok) {
            self.close();
            self.mark();
            return;
          }
          status.textContent = result.error;
          (result.problems || []).forEach(function (p) { errors.appendChild(el("li", null, p)); });
          self.mark();
        } catch (error) {
          status.textContent = "Could not reach the server. Your edits are still pending.";
        }
        go.disabled = false;
      });
      var actions = el("div", "vt-risk-drawer__actions");
      actions.appendChild(go);
      actions.appendChild(button("Cancel", "", function () { self.close(); }));
      drawer.appendChild(status);
      drawer.appendChild(errors);
      drawer.appendChild(actions);
    } else if (pending.length) {
      var more = el("div", "vt-risk-drawer__actions");
      more.appendChild(button("Commit…", "md-button--primary", function () { self.review(true); }));
      drawer.appendChild(more);
    }

    document.body.appendChild(drawer);
    this.onKey = function (event) { if (event.key === "Escape") self.close(); };
    document.addEventListener("keydown", this.onKey);
  };

  function defaultMessage(pending) {
    var edited = pending.filter(function (e) { return e.path; }).map(function (e) { return e.form.id; });
    var added = pending.filter(function (e) { return !e.path; }).length;
    var parts = [];
    if (edited.length) parts.push("update " + edited.join(", "));
    if (added) parts.push("add " + added + " risk" + (added === 1 ? "" : "s"));
    return "Risks: " + parts.join("; ");
  }

  Editor.prototype.commit = async function (message) {
    var self = this;
    var keys = Object.keys(this.edits).filter(function (k) { return !self.edits[k].committed; });
    // The API writes edits first, then new risks in request order.
    keys.sort(function (a, b) { return (self.edits[a].path ? 0 : 1) - (self.edits[b].path ? 0 : 1); });
    var changes = keys.map(function (k) {
      var edit = self.edits[k];
      return edit.path ? { path: edit.path, baseSha: edit.baseSha, form: edit.form } : { form: edit.form };
    });

    var response = await fetch(this.api + "/commit", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ message: message, changes: changes })
    });
    var payload = await response.json().catch(function () { return {}; });

    if (response.status === 201) {
      var newKeys = keys.filter(function (k) { return !self.edits[k].path; });
      payload.files.forEach(function (f) {
        var key = f.new ? newKeys.shift() : f.path;
        self.edits[key] = { committed: { path: f.path, id: f.id, sha: f.sha, commit: payload.commit, url: payload.url } };
        if (self.files[f.path]) self.files[f.path].live = f.sha;
      });
      this.save();
      return { ok: true };
    }
    if (response.status === 409) {
      (payload.conflicts || []).forEach(function (c) {
        if (self.edits[c.path]) self.edits[c.path].conflict = c.reason === "id" ? "changed" : c.reason;
      });
      this.save();
    }
    if (response.status === 401) payload.error = "Your session expired. Reload the page to sign in again.";
    return { ok: false, error: payload.error || "Commit failed (" + response.status + ").", problems: payload.problems };
  };

  // -- start -------------------------------------------------------------------

  var current = null;

  async function init(root) {
    if (root.dataset.vtEditorReady) return;
    root.dataset.vtEditorReady = "1";
    var api = root.dataset.editorApi;
    try {
      var me = await getJson(api + "/me");
      if (!me.canEdit) return;
      var loaded = await Promise.all([
        getJson(new URL(root.dataset.editorSource, window.location.href).href),
        getJson(api + "/state")
      ]);
      var editor = new Editor(root, api, loaded[0], me, loaded[1]);
      current = editor;

      var toolbar = el("div", "vt-risk-edit-toolbar");
      toolbar.appendChild(button("New risk", "", function () { editor.open(null); }));
      toolbar.appendChild(el("span", "vt-risk-edit-toolbar__who", "Editing as @" + me.login));
      root.insertBefore(toolbar, root.firstChild);
      editor.mark();
    } catch (error) {
      if (window.console) console.warn("Risk editor unavailable:", error);
    }
  }

  function initAll() {
    if (current) {
      current.close();
      if (current.bar) current.bar.remove();
      document.body.classList.remove("vt-risk-bar-open");
      current = null;
    }
    document.querySelectorAll("[data-vt-risk-register][data-editor-api]").forEach(init);
  }

  if (window.document$ && typeof window.document$.subscribe === "function") {
    window.document$.subscribe(initAll);
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }
})();

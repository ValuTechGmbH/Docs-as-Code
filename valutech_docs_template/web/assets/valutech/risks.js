/*
 * Risk register filters for the ValuTech docs-as-code template.
 *
 * The register is complete static HTML (the PDF renderer runs no JavaScript);
 * this script only adds a toolbar — text search, category / status / owner
 * selects, level toggles — sortable columns, and click-to-filter on the matrix
 * cells. The filter state lives in the query string, so a filtered view can be
 * shared as a link.
 */

(function () {
  "use strict";

  var PARAM = "risk-";
  var FILTERS = [
    { key: "category", label: "All categories" },
    { key: "status", label: "All statuses" },
    { key: "owner", label: "All owners", empty: "Unassigned" }
  ];

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function titleCase(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
  }

  function readState() {
    var params = new URLSearchParams(window.location.search);
    var state = { q: params.get(PARAM + "q") || "", levels: [], cell: null };
    FILTERS.forEach(function (f) {
      state[f.key] = params.get(PARAM + f.key);
    });
    var levels = params.get(PARAM + "level");
    if (levels) state.levels = levels.split(",");
    var cell = params.get(PARAM + "cell");
    if (cell && /^(rating|residual):\d+-\d+$/.test(cell)) state.cell = cell;
    return state;
  }

  function writeState(state) {
    var params = new URLSearchParams(window.location.search);
    function set(name, value) {
      if (value) params.set(PARAM + name, value);
      else params.delete(PARAM + name);
    }
    set("q", state.q);
    FILTERS.forEach(function (f) {
      set(f.key, state[f.key]);
    });
    set("level", state.levels.join(","));
    set("cell", state.cell);
    var query = params.toString();
    var url = window.location.pathname + (query ? "?" + query : "") + window.location.hash;
    window.history.replaceState(window.history.state, "", url);
  }

  function matches(row, state) {
    var d = row.dataset;
    if (state.q && d.search.indexOf(state.q.toLowerCase()) === -1) return false;
    for (var n = 0; n < FILTERS.length; n++) {
      var key = FILTERS[n].key;
      if (state[key] !== null && state[key] !== undefined && d[key] !== state[key]) return false;
    }
    if (state.levels.length && state.levels.indexOf(d.level) === -1) return false;
    if (state.cell) {
      var parts = state.cell.split(":");
      var pi = parts[1].split("-");
      var p = parts[0] === "residual" ? d.rp : d.p;
      var i = parts[0] === "residual" ? d.ri : d.i;
      if (p !== pi[0] || i !== pi[1] || d.status === "closed") return false;
    }
    return true;
  }

  function init(root) {
    if (root.dataset.vtReady) return;
    root.dataset.vtReady = "1";

    var table = root.querySelector("table");
    var tbody = table.tBodies[0];
    var rows = Array.prototype.slice.call(tbody.rows);
    var page = root.closest(".md-content__inner") || document;
    var cells = page.querySelectorAll(".vt-risk-matrix__cell");
    var state = readState();

    var toolbar = el("div", "vt-risk-toolbar");
    root.insertBefore(toolbar, table);

    var search = el("input");
    search.type = "search";
    search.placeholder = "Search risks…";
    search.setAttribute("aria-label", "Search risks");
    search.value = state.q;
    search.addEventListener("input", function () {
      state.q = search.value.trim();
      apply();
    });
    toolbar.appendChild(search);

    var selects = {};
    FILTERS.forEach(function (f) {
      var seen = {};
      var options = [];
      rows.forEach(function (row) {
        var value = row.dataset[f.key];
        if (value in seen) return;
        seen[value] = true;
        var label = row.dataset[f.key + "Label"] || (value ? titleCase(value) : f.empty);
        options.push({ value: value, label: label });
      });
      if (options.length < 2) return;
      if (f.key !== "status") {
        options.sort(function (a, b) {
          return a.label.localeCompare(b.label);
        });
      }

      var select = el("select");
      select.setAttribute("aria-label", f.label);
      select.appendChild(new Option(f.label, "\u0000"));
      options.forEach(function (o) {
        select.appendChild(new Option(o.label, o.value));
      });
      select.value = state[f.key] === null || state[f.key] === undefined ? "\u0000" : state[f.key];
      if (select.selectedIndex < 0) select.value = "\u0000";
      select.addEventListener("change", function () {
        state[f.key] = select.value === "\u0000" ? null : select.value;
        apply();
      });
      selects[f.key] = select;
      toolbar.appendChild(select);
    });

    // Level toggles reuse the coloured badges of the table.
    var levelBox = el("div", "vt-risk-toolbar__levels");
    var levelButtons = [];
    var seenLevels = {};
    root.querySelectorAll("tbody .vt-risk-level").forEach(function (badge) {
      var key = badge.className.match(/vt-risk-level--([\w-]+)/);
      if (!key || seenLevels[key[1]]) return;
      seenLevels[key[1]] = badge;
    });
    // Present them in configured order (the summary lists them high to low).
    var order = Array.prototype.map.call(
      page.querySelectorAll(".vt-risk-summary .vt-risk-level"),
      function (b) {
        var m = b.className.match(/vt-risk-level--([\w-]+)/);
        return m && m[1];
      }
    );
    Object.keys(seenLevels)
      .sort(function (a, b) {
        return order.indexOf(a) - order.indexOf(b);
      })
      .forEach(function (key) {
        var button = el("button", seenLevels[key].className, seenLevels[key].textContent);
        button.type = "button";
        button.setAttribute("style", seenLevels[key].getAttribute("style"));
        button.dataset.level = key;
        button.addEventListener("click", function () {
          var at = state.levels.indexOf(key);
          if (at === -1) state.levels.push(key);
          else state.levels.splice(at, 1);
          apply();
        });
        levelButtons.push(button);
        levelBox.appendChild(button);
      });
    if (levelButtons.length > 1) toolbar.appendChild(levelBox);

    var cellChip = el("button", "vt-risk-toolbar__chip");
    cellChip.type = "button";
    cellChip.addEventListener("click", function () {
      state.cell = null;
      apply();
    });
    toolbar.appendChild(cellChip);

    var count = el("span", "vt-risk-toolbar__count");
    toolbar.appendChild(count);

    var reset = el("button", "vt-risk-toolbar__reset", "Reset");
    reset.type = "button";
    reset.addEventListener("click", function () {
      state = { q: "", levels: [], cell: null };
      FILTERS.forEach(function (f) {
        state[f.key] = null;
      });
      search.value = "";
      Object.keys(selects).forEach(function (key) {
        selects[key].value = "\u0000";
      });
      apply();
    });
    toolbar.appendChild(reset);

    cells.forEach(function (cell) {
      cell.addEventListener("click", function (event) {
        if (event.target.closest("a")) return; // chips jump to the risk
        var which = cell.closest(".vt-risk-matrix").dataset.matrix;
        var key = which + ":" + cell.dataset.p + "-" + cell.dataset.i;
        state.cell = state.cell === key ? null : key;
        apply();
        root.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });

    // -- sorting --
    table.querySelectorAll("th[data-sort]").forEach(function (th, column) {
      th.setAttribute("role", "button");
      th.tabIndex = 0;
      function sort() {
        var key = th.dataset.sort;
        var dir = th.getAttribute("aria-sort") === "descending" ? 1 : -1;
        if (!th.hasAttribute("aria-sort")) dir = key === "order" || key === "title" || key === "owner" ? 1 : -1;
        table.querySelectorAll("th[aria-sort]").forEach(function (other) {
          other.removeAttribute("aria-sort");
        });
        th.setAttribute("aria-sort", dir === 1 ? "ascending" : "descending");
        var sorted = rows.slice().sort(function (a, b) {
          var x = value(a, key, column);
          var y = value(b, key, column);
          var result = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
          return result * dir || Number(a.dataset.order) - Number(b.dataset.order);
        });
        sorted.forEach(function (row) {
          tbody.appendChild(row);
        });
      }
      th.addEventListener("click", sort);
      th.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          sort();
        }
      });
    });

    function value(row, key, column) {
      if (key === "title") return row.cells[column].textContent.trim();
      if (key === "owner") return row.dataset.owner || "￿"; // unassigned last
      if (key === "status") return Number(row.cells[column].dataset.value);
      return Number(row.dataset[key]) || 0;
    }

    function apply() {
      var shown = 0;
      rows.forEach(function (row) {
        var visible = matches(row, state);
        row.hidden = !visible;
        if (visible) shown++;
      });
      count.textContent = shown === rows.length ? rows.length + " risks" : shown + " of " + rows.length + " risks";

      levelButtons.forEach(function (button) {
        var on = state.levels.length === 0 || state.levels.indexOf(button.dataset.level) !== -1;
        button.setAttribute("aria-pressed", on ? "true" : "false");
      });

      cells.forEach(function (cell) {
        var which = cell.closest(".vt-risk-matrix").dataset.matrix;
        cell.classList.toggle(
          "vt-risk-matrix__cell--active",
          state.cell === which + ":" + cell.dataset.p + "-" + cell.dataset.i
        );
      });
      if (state.cell) {
        var active = page.querySelector(".vt-risk-matrix__cell--active");
        cellChip.textContent = (active ? active.getAttribute("title") : "Matrix cell") + " ✕";
        cellChip.hidden = false;
      } else {
        cellChip.hidden = true;
      }

      var dirty = state.q || state.levels.length || state.cell;
      FILTERS.forEach(function (f) {
        if (state[f.key] !== null && state[f.key] !== undefined) dirty = true;
      });
      reset.hidden = !dirty;
      writeState(state);
    }

    apply();
  }

  function initAll() {
    document.querySelectorAll("[data-vt-risk-register]").forEach(init);
  }

  // Material's instant navigation swaps pages without a reload.
  if (window.document$ && typeof window.document$.subscribe === "function") {
    window.document$.subscribe(initAll);
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }
})();

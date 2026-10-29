"""MkDocs plugin: risk register from one Markdown file per risk.

Risks live outside ``docs_dir`` (default ``risks/`` next to ``mkdocs.yaml``),
one file each, with the scores in YAML front matter — see ``model.py`` for the
format. The plugin renders the register (summary, risk matrix, filterable
table, then every risk written out) into the page containing the marker::

    <!-- valutech:risk-register -->

Links inside a risk body are written as if they were in that register page.
Anywhere in the docs, ``[[T2]]`` becomes a coloured badge linking to risk T2.

Enable it in a consuming project's ``mkdocs.yaml``::

    plugins:
      valutech-risks:
        categories:
          technical: Technical
        issues:
          repo: owner/docs-repo        # default repo for "#12" references
          token_env: GITHUB_TOKEN      # optional; state badges when set
        editor:                        # optional; edit risks in the browser
          api_base: /api/risks         # the api/risks function (valutech-docs-init --with-api)

With the editor on, each category also needs ``id_prefix`` (e.g. ``K``) so new
risks can be numbered, the build writes ``risks-source.json`` (every file's
fields and git blob id) for the editor, and writes the validation schema into
the generated ``api/risks/schema.json`` for the function.

Problems in risk files are reported as warnings (so ``mkdocs build --strict``
fails on them) and the offending file is left out of the register.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import posixpath
import re
from pathlib import Path

from mkdocs.config import config_options
from mkdocs.exceptions import PluginError
from mkdocs.plugins import BasePlugin
from mkdocs.structure.files import File

from ... import __version__
from . import render
from .issues import IssueLookup
from .model import Level, Scale, load_risks, natural_key, slug
from .source import export, repo_path, schema

log = logging.getLogger("mkdocs.plugins.valutech-risks")

PACKAGE_DIR = Path(__file__).resolve().parent.parent.parent
WEB_DIR = PACKAGE_DIR / "web"
ASSET_URI = "assets/valutech"
ASSETS = ("risks.css", "risks.js")
EDITOR_ASSETS = ("risks-editor.css", "risks-editor.js")
RISKFILE_JS = PACKAGE_DIR / "api" / "lib" / "riskfile.js"
"""Shared with the risks API, so the editor validates exactly like the server."""

DEFAULT_LEVELS = [
    {"name": "Low", "max": 2, "color": "#2e7d32"},
    {"name": "Medium", "max": 4, "color": "#f9a825"},
    {"name": "High", "color": "#c62828"},
]

REFERENCE = re.compile(r"(?P<code>`+)(?:.+?)(?P=code)|\[\[(?P<id>[A-Za-z0-9][\w.-]*)\]\]")
FENCE = re.compile(r"^\s*(`{3,}|~{3,})")
HEADING = re.compile(r"^#\s+(.+?)\s*#*\s*$", re.MULTILINE)


def outside_code(markdown: str, replace) -> str:
    """Apply `replace(match)` to `[[ID]]` references outside code blocks and spans."""
    out, fence = [], None
    for line in markdown.splitlines(keepends=True):
        match = FENCE.match(line)
        if fence:
            if match and match.group(1)[0] == fence[0] and len(match.group(1)) >= len(fence):
                fence = None
            out.append(line)
            continue
        if match:
            fence = match.group(1)
            out.append(line)
            continue
        out.append(REFERENCE.sub(lambda m: m.group(0) if m.group("code") else replace(m), line))
    return "".join(out)


class RisksPlugin(BasePlugin):
    """Builds the risk register and resolves ``[[ID]]`` references."""

    config_scheme = (
        ("enabled", config_options.Type(bool, default=True)),
        ("dir", config_options.Type(str, default="risks")),
        ("marker", config_options.Type(str, default="<!-- valutech:risk-register -->")),
        ("probability", config_options.Type(list, default=["low", "medium", "high"])),
        ("impact", config_options.Type(list, default=["low", "medium", "high"])),
        ("levels", config_options.Type(list, default=DEFAULT_LEVELS)),
        ("categories", config_options.Type(dict, default={})),
        ("review_days", config_options.Type(int, default=0)),
        ("issues", config_options.Type(dict, default={})),
        ("export_json", config_options.Type(bool, default=True)),
        ("editor", config_options.Type(dict, default={})),
    )

    def __init__(self) -> None:
        super().__init__()
        self._scale: Scale | None = None
        self._categories: dict[str, dict] = {}
        self._dir: Path | None = None
        self._lookup = IssueLookup(None)
        self._default_repo: str | None = None
        self._risks = []
        self._problems: list[str] = []
        self._schema: dict | None = None
        self._register: str | None = None
        self._backlinks: dict[str, list[tuple[str, str]]] = {}
        self._titles: dict[str, str] = {}

    # -- configuration -----------------------------------------------------

    def on_config(self, config):
        if not self.config["enabled"]:
            return config

        self._scale = self._build_scale()
        self._categories = self._build_categories()

        base = Path(config.config_file_path or ".").resolve().parent
        self._dir = (base / self.config["dir"]).resolve()

        issues = self.config["issues"]
        self._default_repo = issues.get("repo") or self._repo_from_url(config.get("repo_url"))
        token = os.environ.get(issues.get("token_env", "GITHUB_TOKEN")) if issues.get("lookup", True) else None
        self._lookup = IssueLookup(token, issues.get("api_url", "https://api.github.com"))

        self._schema = None
        if self.config["editor"].get("api_base"):
            self._schema = schema(self._scale, self._categories, repo_path(self._dir), self._default_repo)
            self._write_api_schema(base)

        # Risk headings carry explicit anchors and classes: {#t2 .vt-risk-heading}.
        if "attr_list" not in config["markdown_extensions"]:
            config["markdown_extensions"].append("attr_list")

        config["extra_css"].append(f"{ASSET_URI}/risks.css?v={__version__}")
        config["extra_javascript"].append(f"{ASSET_URI}/risks.js?v={__version__}")
        if self._schema:
            config["extra_css"].append(f"{ASSET_URI}/risks-editor.css?v={__version__}")
            config["extra_javascript"].append(f"{ASSET_URI}/riskfile.js?v={__version__}")
            config["extra_javascript"].append(f"{ASSET_URI}/risks-editor.js?v={__version__}")
        return config

    def _build_scale(self) -> Scale:
        levels = []
        for n, item in enumerate(self.config["levels"]):
            if not isinstance(item, dict) or not item.get("name") or not item.get("color"):
                raise PluginError(f"valutech-risks: levels[{n}] needs `name` and `color`")
            maximum = item.get("max")
            if maximum is None and n != len(self.config["levels"]) - 1:
                raise PluginError("valutech-risks: only the last level may omit `max`")
            levels.append(Level(str(item["name"]), maximum, str(item["color"])))
        if [lv.max for lv in levels if lv.max is not None] != sorted(lv.max for lv in levels if lv.max is not None):
            raise PluginError("valutech-risks: levels must be ordered by ascending `max`")
        for axis in ("probability", "impact"):
            if not self.config[axis]:
                raise PluginError(f"valutech-risks: `{axis}` scale is empty")
        return Scale(
            tuple(str(v) for v in self.config["probability"]),
            tuple(str(v) for v in self.config["impact"]),
            tuple(levels),
        )

    def _build_categories(self) -> dict[str, dict]:
        categories = {}
        for key, value in self.config["categories"].items():
            if isinstance(value, str):
                value = {"title": value}
            value = dict(value or {})
            value.setdefault("title", render.title_case(str(key)))
            categories[slug(key)] = value
        return categories

    def _write_api_schema(self, base: Path) -> None:
        """Hand the risks function the same rules the build uses, as a generated file."""
        missing = [key for key, value in self._categories.items() if not value.get("id_prefix")]
        if missing:
            log.warning("Risk editor: categories without `id_prefix` cannot get new risks: %s", ", ".join(missing))
        api_dir = base / self.config["editor"].get("api_dir", "api")
        if not (api_dir / ".valutech-generated").is_file():
            log.info("Risk editor: %s was not generated by valutech-docs-init --with-api; schema not written", api_dir)
            return
        target = api_dir / "risks" / "schema.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(self._schema, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    @staticmethod
    def _repo_from_url(url: str | None) -> str | None:
        match = re.match(r"https?://github\.com/([\w.-]+/[\w.-]+?)(?:\.git)?/?$", url or "")
        return match.group(1) if match else None

    # -- build -------------------------------------------------------------

    def on_serve(self, server, config, builder):
        if self.config["enabled"] and self._dir and self._dir.is_dir():
            server.watch(str(self._dir))
        return server

    def on_files(self, files, config):
        if not self.config["enabled"]:
            return files

        assets = {name: WEB_DIR / ASSET_URI / name for name in ASSETS}
        if self._schema:
            assets.update({name: WEB_DIR / ASSET_URI / name for name in EDITOR_ASSETS})
            assets["riskfile.js"] = RISKFILE_JS
        for name, path in assets.items():
            files.append(File.generated(config, f"{ASSET_URI}/{name}", abs_src_path=str(path)))

        self._risks, self._problems = [], []
        if self._dir.is_dir():
            self._risks, self._problems = load_risks(self._dir, self._scale, self._categories, self._default_repo)
            for problem in self._problems:
                log.warning("Risk skipped — %s", problem)
        else:
            log.warning("Risk directory %s does not exist", self._dir)

        # Categories used by risks but not configured still get a section.
        for risk in self._risks:
            self._categories.setdefault(risk.category, {"title": render.title_case(risk.category)})
        order = list(self._categories)
        self._risks.sort(key=lambda r: (order.index(r.category), natural_key(r.id)))

        self._scan_pages(files)
        self._lookup.prefetch(ref for risk in self._risks for ref in risk.all_issues)
        return files

    def _scan_pages(self, files) -> None:
        """Find the register page and every `[[ID]]` reference, before any page renders."""
        self._register = None
        self._backlinks = {}
        self._titles = {}
        known = {risk.id.lower() for risk in self._risks}

        for file in files.documentation_pages():
            try:
                source = file.content_string
            except (OSError, UnicodeDecodeError):
                continue
            if self.config["marker"] in source:
                if self._register:
                    log.warning("Risk register marker also in %s — only %s is used", file.src_uri, self._register)
                else:
                    self._register = file.src_uri

            found = set()
            outside_code(source, lambda m: found.add(m.group("id").lower()) or m.group(0))
            heading = HEADING.search(source)
            self._titles[file.src_uri] = heading.group(1) if heading else Path(file.src_uri).stem
            for risk_id in found & known:
                self._backlinks.setdefault(risk_id, []).append(file.src_uri)

        if self._risks and not self._register:
            log.warning("No page contains the risk register marker %s", self.config["marker"])

    def on_nav(self, nav, config, files):
        if self.config["enabled"]:
            for page in nav.pages:
                if page.title:
                    self._titles[page.file.src_uri] = page.title
        return nav

    def on_page_markdown(self, markdown, page, config, files):
        if not self.config["enabled"]:
            return markdown

        src = page.file.src_uri
        if src == self._register:
            markdown = markdown.replace(self.config["marker"], render.register(self._context(page)), 1)

        risks = {risk.id.lower(): risk for risk in self._risks}

        def replace(match):
            risk = risks.get(match.group("id").lower())
            if not risk:
                log.warning("%s: unknown risk reference [[%s]]", src, match.group("id"))
                return match.group(0)
            if not self._register:
                return match.group(0)
            target = "" if src == self._register else render.relative(self._register, src)
            return render.reference(risk, f"{target}#{risk.anchor}")

        return outside_code(markdown, replace)

    def _context(self, page) -> render.Context:
        backlinks = {
            risk_id: [
                (render.relative(uri, self._register), self._titles.get(uri, uri))
                for uri in uris
                if uri != self._register
            ]
            for risk_id, uris in self._backlinks.items()
        }
        return render.Context(
            risks=self._risks,
            categories=self._categories,
            scale=self._scale,
            issues=self._lookup,
            default_repo=self._default_repo,
            review_days=self.config["review_days"],
            backlinks=backlinks,
            today=dt.date.today(),
            editor=self._editor_attrs(page),
        )

    def _editor_attrs(self, page) -> dict | None:
        """Where the register page's editor finds its API and the build's risk sources."""
        if not self._schema:
            return None
        url = page.url or ""
        here = url if url.endswith("/") or not url else posixpath.dirname(url)
        return {
            "data_editor_api": self.config["editor"]["api_base"],
            "data_editor_source": posixpath.relpath("risks-source.json", here or "."),
        }

    def on_post_build(self, config):
        if not self.config["enabled"]:
            return
        if self._schema and self._dir.is_dir():
            source = {
                "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                "commit": os.environ.get("GITHUB_SHA"),
                "schema": self._schema,
                "files": export(self._dir, self._schema["dir"], self._problems),
            }
            target = Path(config["site_dir"]) / "risks-source.json"
            target.write_text(json.dumps(source, indent=2, ensure_ascii=False), encoding="utf-8")
        if not self.config["export_json"] or not self._risks:
            return

        register_url = None
        if self._register:
            file = File(self._register, config["docs_dir"], config["site_dir"], config["use_directory_urls"])
            register_url = file.url

        def rating(r):
            if not r:
                return None
            return {
                "probability": r.probability_label,
                "impact": r.impact_label,
                "score": r.score,
                "level": r.level.name,
            }

        def issue(ref):
            state = self._lookup.get(ref)
            return {
                "repo": ref.repo,
                "number": ref.number,
                "url": ref.url,
                "state": state.state if state else None,
                "state_reason": state.state_reason if state else None,
            }

        data = {
            "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "scale": {"probability": list(self._scale.probability), "impact": list(self._scale.impact)},
            "risks": [
                {
                    "id": r.id,
                    "title": r.title,
                    "category": r.category,
                    "status": r.status,
                    "owner": r.owner,
                    "rating": rating(r.rating),
                    "residual": rating(r.residual),
                    "reviewed": r.reviewed.isoformat() if r.reviewed else None,
                    "mitigations": [
                        {"text": m.text, "status": m.status, "issues": [issue(i) for i in m.issues]}
                        for m in r.mitigations
                    ],
                    "issues": [issue(i) for i in r.issues],
                    "url": f"{register_url}#{r.anchor}" if register_url is not None else None,
                }
                for r in self._risks
            ],
        }
        target = Path(config["site_dir"]) / "risks.json"
        target.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

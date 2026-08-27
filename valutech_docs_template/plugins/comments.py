"""MkDocs plugin: GitHub-issue-backed page comments.

Appends a comment widget to the end of every page. The widget talks to the
Azure Static Web Apps managed function shipped alongside this package (see
``valutech_docs_template/api``), which opens one GitHub issue per comment and
lists the existing ones with their state.

Enable it in a consuming project's ``mkdocs.yaml``::

    plugins:
      valutech-comments:
        api_base: /api/comments

Set ``comments: false`` in a page's front matter to opt a single page out.

The widget is skipped entirely while ``ENABLE_PDF_EXPORT`` is set, so it never
ends up in the rendered PDF.
"""

from __future__ import annotations

import os
from html import escape
from pathlib import Path

from mkdocs.config import config_options
from mkdocs.plugins import BasePlugin
from mkdocs.structure.files import File

from .. import __version__

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
"""Root of the static assets bundled with the package."""

ASSET_URI = "assets/valutech"
"""Destination directory for the widget assets, relative to the site root."""

ASSETS = ("comments.css", "comments.js")


class CommentsPlugin(BasePlugin):
    """Injects the comment widget and its assets into the built site."""

    config_scheme = (
        ("enabled", config_options.Type(bool, default=True)),
        ("api_base", config_options.Type(str, default="/api/comments")),
        ("title", config_options.Type(str, default="Comments")),
        (
            "intro",
            config_options.Type(
                str,
                default=(
                    "Something wrong, unclear or missing? Leave a comment — it opens "
                    "an issue in the documentation repository."
                ),
            ),
        ),
        (
            "kinds",
            config_options.Type(
                list,
                default=["Unclear", "Incorrect", "Missing", "Typo", "Suggestion"],
            ),
        ),
    )

    def __init__(self) -> None:
        super().__init__()
        self._active = False

    # -- lifecycle ---------------------------------------------------------

    def on_config(self, config):
        # The PDF build shares on_page_content with the HTML build, so the only
        # way to keep the widget out of the PDF is to sit this build out.
        self._active = self.config["enabled"] and not os.environ.get("ENABLE_PDF_EXPORT")
        if not self._active:
            return config

        # The version query makes a template upgrade reach readers who still
        # have the previous widget in their browser cache.
        config["extra_css"].append(f"{ASSET_URI}/comments.css?v={__version__}")
        config["extra_javascript"].append(f"{ASSET_URI}/comments.js?v={__version__}")
        return config

    def on_files(self, files, config):
        if not self._active:
            return files

        for name in ASSETS:
            files.append(
                File.generated(
                    config,
                    f"{ASSET_URI}/{name}",
                    abs_src_path=str(WEB_DIR / ASSET_URI / name),
                )
            )
        return files

    def on_page_content(self, html, page, config, files):
        if not self._active or page.meta.get("comments", True) is False:
            return html
        return html + self._widget(page)

    # -- rendering ---------------------------------------------------------

    def _widget(self, page) -> str:
        """Return the mount point. All rendering happens in comments.js."""
        attrs = {
            "data-vt-comments": "",
            "data-api": self.config["api_base"],
            "data-page": "/" + page.url.lstrip("/"),
            "data-page-title": page.title or "",
            "data-kinds": "|".join(str(k) for k in self.config["kinds"]),
            "data-title": self.config["title"],
            "data-intro": self.config["intro"],
        }
        rendered = " ".join(f'{key}="{escape(value, quote=True)}"' for key, value in attrs.items())
        return f'\n<section class="vt-comments" {rendered}></section>\n'

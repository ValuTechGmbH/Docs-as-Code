"""ValuTech docs-as-code template — MkDocs with Material theme and PDF export."""

__version__ = "0.1.0"

from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
"""Directory of the installed valutech_docs_template package."""

TEMPLATE_DIR = PACKAGE_DIR
"""Alias for PACKAGE_DIR (kept for backwards compatibility)."""

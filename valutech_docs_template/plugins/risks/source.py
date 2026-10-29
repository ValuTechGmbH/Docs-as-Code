"""Risk files as editor forms, and rewriting them in the canonical layout.

The browser editor never parses YAML. The build reads each file here and hands
the editor its fields in the shape ``api/lib/riskfile.js`` writes back from, so
that module is the only writer and every file keeps one layout.

Normalise a project's risk files once before enabling the editor, so the first
edit made in the browser does not also reformat the file::

    python -m valutech_docs_template.plugins.risks.source risks/           # report
    python -m valutech_docs_template.plugins.risks.source --write risks/   # rewrite

Needs ``node`` on PATH.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

from .model import FRONT_MATTER, RiskError, _list

RISKFILE_JS = Path(__file__).resolve().parent.parent.parent / "api" / "lib" / "riskfile.js"

RISK_KEYS = ("id", "title", "category", "status", "owner", "probability", "impact",
             "residual", "reviewed", "mitigations", "issue", "issues")
MITIGATION_KEYS = ("text", "status", "issue", "issues")


def _plain(value):
    """YAML values as JSON values; dates become ISO strings."""
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    return value


def _extra(meta: dict, known) -> dict:
    return {str(k): _plain(v) for k, v in meta.items() if k not in known}


def read_source(path: Path) -> dict:
    """The editor form for one risk file, as written (issue refs are not resolved)."""
    text = path.read_text(encoding="utf-8-sig")
    match = FRONT_MATTER.match(text)
    if not match:
        raise RiskError("no YAML front matter (--- ... ---) at the top of the file")
    try:
        meta = yaml.safe_load(match.group(1) or "") or {}
    except yaml.YAMLError as error:
        raise RiskError(f"invalid front matter: {error}") from None
    if not isinstance(meta, dict):
        raise RiskError("front matter is not a mapping")

    mitigations = []
    for item in _list(meta.get("mitigations")):
        if not isinstance(item, dict):
            item = {"text": item}
        mitigations.append({
            "text": _plain(item.get("text")),
            "status": _plain(item.get("status", "planned")),
            "issues": _plain(_list(item.get("issue")) + _list(item.get("issues"))),
            "extra": _extra(item, MITIGATION_KEYS),
        })

    residual = meta.get("residual")
    return {
        "id": _plain(meta.get("id")),
        "title": _plain(meta.get("title")),
        "category": _plain(meta.get("category")),
        "status": _plain(meta.get("status", "open")),
        "owner": _plain(meta.get("owner")),
        "probability": _plain(meta.get("probability")),
        "impact": _plain(meta.get("impact")),
        "residual": _plain(residual) if isinstance(residual, dict) else None,
        "reviewed": _plain(meta.get("reviewed")),
        "mitigations": mitigations,
        "issues": _plain(_list(meta.get("issue")) + _list(meta.get("issues"))),
        "extra": _extra(meta, RISK_KEYS),
        "body": text[match.end():],
    }


def format_risks(forms: list[dict]) -> list[str]:
    """Write each form with ``riskfile.js``, in one ``node`` run."""
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node is not on PATH; it runs api/lib/riskfile.js")
    script = (
        f"const {{ formatRisk }} = require({json.dumps(str(RISKFILE_JS))});"
        "let input = '';"
        "process.stdin.on('data', (chunk) => (input += chunk));"
        "process.stdin.on('end', () => process.stdout.write(JSON.stringify(JSON.parse(input).map(formatRisk))));"
    )
    result = subprocess.run(
        [node, "-e", script], input=json.dumps(forms), capture_output=True, text=True, encoding="utf-8"
    )
    if result.returncode:
        raise RuntimeError(f"riskfile.js failed: {result.stderr.strip()}")
    return json.loads(result.stdout)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Rewrite risk files in the layout the browser editor writes.")
    parser.add_argument("directory", type=Path)
    parser.add_argument("--write", action="store_true", help="rewrite the files (default: only list them)")
    args = parser.parse_args(argv)

    paths, forms, failed = [], [], False
    for path in sorted(args.directory.rglob("*.md")):
        try:
            forms.append(read_source(path))
            paths.append(path)
        except RiskError as error:
            print(f"skipped {path}: {error}", file=sys.stderr)
            failed = True

    changed = 0
    for path, text in zip(paths, format_risks(forms)):
        if path.read_text(encoding="utf-8-sig") == text:
            continue
        changed += 1
        print(("rewrote " if args.write else "would rewrite ") + str(path))
        if args.write:
            path.write_text(text, encoding="utf-8", newline="\n")

    print(f"{changed} of {len(paths)} file(s) {'rewritten' if args.write else 'not canonical'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

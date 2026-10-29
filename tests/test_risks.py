"""Risk register plugin: build a tiny project end to end.

Run with `python -m unittest tests/test_risks.py` (or pytest).
"""

import json
import logging
import shutil
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from mkdocs.commands.build import build
from mkdocs.config import load_config

from valutech_docs_template.plugins.risks.issues import IssueLookup, IssueState
from valutech_docs_template.plugins.risks.model import IssueRef, RiskError, Scale, Level, parse_issue, parse_risk
from valutech_docs_template.plugins.risks.source import format_risks, read_source

SCALE = Scale(("low", "medium", "high"), ("low", "medium", "high"), (Level("Low", 2, "#2e7d32"), Level("High", None, "#c62828")))


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(text).lstrip(), encoding="utf-8")


class ModelTest(unittest.TestCase):
    def test_scale_accepts_labels_and_numbers(self):
        self.assertEqual(SCALE.index("probability", "High"), 3)
        self.assertEqual(SCALE.index("impact", 2), 2)
        with self.assertRaises(RiskError):
            SCALE.index("impact", "huge")
        with self.assertRaises(RiskError):
            SCALE.index("impact", 4)

    def test_levels_by_score(self):
        self.assertEqual(SCALE.level(2).name, "Low")
        self.assertEqual(SCALE.level(9).name, "High")

    def test_issue_refs(self):
        self.assertEqual(parse_issue("#12", "o/docs"), IssueRef("o/docs", 12))
        self.assertEqual(parse_issue(12, "o/docs"), IssueRef("o/docs", 12))
        self.assertEqual(parse_issue("o/fw#3", None), IssueRef("o/fw", 3))
        self.assertEqual(parse_issue("https://github.com/o/fw/issues/3", None), IssueRef("o/fw", 3))
        with self.assertRaises(RiskError):
            parse_issue("#12", None)

    def test_lookup_without_token_is_inert(self):
        lookup = IssueLookup(None)
        with mock.patch("urllib.request.urlopen") as urlopen:
            lookup.prefetch([IssueRef("o/docs", 1)])
        urlopen.assert_not_called()
        self.assertIsNone(lookup.get(IssueRef("o/docs", 1)))

    def test_lookup_failure_does_not_raise(self):
        lookup = IssueLookup("token", api_url="http://127.0.0.1:9", timeout=0.5)
        lookup.prefetch([IssueRef("o/docs", 1)])
        self.assertIsNone(lookup.get(IssueRef("o/docs", 1)))


# Strings PyYAML would read as something else, or that break plain scalars.
AWKWARD = [
    "yes", "No", "on", "null", "~", "true", "123", "1.5", "-1", ".5", "0x1F", "12:30", "1_000",
    "2026-10-20", "#11", "a: b", "a #b", "a#b", "- x", "trailing:", " lead", "trail ", "multi\nline",
    "tab\there", 'say "hi"', "it's", "@user", "`code`", "%x", "[x]", "{x}", "!tag", "&a", "*a", "|", ">",
    "?", "ünïcode — ok", "a:b", "", "line\u2028sep", "back\\slash",
]


def form(**overrides):
    base = {
        "id": "T1", "title": "A risk", "category": "technical", "status": "open", "owner": None,
        "probability": "high", "impact": "medium", "residual": None, "reviewed": None,
        "mitigations": [], "issues": [], "extra": {}, "body": "Body.\n",
    }
    base.update(overrides)
    return base


@unittest.skipUnless(shutil.which("node"), "node is needed to run api/lib/riskfile.js")
class RiskFileTest(unittest.TestCase):
    """api/lib/riskfile.js writes what the build reads back unchanged."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def round_trip(self, forms):
        paths = []
        for n, text in enumerate(format_risks(forms)):
            path = self.dir / f"r{n}.md"
            path.write_text(text, encoding="utf-8")
            paths.append(path)
        return [read_source(path) for path in paths], paths

    def test_awkward_strings_survive(self):
        forms = [
            form(
                title=text,
                owner=text,
                mitigations=[{"text": text or "x", "status": "planned", "issues": [], "extra": {"note": text}}],
                extra={"note": text},
            )
            for text in AWKWARD
        ]
        back, _ = self.round_trip(forms)
        for sent, got in zip(forms, back):
            with self.subTest(text=sent["title"]):
                self.assertEqual(got["title"], sent["title"])
                self.assertEqual(got["owner"], sent["owner"] or None)  # "" means unassigned
                self.assertEqual(got["mitigations"], sent["mitigations"])
                self.assertEqual(got["extra"], sent["extra"])

    def test_full_risk_round_trips_and_parses(self):
        sent = form(
            status="mitigating",
            owner="Jane Doe",
            residual={"probability": "low", "impact": "medium"},
            reviewed="2026-10-20",
            mitigations=[
                {"text": "Measure", "status": "in-progress", "issues": ["o/fw#42"], "extra": {}},
                {"text": "Decide", "status": "planned", "issues": ["#1", "o/fw#2"], "extra": {}},
            ],
            issues=["#17"],
            extra={"tags": ["a", "b"], "links": {"spec": "https://x.example/a#b"}},
            body="First line.\n\n- a list\n",
        )
        (got,), (path,) = self.round_trip([sent])
        self.assertEqual(got, sent)

        risk = parse_risk(path, SCALE, {"technical": {}}, "o/docs")
        self.assertEqual(risk.reviewed.isoformat(), "2026-10-20")
        self.assertEqual(risk.residual.probability, 1)
        self.assertEqual([len(m.issues) for m in risk.mitigations], [1, 2])
        self.assertEqual(risk.body, "First line.\n\n- a list")

    def test_single_mitigation_issue_is_written_singular(self):
        text = format_risks([form(mitigations=[{"text": "M", "status": "done", "issues": ["#3"], "extra": {}}])])[0]
        self.assertIn("    issue: \"#3\"\n", text)
        self.assertNotIn("issues:", text)

    def test_extra_cannot_override_known_keys(self):
        text = format_risks([form(extra={"status": "closed", "residual": {"probability": "low"}, "kept": 1})])[0]
        self.assertIn("status: open\n", text)
        self.assertNotIn("residual", text)
        self.assertIn("kept: 1\n", text)

    def test_normalising_is_idempotent(self):
        path = self.dir / "messy.md"
        write(
            path,
            """
            ---
            title: 'Quoted title'
            id: T9
            category: technical
            probability: 3
            impact: low
            reviewed: 2026-01-02
            mitigations: [Just text]
            issues: "#5"
            custom: value
            ---


            Body after blank lines.
            """,
        )
        first = format_risks([read_source(path)])[0]
        self.assertTrue(first.startswith("---\nid: T9\ntitle: Quoted title\n"))
        self.assertIn("status: open\n", first)
        self.assertIn("  - text: Just text\n    status: planned\n", first)
        self.assertTrue(first.endswith("custom: value\n---\nBody after blank lines.\n"))
        path.write_text(first, encoding="utf-8")
        self.assertEqual(format_risks([read_source(path)])[0], first)

    def test_bad_date_is_rejected(self):
        with self.assertRaises(RuntimeError):
            format_risks([form(reviewed="20.10.2026")])


class BuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        write(
            root / "mkdocs.yml",
            """
            site_name: Test
            docs_dir: docs
            site_dir: site
            nav:
              - Home: index.md
              - Risks: project/risks.md
            plugins:
              - valutech-risks:
                  categories:
                    technical: Technical
                  review_days: 30
                  issues:
                    repo: o/docs
            """,
        )
        write(root / "docs/index.md", "# Home\n\nSee [[T1]] and `[[T9]]`.\n\n```\n[[T1]]\n```\n\nAnd [[NOPE]].\n")
        write(root / "docs/project/risks.md", "# Risks\n\nIntro.\n\n<!-- valutech:risk-register -->\n")
        write(
            root / "risks/T1.md",
            """
            ---
            id: T1
            title: Things break
            category: technical
            status: mitigating
            owner: Jane
            probability: high
            impact: medium
            residual: { probability: low, impact: medium }
            reviewed: 2000-01-01
            mitigations:
              - text: Do a thing | carefully
                status: done
                issue: "#5"
              - Test more
            issues: [o/fw#7]
            ---
            Body with a [link](../index.md).
            """,
        )
        write(root / "risks/T10.md", "---\nid: T10\ntitle: Later\ncategory: technical\nprobability: 1\nimpact: 1\n---\n")
        write(root / "risks/bad.md", "---\nid: T3\ntitle: Bad\ncategory: technical\nprobability: huge\nimpact: low\n---\n")
        write(root / "risks/dup.md", "---\nid: t1\ntitle: Dup\ncategory: technical\nprobability: 1\nimpact: 1\n---\n")
        self.root = root

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, lookup=None):
        config = load_config(str(self.root / "mkdocs.yml"))
        with self.assertLogs("mkdocs", level=logging.WARNING) as logs:
            if lookup:
                with mock.patch.object(IssueLookup, "_fetch", lookup):
                    with mock.patch.dict("os.environ", {"GITHUB_TOKEN": "x"}):
                        build(config)
            else:
                build(config)
        return "\n".join(logs.output)

    def test_register(self):
        warnings = self.build()
        self.assertIn("bad.md: probability 'huge' is not on the scale", warnings)
        self.assertIn("dup.md: id 't1' is already used", warnings)
        self.assertIn("unknown risk reference [[NOPE]]", warnings)
        self.assertNotIn("T9", warnings)

        html = (self.root / "site/project/risks/index.html").read_text()
        self.assertIn('id="t1"', html)
        self.assertLess(html.index('data-risk="T1"'), html.index('data-risk="T10"'))
        self.assertIn('data-matrix="residual"', html)
        self.assertIn("vt-risk-stale", html)
        self.assertIn("Do a thing \\| carefully".replace("\\|", "|"), html)
        self.assertIn('href="https://github.com/o/docs/issues/5"', html)
        self.assertIn(">o/fw#7<", html)
        self.assertIn('href="../../"', html)  # body link resolved relative to the register page
        self.assertNotIn("vt-risk-issue-state", html)  # no token, plain links

        index = (self.root / "site/index.html").read_text()
        self.assertIn('href="project/risks/#t1"', index)
        self.assertIn("<code>[[T9]]</code>", index)
        self.assertIn("[[T1]]\n</code>", index)

        data = json.loads((self.root / "site/risks.json").read_text())
        self.assertEqual([r["id"] for r in data["risks"]], ["T1", "T10"])
        self.assertEqual(data["risks"][0]["url"], "project/risks/#t1")

    def test_issue_states_with_token(self):
        def fetch(self, ref):
            return IssueState("closed", "completed", "Done thing") if ref.number == 5 else None

        self.build(fetch)
        html = (self.root / "site/project/risks/index.html").read_text()
        self.assertIn("vt-risk-issue-state--completed", html)
        self.assertEqual(html.count("class=\"vt-risk-issue-state "), 1)


if __name__ == "__main__":
    unittest.main()

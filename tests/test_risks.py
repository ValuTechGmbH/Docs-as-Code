"""Risk register plugin: build a tiny project end to end.

Run with `python -m unittest tests/test_risks.py` (or pytest).
"""

import json
import logging
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from mkdocs.commands.build import build
from mkdocs.config import load_config

from valutech_docs_template.plugins.risks.issues import IssueLookup, IssueState
from valutech_docs_template.plugins.risks.model import IssueRef, RiskError, Scale, Level, parse_issue

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

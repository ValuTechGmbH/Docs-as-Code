"""Risk files: loading, validation and scoring.

A risk is one Markdown file with YAML front matter::

    ---
    id: T2
    title: Energy budget does not close
    category: technical
    status: mitigating
    owner: Jane Doe
    probability: high
    impact: high
    residual: { probability: medium, impact: high }
    reviewed: 2026-10-20
    mitigations:
      - text: Measure per-phase energy
        status: planned
        issue: geobrugg-sentra/mainboard-firmware#42
    issues: ["#17"]
    ---
    Free Markdown: description and reasoning.

The risk level is never stored — it follows from probability x impact and the
configured level thresholds, so it cannot drift away from the two scores.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

STATUSES = ("open", "mitigating", "accepted", "occurred", "closed")
"""Lifecycle of a risk. `closed` risks stay in the register but leave the matrix."""

MITIGATION_STATUSES = ("planned", "in-progress", "done", "dropped")

FRONT_MATTER = re.compile(r"\A---[ \t]*\r?\n(.*?\r?\n)?---[ \t]*(?:\r?\n|\Z)", re.DOTALL)


class RiskError(ValueError):
    """A problem in one risk file; the file is skipped and the build warns."""


# -- scale ----------------------------------------------------------------


@dataclass(frozen=True)
class Level:
    name: str
    max: int | None
    """Highest score (probability index x impact index, 1-based) in this level."""
    color: str

    @property
    def key(self) -> str:
        return slug(self.name)

    @property
    def text_color(self) -> str:
        """Black or white, whichever reads better on `color`."""
        hex_ = self.color.lstrip("#")
        if len(hex_) == 3:
            hex_ = "".join(c * 2 for c in hex_)
        try:
            r, g, b = (int(hex_[i : i + 2], 16) / 255 for i in (0, 2, 4))
        except ValueError:
            return "#fff"

        def channel(c):
            return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

        luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
        return "#000" if luminance > 0.4 else "#fff"


@dataclass(frozen=True)
class Scale:
    probability: tuple[str, ...]
    impact: tuple[str, ...]
    levels: tuple[Level, ...]

    def index(self, axis: str, value) -> int:
        """1-based position of `value` on `axis`; accepts the label or the number."""
        labels = getattr(self, axis)
        if isinstance(value, bool):
            value = None
        if isinstance(value, int):
            if 1 <= value <= len(labels):
                return value
        elif isinstance(value, str):
            for i, label in enumerate(labels, 1):
                if value.strip().lower() == label.lower():
                    return i
        raise RiskError(f"{axis} {value!r} is not on the scale ({', '.join(labels)})")

    def level(self, score: int) -> Level:
        for level in self.levels:
            if level.max is None or score <= level.max:
                return level
        return self.levels[-1]


@dataclass(frozen=True)
class Rating:
    probability: int
    impact: int
    scale: Scale = field(repr=False, compare=False)

    @property
    def score(self) -> int:
        return self.probability * self.impact

    @property
    def level(self) -> Level:
        return self.scale.level(self.score)

    @property
    def probability_label(self) -> str:
        return self.scale.probability[self.probability - 1]

    @property
    def impact_label(self) -> str:
        return self.scale.impact[self.impact - 1]


# -- issues ---------------------------------------------------------------

ISSUE_URL = re.compile(r"^https?://github\.com/([\w.-]+/[\w.-]+)/(?:issues|pull)/(\d+)/?$")
ISSUE_FULL = re.compile(r"^([\w.-]+/[\w.-]+)#(\d+)$")
ISSUE_SHORT = re.compile(r"^#?(\d+)$")


@dataclass(frozen=True)
class IssueRef:
    repo: str
    number: int

    @property
    def url(self) -> str:
        return f"https://github.com/{self.repo}/issues/{self.number}"

    def label(self, default_repo: str | None) -> str:
        return f"#{self.number}" if self.repo == default_repo else f"{self.repo}#{self.number}"


def parse_issue(value, default_repo: str | None) -> IssueRef:
    """Accept `owner/repo#12`, a GitHub issue URL, or `#12` / `12` for the default repo."""
    text = str(value).strip()
    if match := ISSUE_URL.match(text) or ISSUE_FULL.match(text):
        return IssueRef(match.group(1), int(match.group(2)))
    if match := ISSUE_SHORT.match(text):
        if not default_repo:
            raise RiskError(f"issue {text!r} needs `owner/repo#n` — no default repository is configured")
        return IssueRef(default_repo, int(match.group(1)))
    raise RiskError(f"issue {text!r} is not `owner/repo#n`, `#n` or a GitHub issue URL")


# -- risks ----------------------------------------------------------------


@dataclass
class Mitigation:
    text: str
    status: str
    issues: list[IssueRef]


@dataclass
class Risk:
    id: str
    title: str
    category: str
    status: str
    owner: str | None
    rating: Rating
    residual: Rating | None
    reviewed: dt.date | None
    mitigations: list[Mitigation]
    issues: list[IssueRef]
    body: str
    source: Path

    @property
    def anchor(self) -> str:
        return slug(self.id)

    @property
    def all_issues(self) -> list[IssueRef]:
        refs = list(self.issues)
        for mitigation in self.mitigations:
            refs.extend(mitigation.issues)
        return refs


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")


def natural_key(text: str):
    """Sort `T2` before `T10`."""
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", text)]


def _list(value) -> list:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _rating(meta: dict, scale: Scale) -> Rating:
    for key in ("probability", "impact"):
        if meta.get(key) is None:
            raise RiskError(f"`{key}` is missing")
    return Rating(scale.index("probability", meta["probability"]), scale.index("impact", meta["impact"]), scale)


def _date(value, key: str) -> dt.date | None:
    if value is None or isinstance(value, dt.date):
        return value
    try:
        return dt.date.fromisoformat(str(value))
    except ValueError:
        raise RiskError(f"`{key}` {value!r} is not a date (YYYY-MM-DD)") from None


def parse_risk(path: Path, scale: Scale, categories: dict, default_repo: str | None) -> Risk:
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

    for key in ("id", "title", "category"):
        if not meta.get(key):
            raise RiskError(f"`{key}` is missing")

    category = slug(meta["category"])
    if categories and category not in categories:
        raise RiskError(f"category {meta['category']!r} is not configured ({', '.join(categories)})")

    status = str(meta.get("status", "open")).lower()
    if status not in STATUSES:
        raise RiskError(f"status {status!r} is not one of {', '.join(STATUSES)}")

    residual = meta.get("residual")
    if residual is not None and not isinstance(residual, dict):
        raise RiskError("`residual` must be a mapping with `probability` and `impact`")

    mitigations = []
    for item in _list(meta.get("mitigations")):
        if isinstance(item, str):
            item = {"text": item}
        if not isinstance(item, dict) or not item.get("text"):
            raise RiskError("every mitigation needs a `text`")
        m_status = str(item.get("status", "planned")).lower()
        if m_status not in MITIGATION_STATUSES:
            raise RiskError(f"mitigation status {m_status!r} is not one of {', '.join(MITIGATION_STATUSES)}")
        refs = [parse_issue(v, default_repo) for v in _list(item.get("issue")) + _list(item.get("issues"))]
        mitigations.append(Mitigation(str(item["text"]).strip(), m_status, refs))

    owner = meta.get("owner")
    return Risk(
        id=str(meta["id"]).strip(),
        title=str(meta["title"]).strip(),
        category=category,
        status=status,
        owner=str(owner).strip() if owner not in (None, "", "—", "-") else None,
        rating=_rating(meta, scale),
        residual=_rating(residual, scale) if residual else None,
        reviewed=_date(meta.get("reviewed"), "reviewed"),
        mitigations=mitigations,
        issues=[parse_issue(v, default_repo) for v in _list(meta.get("issues"))],
        body=text[match.end() :].strip(),
        source=path,
    )


def load_risks(directory: Path, scale: Scale, categories: dict, default_repo: str | None):
    """Return `(risks, problems)`; a file with a problem is reported and left out."""
    risks: list[Risk] = []
    problems: list[str] = []
    seen: dict[str, Path] = {}

    for path in sorted(directory.rglob("*.md")):
        try:
            risk = parse_risk(path, scale, categories, default_repo)
        except RiskError as error:
            problems.append(f"{path}: {error}")
            continue
        if risk.id.lower() in seen:
            problems.append(f"{path}: id {risk.id!r} is already used by {seen[risk.id.lower()]}")
            continue
        seen[risk.id.lower()] = path
        risks.append(risk)

    risks.sort(key=lambda r: natural_key(r.id))
    return risks, problems

"""Risk register rendering.

Everything is rendered here as static HTML / Markdown — the PDF renderer runs
no JavaScript, so the matrix, the coloured register and the details must not
depend on it. `risks.js` only adds filtering and sorting on the web.

The output is Markdown with raw HTML blocks, injected into the register page
*before* MkDocs converts it. That way MkDocs validates and rewrites the links in
the risk bodies, builds heading anchors and TOC entries, and indexes every risk
for search.
"""

from __future__ import annotations

import datetime as dt
import posixpath
from dataclasses import dataclass
from html import escape

from .issues import IssueLookup
from .model import STATUSES, IssueRef, Level, Rating, Risk, Scale

ISSUE_STATES = {
    "open": "Open",
    "completed": "Done",
    "not_planned": "Won't do",
    "closed": "Closed",
}


def title_case(text: str) -> str:
    return text[:1].upper() + text[1:]


def rgba(color: str, alpha: float) -> str:
    hex_ = color.lstrip("#")
    if len(hex_) == 3:
        hex_ = "".join(c * 2 for c in hex_)
    try:
        r, g, b = (int(hex_[i : i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return color
    return f"rgba({r}, {g}, {b}, {alpha})"


def attrs(**values) -> str:
    return " ".join(f'{key.replace("_", "-")}="{escape(str(value), quote=True)}"' for key, value in values.items())


@dataclass
class Context:
    risks: list[Risk]
    categories: dict[str, dict]
    """Key -> {"title", "description"}, in display order."""
    scale: Scale
    issues: IssueLookup
    default_repo: str | None
    review_days: int
    backlinks: dict[str, list[tuple[str, str]]]
    """Risk id (lower case) -> [(link relative to the register page, page title)]."""
    today: dt.date

    def is_stale(self, risk: Risk) -> bool:
        if not self.review_days or not risk.reviewed or risk.status == "closed":
            return False
        return (self.today - risk.reviewed).days > self.review_days


# -- small pieces ---------------------------------------------------------


def level_badge(level: Level, text: str | None = None, cls: str = "vt-risk-level") -> str:
    style = f"background:{level.color};color:{level.text_color}"
    return f'<span class="{cls} {cls}--{level.key}" style="{style}">{escape(text or level.name)}</span>'


def status_badge(status: str) -> str:
    return f'<span class="vt-risk-status vt-risk-status--{status}">{escape(title_case(status))}</span>'


def mitigation_badge(status: str) -> str:
    label = title_case(status.replace("-", " "))
    return f'<span class="vt-risk-mitigation vt-risk-mitigation--{status}">{escape(label)}</span>'


def issue_link(ref: IssueRef, ctx: Context) -> str:
    state = ctx.issues.get(ref)
    title = f' title="{escape(state.title, quote=True)}"' if state and state.title else ""
    html = f'<a class="vt-risk-issue" href="{escape(ref.url, quote=True)}"{title}>{escape(ref.label(ctx.default_repo))}</a>'
    if state:
        key = "open" if state.state == "open" else (state.state_reason if state.state_reason in ISSUE_STATES else "closed")
        html += f' <span class="vt-risk-issue-state vt-risk-issue-state--{key}">{ISSUE_STATES[key]}</span>'
    return html


def chip(risk: Risk, rating: Rating) -> str:
    level = rating.level
    style = f"background:{level.color};color:{level.text_color}"
    title = escape(f"{risk.id} — {risk.title}", quote=True)
    return f'<a class="vt-risk-chip" href="#{risk.anchor}" title="{title}" style="{style}">{escape(risk.id)}</a>'


def rating_text(rating: Rating) -> str:
    return (
        f"{escape(title_case(rating.probability_label))} × "
        f"{escape(title_case(rating.impact_label))} → {level_badge(rating.level)}"
    )


def cell(text: str) -> str:
    """Make text safe for one Markdown table cell."""
    return " ".join(text.split()).replace("|", "\\|")


# -- overview -------------------------------------------------------------


def summary(ctx: Context) -> str:
    active = [r for r in ctx.risks if r.status != "closed"]
    parts = [f'<span class="vt-risk-summary__total">{len(active)} active risk{"s" if len(active) != 1 else ""}</span>']
    for level in reversed(ctx.scale.levels):
        count = sum(1 for r in active if r.rating.level == level)
        parts.append(level_badge(level, f"{count} {level.name}"))
    closed = len(ctx.risks) - len(active)
    if closed:
        parts.append(f'<span class="vt-risk-summary__closed">{closed} closed</span>')
    stale = sum(1 for r in ctx.risks if ctx.is_stale(r))
    if stale:
        parts.append(f'<span class="vt-risk-summary__stale">{stale} overdue for review</span>')
    return f'<p class="vt-risk-summary">{" ".join(parts)}</p>'


def matrix(ctx: Context, which: str, caption: str) -> str:
    scale = ctx.scale
    rated = [r for r in ctx.risks if r.status != "closed" and getattr(r, which)]
    rows = []

    for p in range(len(scale.probability), 0, -1):
        cells = [f'<th scope="row">{escape(title_case(scale.probability[p - 1]))}</th>']
        for i in range(1, len(scale.impact) + 1):
            level = scale.level(p * i)
            chips = " ".join(chip(r, getattr(r, which)) for r in rated if (getattr(r, which).probability, getattr(r, which).impact) == (p, i))
            label = f"{title_case(scale.probability[p - 1])} probability, {scale.impact[i - 1]} impact: {level.name}"
            cells.append(
                f'<td class="vt-risk-matrix__cell" {attrs(data_p=p, data_i=i, title=label)} '
                f'style="background:{rgba(level.color, 0.22)}">{chips}</td>'
            )
        rows.append(f"<tr>{''.join(cells)}</tr>")

    impact_heads = "".join(f'<th scope="col">{escape(title_case(label))}</th>' for label in scale.impact)
    rows.append(f'<tr><td class="vt-risk-matrix__corner"></td>{impact_heads}</tr>')
    rows.append(f'<tr><td></td><th class="vt-risk-matrix__axis" colspan="{len(scale.impact)}">Impact →</th></tr>')

    count = len(rated)
    return (
        f'<figure class="vt-risk-matrix" data-matrix="{which}">'
        f'<figcaption>{escape(caption)} <span class="vt-risk-matrix__count">({count} risk{"s" if count != 1 else ""})</span></figcaption>'
        f'<table class="vt-risk-matrix__grid"><tr><th class="vt-risk-matrix__axis vt-risk-matrix__axis--p">Probability ↑</th><td colspan="{len(scale.impact)}"></td></tr>'
        f"{''.join(rows)}</table></figure>"
    )


def register_table(ctx: Context) -> str:
    order = {risk.id: n for n, risk in enumerate(ctx.risks)}
    head = (
        '<thead><tr><th data-sort="order">ID</th><th data-sort="title">Risk</th><th data-sort="status">Status</th>'
        '<th data-sort="p">Prob.</th><th data-sort="i">Impact</th><th data-sort="score">Level</th>'
        '<th data-sort="residual">Residual</th><th data-sort="owner">Owner</th></tr></thead>'
    )
    rows = []
    for risk in ctx.risks:
        rating, residual = risk.rating, risk.residual
        category = ctx.categories.get(risk.category, {}).get("title", title_case(risk.category))
        search = " ".join([risk.id, risk.title, category, risk.status, risk.owner or ""]).lower()
        data = attrs(
            data_risk=risk.id,
            data_category=risk.category,
            data_category_label=category,
            data_status=risk.status,
            data_level=rating.level.key,
            data_level_label=rating.level.name,
            data_owner=risk.owner or "",
            data_p=rating.probability,
            data_i=rating.impact,
            data_rp=residual.probability if residual else "",
            data_ri=residual.impact if residual else "",
            data_search=search,
            data_order=order[risk.id],
            data_score=rating.score,
            data_residual=residual.score if residual else 0,
        )
        stale = ' <span class="vt-risk-stale" title="Review overdue">review</span>' if ctx.is_stale(risk) else ""
        rows.append(
            f"<tr {data}>"
            f'<td class="vt-risk-table__id"><a href="#{risk.anchor}">{escape(risk.id)}</a></td>'
            f'<td><a href="#{risk.anchor}">{escape(risk.title)}</a></td>'
            f'<td {attrs(data_value=STATUSES.index(risk.status))}>{status_badge(risk.status)}{stale}</td>'
            f"<td>{escape(title_case(rating.probability_label))}</td>"
            f"<td>{escape(title_case(rating.impact_label))}</td>"
            f"<td>{level_badge(rating.level)}</td>"
            f"<td>{level_badge(residual.level) if residual else '—'}</td>"
            f'<td>{escape(risk.owner or "—")}</td>'
            "</tr>"
        )
    return (
        '<div class="vt-risk-register" data-vt-risk-register>'
        f'<table class="vt-risk-table">{head}<tbody>{"".join(rows)}</tbody></table></div>'
    )


# -- details --------------------------------------------------------------


def facts(risk: Risk, ctx: Context) -> str:
    items = [
        ("Status", status_badge(risk.status)),
        ("Probability × impact", rating_text(risk.rating)),
        ("Residual", rating_text(risk.residual) if risk.residual else "not assessed"),
        ("Owner", escape(risk.owner or "unassigned")),
    ]
    reviewed = risk.reviewed.isoformat() if risk.reviewed else "never"
    if ctx.is_stale(risk):
        reviewed += ' <span class="vt-risk-stale">overdue</span>'
    items.append(("Reviewed", reviewed))
    head = "".join(f"<th>{label}</th>" for label, _ in items)
    body = "".join(f"<td>{value}</td>" for _, value in items)
    return f'<table class="vt-risk-facts"><tr>{head}</tr><tr>{body}</tr></table>'


def details(risk: Risk, ctx: Context) -> str:
    parts = [
        f"### {risk.id} — {risk.title} {{#{risk.anchor} .vt-risk-heading}}",
        facts(risk, ctx),
    ]
    if risk.body:
        parts.append(risk.body)

    if risk.mitigations:
        with_issues = any(m.issues for m in risk.mitigations)
        lines = ["**Mitigations**", ""]
        lines.append("| Status | Mitigation |" + (" Issue |" if with_issues else ""))
        lines.append("|---|---|" + ("---|" if with_issues else ""))
        for m in risk.mitigations:
            row = f"| {mitigation_badge(m.status)} | {cell(m.text)} |"
            if with_issues:
                row += " " + (", ".join(issue_link(ref, ctx) for ref in m.issues) or "—") + " |"
            lines.append(row)
        parts.append("\n".join(lines))

    if risk.issues:
        parts.append("**Linked issues:** " + ", ".join(issue_link(ref, ctx) for ref in risk.issues))

    refs = ctx.backlinks.get(risk.id.lower())
    if refs:
        parts.append("**Referenced from:** " + ", ".join(f"[{title}]({href})" for href, title in refs))

    return "\n\n".join(parts)


# -- register -------------------------------------------------------------


def register(ctx: Context) -> str:
    if not ctx.risks:
        return '<p class="vt-risk-summary">No risks recorded.</p>'

    has_residual = any(r.residual for r in ctx.risks)
    matrices = matrix(ctx, "rating", "Current")
    if has_residual:
        matrices += matrix(ctx, "residual", "After mitigation")

    parts = [
        "## Overview {#risk-overview .vt-risk-overview}",
        summary(ctx),
        f'<div class="vt-risk-matrices">{matrices}</div>',
        register_table(ctx),
    ]

    for key, category in ctx.categories.items():
        members = [r for r in ctx.risks if r.category == key]
        if not members:
            continue
        parts.append(f"## {category['title']} {{#risks-{key} .vt-risk-category}}")
        if category.get("description"):
            parts.append(category["description"])
        parts.extend(details(r, ctx) for r in members)

    return "\n\n".join(parts) + "\n"


def reference(risk: Risk, href: str) -> str:
    """Inline `[[ID]]` reference: a coloured badge linking to the risk."""
    level = risk.rating.level
    style = f"background:{level.color};color:{level.text_color}"
    title = f"{risk.id} — {risk.title} ({level.name})".replace('"', "'")
    return f'[<span class="vt-risk-ref" style="{style}">{escape(risk.id)}</span>]({href} "{title}")'


def relative(target: str, page: str) -> str:
    """Link from page `page` to docs file `target` (both src URIs)."""
    return posixpath.relpath(target, posixpath.dirname(page) or ".")

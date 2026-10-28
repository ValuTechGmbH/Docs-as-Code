"""Optional build-time lookup of GitHub issue states.

Only runs when a token is available in the configured environment variable.
Without one — or when GitHub is unreachable, the token lacks access, or the
rate limit is hit — issues render as plain links. A lookup problem never fails
the build: the register is still correct without the state badges.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from .model import IssueRef

log = logging.getLogger("mkdocs.plugins.valutech-risks")


@dataclass(frozen=True)
class IssueState:
    state: str
    """`open` or `closed`."""
    state_reason: str | None
    """`completed`, `not_planned`, `reopened` or None."""
    title: str


class IssueLookup:
    def __init__(self, token: str | None, api_url: str = "https://api.github.com", timeout: float = 5.0):
        self._token = token
        self._api_url = api_url.rstrip("/")
        self._timeout = timeout
        self._cache: dict[IssueRef, IssueState | None] = {}

    @property
    def enabled(self) -> bool:
        return bool(self._token)

    def prefetch(self, refs) -> None:
        todo = sorted({ref for ref in refs if ref not in self._cache}, key=lambda r: (r.repo, r.number))
        if not self.enabled or not todo:
            return

        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(self._fetch, todo))

        failed = [ref for ref, state in zip(todo, results) if state is None]
        for ref, state in zip(todo, results):
            self._cache[ref] = state
        if failed:
            log.info(
                "Could not read %d of %d linked issue(s) — they render as plain links: %s",
                len(failed),
                len(todo),
                ", ".join(f"{r.repo}#{r.number}" for r in failed),
            )

    def get(self, ref: IssueRef) -> IssueState | None:
        return self._cache.get(ref)

    def _fetch(self, ref: IssueRef) -> IssueState | None:
        request = urllib.request.Request(
            f"{self._api_url}/repos/{ref.repo}/issues/{ref.number}",
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self._token}",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "valutech-docs-risks",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                data = json.load(response)
        except urllib.error.HTTPError as error:
            # 404 also means "exists, but the token cannot see it".
            log.debug("Issue %s#%s: HTTP %s", ref.repo, ref.number, error.code)
            return None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
            log.debug("Issue %s#%s: %s", ref.repo, ref.number, error)
            return None
        return IssueState(data.get("state", "open"), data.get("state_reason"), data.get("title") or "")

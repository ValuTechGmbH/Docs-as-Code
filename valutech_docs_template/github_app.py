#!/usr/bin/env python3
"""Register the docs-comments GitHub App and collect everything the API needs.

There is no REST endpoint that creates a GitHub App, but the manifest flow gets
within one click of it: this script serves a page that POSTs a prepared manifest
to GitHub, catches the redirect, and exchanges the temporary code for the App's
id and private key. It then waits for the App to be installed and reads the
installation id, so all three application settings come out of one run.

    valutech-docs-github-app \
        --org geobrugg-sentra --repo sentra-system-docs \
        --site-url https://docs.example.com

Interrupted after the App was created? Skip straight to the installation lookup:

    valutech-docs-github-app --app-id 123456 --pem ./<slug>.private-key.pem

Nothing is printed to the terminal that would leak the private key; it is written
to a 0600 file next to a ready-to-run Azure CLI command.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

GITHUB_API = "https://api.github.com"
API_VERSION = "2022-11-28"


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def api(path: str, *, method: str = "GET", token: str | None = None, jwt: str | None = None):
    request = urllib.request.Request(f"{GITHUB_API}{path}", method=method)
    request.add_header("accept", "application/vnd.github+json")
    request.add_header("x-github-api-version", API_VERSION)
    request.add_header("user-agent", "valutech-docs-app-setup")
    if token:
        request.add_header("authorization", f"token {token}")
    if jwt:
        request.add_header("authorization", f"Bearer {jwt}")

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise SystemExit(f"GitHub API {error.code} on {method} {path}: {detail}") from error


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def app_jwt(app_id: str, pem_path: Path) -> str:
    """Sign a short-lived App JWT. Uses openssl so the script stays dependency-free."""
    now = int(time.time())
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(
        json.dumps({"iat": now - 60, "exp": now + 540, "iss": str(app_id)}, separators=(",", ":")).encode()
    )
    signing_input = f"{header}.{payload}".encode()

    result = subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", str(pem_path)],
        input=signing_input,
        capture_output=True,
    )
    if result.returncode != 0:
        raise SystemExit(f"openssl could not sign with {pem_path}: {result.stderr.decode().strip()}")

    return f"{header}.{payload}.{b64url(result.stdout)}"


# --------------------------------------------------------------------------- #
# manifest flow
# --------------------------------------------------------------------------- #

def build_manifest(args, redirect_url: str) -> dict:
    homepage = args.site_url or f"https://github.com/{args.org}/{args.repo}"
    return {
        "name": args.name,
        "description": (
            "Opens one issue per reader comment submitted from the documentation site."
        ),
        "url": homepage,
        "redirect_url": redirect_url,
        "public": False,
        # No webhooks: the App only ever acts on requests from the docs API.
        "hook_attributes": {"url": f"{homepage.rstrip('/')}/unused-webhook", "active": False},
        "default_events": [],
        "default_permissions": {"issues": "write", "metadata": "read"},
        "request_oauth_on_install": False,
    }


FORM_PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>Create the GitHub App</title></head>
<body style="font-family: system-ui, sans-serif; margin: 4rem auto; max-width: 34rem">
<h1>Create the GitHub App</h1>
<p>Sending the prepared manifest to GitHub&nbsp;&mdash; review the form there and press
<strong>Create GitHub App</strong>.</p>
<form id="f" method="post" action="{action}">
  <input type="hidden" name="manifest" value='{manifest}'>
  <noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script>document.getElementById("f").submit();</script>
</body></html>
"""

DONE_PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>App created</title></head>
<body style="font-family: system-ui, sans-serif; margin: 4rem auto; max-width: 34rem">
<h1>{heading}</h1>
<p>{message}</p>
</body></html>
"""


def run_manifest_flow(args) -> dict:
    state = secrets.token_urlsafe(16)
    redirect_url = f"http://localhost:{args.port}/callback"
    manifest = build_manifest(args, redirect_url)
    action = f"https://github.com/organizations/{args.org}/settings/apps/new?state={state}"

    outcome: dict = {}
    finished = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, body: str) -> None:
            encoded = body.encode()
            self.send_response(status)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self) -> None:
            parsed = urlparse(self.path)

            if parsed.path == "/":
                return self._send(
                    200,
                    FORM_PAGE.format(
                        action=action,
                        # Single quotes wrap the attribute, so only those need escaping.
                        manifest=json.dumps(manifest).replace("'", "&#39;"),
                    ),
                )

            if parsed.path != "/callback":
                return self._send(404, DONE_PAGE.format(heading="Not found", message=""))

            query = parse_qs(parsed.query)
            if query.get("state", [""])[0] != state:
                outcome["error"] = "state mismatch — the redirect did not come from this run"
                self._send(400, DONE_PAGE.format(heading="Rejected", message=outcome["error"]))
                finished.set()
                return

            code = query.get("code", [""])[0]
            if not code:
                outcome["error"] = "GitHub redirected without a code (App creation cancelled?)"
                self._send(400, DONE_PAGE.format(heading="Cancelled", message=outcome["error"]))
                finished.set()
                return

            try:
                outcome["app"] = api(f"/app-manifests/{code}/conversions", method="POST")
            except SystemExit as error:
                outcome["error"] = str(error)
                self._send(502, DONE_PAGE.format(heading="Conversion failed", message=str(error)))
                finished.set()
                return

            self._send(
                200,
                DONE_PAGE.format(
                    heading="App created",
                    message="Back to the terminal — the private key has been saved for you.",
                ),
            )
            finished.set()

        def log_message(self, *_args) -> None:  # keep the terminal readable
            pass

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    start_url = f"http://localhost:{args.port}/"
    print(f"Opening {start_url}")
    print("  (if no browser opens, visit that URL yourself)")
    webbrowser.open(start_url)

    if not finished.wait(timeout=args.timeout):
        server.shutdown()
        raise SystemExit(f"Timed out after {args.timeout}s waiting for GitHub to redirect back.")

    server.shutdown()

    if "error" in outcome:
        raise SystemExit(f"Error: {outcome['error']}")

    return outcome["app"]


# --------------------------------------------------------------------------- #
# installation
# --------------------------------------------------------------------------- #

def wait_for_installation(app_id: str, pem_path: Path, slug: str | None, timeout: int) -> dict:
    if slug:
        install_url = f"https://github.com/apps/{slug}/installations/new"
        print(f"\nInstall the App on the docs repository: {install_url}")
        webbrowser.open(install_url)
    else:
        print("\nInstall the App on the docs repository, then this will continue.")

    print("Waiting for the installation to appear", end="", flush=True)
    deadline = time.time() + timeout

    while time.time() < deadline:
        installations = api("/app/installations", jwt=app_jwt(app_id, pem_path))
        if installations:
            print()
            return installations[0]
        print(".", end="", flush=True)
        time.sleep(3)

    print()
    raise SystemExit(
        "Timed out waiting for the installation. Once installed, re-run with "
        f"--app-id {app_id} --pem {pem_path}"
    )


# --------------------------------------------------------------------------- #
# output
# --------------------------------------------------------------------------- #

def write_secrets(out_dir: Path, slug: str, app_id: str, installation_id: str, pem: str, site_url: str, repo: str) -> tuple[Path, Path]:
    pem_path = out_dir / f"{slug}.private-key.pem"
    pem_path.write_text(pem, encoding="utf-8")
    pem_path.chmod(0o600)

    # Application settings are single-line, so the PEM travels with escaped newlines.
    one_line = pem.replace("\n", "\\n")
    script_path = out_dir / f"set-swa-appsettings-{slug}.sh"
    script_path.write_text(
        "#!/usr/bin/env bash\n"
        "# Generated by create-github-app.py — contains the App private key.\n"
        "# Set SWA_NAME (and SWA_RESOURCE_GROUP) first; find them with:\n"
        "#   az staticwebapp list -o table\n"
        "set -euo pipefail\n\n"
        ': "${SWA_NAME:?set SWA_NAME to the Static Web App name}"\n\n'
        "az staticwebapp appsettings set \\\n"
        '  --name "$SWA_NAME" \\\n'
        '  ${SWA_RESOURCE_GROUP:+--resource-group "$SWA_RESOURCE_GROUP"} \\\n'
        "  --setting-names \\\n"
        f"    GITHUB_APP_ID='{app_id}' \\\n"
        f"    GITHUB_APP_INSTALLATION_ID='{installation_id}' \\\n"
        f"    GITHUB_APP_PRIVATE_KEY='{one_line}'"
        + (f" \\\n    GITHUB_REPO='{repo}'" if repo else "")
        + (f" \\\n    DOCS_SITE_URL='{site_url}'" if site_url else "")
        + "\n"
        + ("" if repo else "\n# GITHUB_REPO was not known here -- add it as owner/name.\n"),
        encoding="utf-8",
    )
    script_path.chmod(0o700)
    return pem_path, script_path


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="valutech-docs-github-app",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--org", help="organisation that will own the App")
    parser.add_argument("--repo", help='docs repository as "owner/name" or just "name" with --org')
    parser.add_argument("--name", help="App name, shown as the issue author (default: <repo>-comments)")
    parser.add_argument("--site-url", default="", help="documentation site root (DOCS_SITE_URL)")
    parser.add_argument("--port", type=int, default=8912, help="local callback port (default: 8912)")
    parser.add_argument("--out", default=".", help="directory for the key and the Azure CLI script")
    parser.add_argument("--timeout", type=int, default=600, help="seconds to wait for each browser step")
    parser.add_argument("--app-id", help="skip creation: look up the installation of this App")
    parser.add_argument("--pem", help="private key of an existing App, with --app-id")
    args = parser.parse_args()

    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    # -- resume mode ------------------------------------------------------- #
    if args.app_id or args.pem:
        if not (args.app_id and args.pem):
            raise SystemExit("--app-id and --pem must be given together.")
        pem_path = Path(args.pem).resolve()
        if not pem_path.exists():
            raise SystemExit(f"No such private key: {pem_path}")

        app = api("/app", jwt=app_jwt(args.app_id, pem_path))
        installation = wait_for_installation(args.app_id, pem_path, app.get("slug"), args.timeout)
        repo = args.repo or ""
        _, script_path = write_secrets(
            out_dir, app.get("slug", "app"), args.app_id, str(installation["id"]),
            pem_path.read_text(encoding="utf-8"), args.site_url, repo,
        )
        print(f"\nApp ID          {args.app_id}")
        print(f"Installation ID {installation['id']}")
        print(f"Private key     {pem_path}")
        print(f"Azure settings  {script_path}")
        return

    # -- full flow --------------------------------------------------------- #
    if not args.org or not args.repo:
        raise SystemExit("--org and --repo are required (or use --app-id with --pem).")

    repo_full = args.repo if "/" in args.repo else f"{args.org}/{args.repo}"
    args.name = args.name or f"{repo_full.split('/')[-1]}-comments"
    if len(args.name) > 34:
        raise SystemExit(f"App names are limited to 34 characters: {args.name!r} is {len(args.name)}")

    app = run_manifest_flow(args)
    app_id, slug, pem = str(app["id"]), app["slug"], app["pem"]
    print(f"\nCreated “{app['name']}” ({app['html_url']})")

    pem_path = out_dir / f"{slug}.private-key.pem"
    pem_path.write_text(pem, encoding="utf-8")
    pem_path.chmod(0o600)

    installation = wait_for_installation(app_id, pem_path, slug, args.timeout)

    _, script_path = write_secrets(
        out_dir, slug, app_id, str(installation["id"]), pem, args.site_url, repo_full
    )

    print(f"\nApp ID          {app_id}")
    print(f"Installation ID {installation['id']}")
    print(f"Repository      {repo_full}")
    print(f"Private key     {pem_path}")
    print(f"Azure settings  {script_path}")
    print("\nNext: SWA_NAME=<static-web-app> " + str(script_path))
    print("Then delete both files once the settings are in place — they hold the private key.")


if __name__ == "__main__":
    main()

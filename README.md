# ValuTech Docs-as-Code Template

MkDocs documentation template with Material theme and PDF export, packaged for reuse across ValuTech projects.

## Features

- **Material for MkDocs** theme with light/dark mode
- **Page comments** — readers comment on a page, each comment opens a GitHub issue
- **Risk register** — one Markdown file per risk, rendered as matrix, filterable register and PDF chapter
- **PDF export** via `mkdocs-with-pdf` (optional, env-gated)
- **Custom PDF styling** — branded cover page, headers, footers
- **Python package** — installable via `pip` for consuming projects
- **CLI tool** — `valutech-docs-init` generates the base config with resolved paths
- **GitHub Actions** — automated package build and publish on tag

## Quick Start (Standalone)

```bash
# Clone this repo
git clone <repo-url>
cd Docs-as-Code

# Create a virtual environment
python -m venv .venv
source .venv/bin/activate

# Install
pip install -e .

# Serve locally
mkdocs serve
```

Open http://127.0.0.1:8000 to preview.

## Using in a Consuming Project

### 1. Create `pyproject.toml`

Add the template as a dependency in your project's `pyproject.toml`:

```toml
[project]
name = "my-super-docs"
dynamic = ["version"]
dependencies = [
    "valutech-docs-template @ git+https://github.com/ValuTechGmbH/Docs-as-Code.git@main",
]
```

### 2. Create a virtual environment and install

(use WSL on Windows)

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

This pulls in all required MkDocs dependencies (`mkdocs`, `mkdocs-material`, `mkdocs-with-pdf`).

### 3. Generate the base config

```bash
valutech-docs-init
```

This creates `.valutech-docs-base.yml` in the current directory with all paths resolved to the installed package location. This file is gitignored and must be regenerated after reinstalling the package.

### 4. Create your `mkdocs.yaml`

```yaml
INHERIT: .valutech-docs-base.yml

site_name: "My Project"
site_description: "Documentation for My Project"
docs_dir: "content"

theme:
  logo: assets/images/logo.png
  favicon: assets/images/favicon.png

extra_css:
  - stylesheets/extra.css

nav:
  - Home: index.md
  - Setup: setup.md
  - API: api.md
```

### 5. Build

```bash
# Local dev server
mkdocs serve

# HTML only
mkdocs build

# HTML + PDF
ENABLE_PDF_EXPORT=1 mkdocs build
```

## Page Comments

Readers can comment on any page; every comment opens one GitHub issue in the
documentation repository, and the page shows the existing comments with their
state. Closing the issue is what marks a comment as handled — *Close as
completed* renders as **Resolved**, *close as not planned* as **Won't do**.

It is built for a site hosted on **Azure Static Web Apps with authentication**,
which is what makes it usable for private documentation: the GitHub-issue
comment widgets (utterances, giscus) all require a public repository, this does
not. The issues are opened by a GitHub App; the commenter's GitHub handle comes
from the Static Web Apps session and is recorded in the issue body, so
commenters need a GitHub account but **no access to the private repository**.

### 1. Create the GitHub App

There is no API that creates a GitHub App, but the bundled command drives
GitHub's manifest flow, which comes within one click of it — and hands back the
private key instead of making you download a `.pem`:

```bash
valutech-docs-github-app \
    --org geobrugg-sentra \
    --repo sentra-system-docs \
    --site-url https://docs.example.com
```

It opens a page that posts a prepared manifest (name, `Issues: write`, no
webhooks, not public) to GitHub. Press **Create GitHub App**, and the command
catches the redirect, exchanges the code, then opens the install page and waits
for you to install the App on the docs repository. It ends with:

```
App ID          123456
Installation ID 78901234
Private key     ./<slug>.private-key.pem          (0600)
Azure settings  ./set-swa-appsettings-<slug>.sh   (0700)
```

Requirements: you must be an **owner/admin of the organisation**, and `openssl`
must be on PATH (it signs the App JWT used to read the installation id).
Interrupted after the App was created? Resume the lookup with
`valutech-docs-github-app --app-id <id> --pem <path>`. Delete both generated
files once the settings are in place — they contain the private key.

<details>
<summary>Doing it by hand instead</summary>

Organisation **Settings → Developer settings → GitHub Apps → New GitHub App**:

| Field | Value |
|-------|-------|
| Name | e.g. `<project>-docs-comments` (shows as the issue author) |
| Homepage URL | the documentation site URL |
| Webhook | uncheck **Active** |
| Repository permissions | **Issues: Read and write** |
| Installation | Only on this account → install on the docs repository |

Note the **App ID**, generate and download a **private key**, and take the
**installation ID** from the URL of *Settings → GitHub Apps → your app →
Configure* (`.../installations/<installation-id>`).

</details>

### 2. Configure the Static Web App

Run the `set-swa-appsettings-<slug>.sh` written by the previous step
(`SWA_NAME=<static-web-app> ./set-swa-appsettings-<slug>.sh`), or set these by
hand under **Configuration → Application settings** in the Azure Portal:

| Setting | Value |
|---------|-------|
| `GITHUB_APP_ID` | numeric App ID |
| `GITHUB_APP_INSTALLATION_ID` | numeric installation ID |
| `GITHUB_APP_PRIVATE_KEY` | contents of the `.pem` (newlines may be written as `\n`) |
| `GITHUB_REPO` | `owner/name` of the docs repository |
| `DOCS_SITE_URL` | site root, used for the page link in the issue (optional) |
| `GITHUB_COMMENT_LABEL` | label applied to comment issues (optional, default `docs-comment`) |

Restrict the API to signed-in readers in `staticwebapp.config.json`, and pin the
runtime:

```json
{
  "routes": [
    { "route": "/api/*", "allowedRoles": ["reader"] }
  ],
  "platform": { "apiRuntime": "node:20" }
}
```

### 3. Enable it in the project

`mkdocs.yaml`:

```yaml
site_url: https://docs.example.com   # canonical URLs; the issue's page link uses DOCS_SITE_URL

plugins:
  valutech-comments:
    api_base: /api/comments
```

Deploy workflow — generate the API next to the base config and point Static Web
Apps at it:

```yaml
- name: Generate base MkDocs config and comment API
  run: valutech-docs-init --with-api

# ...
- uses: Azure/static-web-apps-deploy@v1
  with:
    app_location: "site"
    api_location: "api"
    skip_app_build: true
    skip_api_build: true   # the function has no dependencies to build
```

`api/` is generated, so add it to `.gitignore` alongside
`.valutech-docs-base.yml`.

### Options

| Plugin option | Default | Purpose |
|---------------|---------|---------|
| `enabled` | `true` | Master switch |
| `api_base` | `/api/comments` | Endpoint the widget talks to |
| `title` | `Comments` | Heading above the widget |
| `intro` | *(see plugin)* | Sentence below the heading |
| `kinds` | `Unclear, Incorrect, Missing, Typo, Suggestion` | Choices in the *Kind* dropdown; empty list hides it |

Per page, `comments: false` in the front matter opts a page out. The widget is
skipped automatically during `ENABLE_PDF_EXPORT` builds, and hides itself when
the API is unreachable — so a plain `mkdocs serve` shows the site without it.

Run the API's unit checks with `node tests/comments-api.smoke.js`.

## Risk Register

A risk register kept as one Markdown file per risk. The plugin renders it into
one page: a summary, a risk matrix (current and, where rated, after
mitigation), a filterable and sortable register table, and then every risk
written out with its mitigations and linked issues. Everything is static HTML,
so the PDF gets the same overview and details; the browser only adds the
filters (search, category, status, owner, level, click a matrix cell), whose
state is kept in the URL.

### Risk files

Risks live **outside** `docs_dir` — by default in `risks/` next to
`mkdocs.yaml` — so MkDocs does not treat them as pages. File names are free;
the `id` in the front matter is what counts and must be unique.

```markdown
---
id: T2
title: Energy budget does not close
category: technical          # a key from `categories`
status: mitigating           # open | mitigating | accepted | occurred | closed
owner: Jane Doe              # optional
probability: high            # label from the scale, or its 1-based number
impact: high
residual:                    # optional: expected rating after the mitigations
  probability: medium
  impact: high
reviewed: 2026-10-20         # optional: last review, drives the "overdue" badge
mitigations:
  - text: Measure per-phase energy as soon as mesh and uplink integrate.
    status: in-progress      # planned (default) | in-progress | done | dropped
    issue: geobrugg-sentra/mainboard-firmware#42
  - Publish the budget.      # a plain string is a planned mitigation
issues: ["#17"]              # risk-level issues; quote `#n`, YAML reads # as a comment
---
Description and reasoning, in Markdown.
```

The risk **level is computed** from probability × impact and the configured
`levels` — it is never written in the file, so it cannot drift from the scores.

Write links in a risk body as if it were in the register page, e.g.
`[Battery & Power](../03-hardware/06-battery-and-power.md)` when the register is
`08-project/02-risks.md`; MkDocs validates them like any other link. Don't use
`#`/`##`/`###` headings in a risk body — the register uses them.

Issue references take `owner/repo#12`, a GitHub issue URL, or `#12` / `12` for
the default repository (`issues.repo`).

### Enable it

Put the marker where the register belongs:

```markdown
# Risks

Intro text.

<!-- valutech:risk-register -->
```

and enable the plugin in `mkdocs.yaml`:

```yaml
plugins:
  valutech-risks:
    dir: risks
    categories:
      technical:
        title: Technical
        description: Risks in what is being built.
      product: Product and process      # title only
    review_days: 90
    issues:
      repo: owner/docs-repo
      token_env: RISKS_GITHUB_TOKEN
```

Anywhere in the docs, `[[T2]]` becomes a coloured badge linking to risk T2,
and the risk lists the pages that reference it. References inside code are left
alone; an unknown ID is a build warning.

### Issue state

With a GitHub token in the environment variable named by `issues.token_env`,
the build reads each linked issue and shows its state next to the link (Open /
Done / Won't do / Closed). Without a token — or when an issue cannot be read —
the issues are plain links and the build carries on. For issues in other
repositories than the docs repository, the token needs read access to them
(a fine-grained PAT or GitHub App token with *Issues: read*); the workflow's
default `GITHUB_TOKEN` only covers its own repository.

```yaml
- name: Build documentation
  run: mkdocs build --clean
  env:
    RISKS_GITHUB_TOKEN: ${{ secrets.RISKS_GITHUB_TOKEN }}   # optional
```

### Options

| Plugin option | Default | Purpose |
|---------------|---------|---------|
| `enabled` | `true` | Master switch |
| `dir` | `risks` | Risk files, relative to `mkdocs.yaml` |
| `marker` | `<!-- valutech:risk-register -->` | Where the register is inserted |
| `probability` | `[low, medium, high]` | Probability scale, lowest first |
| `impact` | `[low, medium, high]` | Impact scale, lowest first |
| `levels` | Low ≤ 2, Medium ≤ 4, High | `{name, max, color}` list by ascending `max` (score = probability × impact, 1-based); the last may omit `max` |
| `categories` | *(from the risks)* | Key → title, or → `{title, description}`; sets the order of sections |
| `review_days` | `0` (off) | Mark risks whose `reviewed` date is older as overdue |
| `issues.repo` | from `repo_url` | Repository for `#12` references |
| `issues.token_env` | `GITHUB_TOKEN` | Environment variable holding the token |
| `issues.lookup` | `true` | Set `false` to never query GitHub |
| `export_json` | `true` | Write `risks.json` (all risks, computed levels, issue states) to the site root |

A 5×5 scale, for example:

```yaml
    probability: [rare, unlikely, possible, likely, almost certain]
    impact: [negligible, minor, moderate, major, severe]
    levels:
      - { name: Low, max: 4, color: "#2e7d32" }
      - { name: Medium, max: 9, color: "#f9a825" }
      - { name: High, max: 16, color: "#ef6c00" }
      - { name: Critical, color: "#c62828" }
```

Problems in a risk file (unknown scale value, duplicate id, bad issue
reference, …) are build warnings naming the file, and that risk is left out —
run `mkdocs build --strict` in CI to fail on them.

Run the plugin tests with `python -m unittest tests/test_risks.py`.

## Build Commands

| Command | Description |
|---------|-------------|
| `mkdocs serve` | Start live-reload dev server on http://127.0.0.1:8000 |
| `mkdocs build` | Build static HTML site to `site/` |
| `ENABLE_PDF_EXPORT=1 mkdocs build` | Build HTML + PDF |
| `python -m build` | Build the Python package (sdist + wheel) |

## PDF Export

PDF generation requires **WeasyPrint** native dependencies:

| OS | Command |
|----|---------|
| macOS | `brew install pango` |
| Ubuntu/Debian | `sudo apt install libpango-1.0-0 libpangocairo-1.0-0` |
| Windows | Use WSL or CI pipeline |

## Project Structure

```
.
├── mkdocs.yml                          # Standalone dev config (inherits from package)
├── pyproject.toml                      # Python package definition
├── docs/                               # Documentation source (Markdown)
│   ├── index.md
│   ├── getting-started/
│   ├── architecture/
│   ├── api-reference/
│   ├── guides/
│   ├── assets/images/                  # Logos and images
│   └── stylesheets/extra.css           # Custom CSS
├── valutech_docs_template/             # Python package (for pip install)
│   ├── __init__.py
│   ├── cli.py                          # valutech-docs-init entry point
│   ├── github_app.py                   # valutech-docs-github-app entry point
│   ├── mkdocs-base.yml                 # Base config template
│   ├── plugins/comments.py             # Page comments MkDocs plugin
│   ├── plugins/risks/                  # Risk register MkDocs plugin
│   ├── web/assets/valutech/            # Comment widget and risk register CSS + JS
│   ├── api/                            # Comment API (Static Web Apps function)
│   └── overrides/pdf/                  # PDF cover page and styles
│       ├── cover.html
│       └── styles.scss
├── .github/workflows/build.yml         # CI/CD pipeline
└── .vscode/tasks.json                  # VS Code build tasks
```

## CI/CD

The GitHub Actions workflow (`.github/workflows/build.yml`) provides:

- **Tag push (`v*`)** — builds the Python package and publishes it
- **Manual trigger** — builds and tests the documentation site

### Setup

1. Configure a `PYPI_TOKEN` secret in your repository settings (for package publishing)
2. Configure a `PYPI_REPOSITORY_URL` variable pointing to your package registry
3. Push a tag to trigger a release: `git tag v0.1.0 && git push --tags`

## Customization

### Changing the theme colors

Edit `mkdocs.yml` under `theme.palette`:

```yaml
palette:
  - scheme: default
    primary: indigo   # Change to your brand color
    accent: indigo
```

### Replacing logos

Replace the files in `docs/assets/images/`:

- `logo.png` — header logo (web)
- `favicon.png` — browser tab icon
- `logo-pdf.png` — small logo for PDF page headers

### Modifying the PDF cover

Edit `valutech_docs_template/overrides/pdf/cover.html` for layout and `valutech_docs_template/overrides/pdf/styles.scss` for page headers/footers.

## License

Internal use — ValuTech GmbH.

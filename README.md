# ValuTech Docs-as-Code Template

MkDocs documentation template with Material theme and PDF export, packaged for reuse across ValuTech projects.

## Features

- **Material for MkDocs** theme with light/dark mode
- **Page comments** — readers comment on a page, each comment opens a GitHub issue
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
│   ├── web/assets/valutech/            # Comment widget CSS + JS
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

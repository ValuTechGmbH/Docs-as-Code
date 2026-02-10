# ValuTech Docs-as-Code Template

MkDocs documentation template with Material theme and PDF export, packaged for reuse across ValuTech projects.

## Features

- **Material for MkDocs** theme with light/dark mode
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
│   ├── mkdocs-base.yml                 # Base config template
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

# ValuTech Docs-as-Code Template

MkDocs documentation template with Material theme and PDF export, packaged for reuse across ValuTech projects.

## Features

- **Material for MkDocs** theme with light/dark mode
- **PDF export** via `mkdocs-with-pdf` (optional, env-gated)
- **Custom PDF styling** — branded cover page, headers, footers
- **Python package** — installable via `pip` for consuming projects
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

### 1. Install the package

Add the template as a dependency in your project's `pyproject.toml` or `requirements.txt`:

```toml
# pyproject.toml
[project]
dependencies = [
    "valutech-docs-template @ git+https://github.com/ValuTech/Docs-as-Code.git@v0.1.0",
]
```

Or install directly:

```bash
pip install "valutech-docs-template @ git+https://github.com/ValuTech/Docs-as-Code.git@v0.1.0"
```

This pulls in all required MkDocs dependencies (`mkdocs`, `mkdocs-material`, `mkdocs-with-pdf`).

### 2. Create your project documentation

In your project, create a `mkdocs.yml` that inherits from the template or uses it as a starting point:

```yaml
INHERIT: .valutech-docs-base.yml

site_name: "My Project"
site_description: "Documentation for My Project"

nav:
  - Home: index.md
  - Setup: setup.md
  - API: api.md
```

Or simply copy the `mkdocs.yml`, `docs/`, and `overrides/` directories from this template into your project and customize them.

### 3. Build

```bash
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
├── mkdocs.yml                  # MkDocs configuration
├── pyproject.toml              # Python package definition
├── docs/                       # Documentation source (Markdown)
│   ├── index.md
│   ├── getting-started/
│   ├── architecture/
│   ├── api-reference/
│   ├── guides/
│   ├── assets/images/          # Logos and images
│   └── stylesheets/extra.css   # Custom CSS
├── overrides/pdf/              # PDF cover page and styles
│   ├── cover.html
│   └── styles.scss
├── valutech_docs_template/     # Python package (for pip install)
│   └── __init__.py
├── .github/workflows/build.yml # CI/CD pipeline
└── .vscode/tasks.json          # VS Code build tasks
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

Edit `overrides/pdf/cover.html` for layout and `overrides/pdf/styles.scss` for page headers/footers.

## License

Internal use — ValuTech GmbH.

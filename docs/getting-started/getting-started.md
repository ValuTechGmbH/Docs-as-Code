# Getting Started

This section covers installation, prerequisites, and initial setup.

## Prerequisites

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Before you begin, ensure you have the following installed:

- **Python** 3.10 or later
- **pip** package manager
- **Git** for version control

!!! warning "System dependencies for PDF export"
    PDF generation requires WeasyPrint, which depends on native GTK3/Pango libraries. See the [PDF Export](#pdf-export) section below.

## Installation

Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.

```bash
# Clone the repository
git clone https://github.com/your-org/your-project.git
cd your-project

# Create a virtual environment
python -m venv venv
source venv/bin/activate  # macOS/Linux
# venv\Scripts\activate   # Windows

# Install dependencies
pip install -e .
```

## Running Locally

Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.

```bash
# Start the development server
mkdocs serve
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000) in your browser to preview the documentation.

## Building the Site

```bash
# Build HTML output
mkdocs build

# Build with PDF export
ENABLE_PDF_EXPORT=1 mkdocs build
```

The generated site is placed in the `site/` directory.

## PDF Export

To enable PDF generation, install the native WeasyPrint dependencies:

=== "macOS"
    ```bash
    brew install pango
    ```

=== "Ubuntu/Debian"
    ```bash
    sudo apt install libpango-1.0-0 libpangocairo-1.0-0
    ```

=== "Windows"
    PDF generation is recommended via WSL or CI/CD pipeline. See the
    [WeasyPrint documentation](https://doc.courtbouillon.org/weasyprint/stable/first_steps.html)
    for native Windows setup.

## Project Structure

```
docs/
├── index.md                 # Home page
├── getting-started/         # Setup and installation
├── architecture/            # System design
├── api-reference/           # API docs
├── guides/                  # How-to guides
├── assets/images/           # Logos and images
└── stylesheets/extra.css    # Custom styles
```

## What's Next

Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris:

1. Read the [Architecture](../architecture/architecture.md) overview
2. Browse the [API Reference](../api-reference/api-reference.md)
3. Follow the [Guides](../guides/guides.md) for common tasks

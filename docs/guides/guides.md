# Guides

Step-by-step guides for common tasks and workflows.

## Guide 1: Setting Up Your Development Environment

Lorem ipsum dolor sit amet, consectetur adipiscing elit. This guide walks you through the complete setup process.

### Step 1: Install Dependencies

Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.

```bash
pip install -r requirements.txt
```

### Step 2: Configure Environment Variables

Create a `.env` file in the project root:

```bash
DATABASE_URL=postgresql://localhost:5432/mydb
API_KEY=your-api-key-here
DEBUG=true
```

!!! tip
    Never commit `.env` files to version control. Use `.env.example` as a template.

### Step 3: Run Migrations

```bash
python manage.py migrate
```

### Step 4: Verify Installation

```bash
python manage.py check
```

---

## Guide 2: Adding a New Feature

Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.

### Planning

1. **Define requirements** — Ut enim ad minim veniam, quis nostrud exercitation
2. **Design the interface** — Sed do eiusmod tempor incididunt ut labore
3. **Write tests first** — Nam libero tempore, cum soluta nobis est eligendi

### Implementation

Lorem ipsum dolor sit amet:

```python
class FeatureService:
    """Example service implementation."""

    def __init__(self, repository):
        self.repository = repository

    def execute(self, request):
        # Validate input
        self._validate(request)

        # Process
        result = self.repository.save(request.data)

        return result
```

### Testing

```python
def test_feature_creation():
    service = FeatureService(mock_repository)
    result = service.execute(sample_request)
    assert result.status == "success"
```

---

## Guide 3: Deploying to Production

Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit.

!!! danger "Pre-deployment checklist"
    - [ ] All tests pass
    - [ ] Environment variables are configured
    - [ ] Database migrations are applied
    - [ ] Monitoring alerts are set up

### Build

```bash
docker build -t myapp:latest .
```

### Deploy

```bash
docker push registry.example.com/myapp:latest
kubectl rollout restart deployment/myapp
```

### Verify

```bash
curl -s https://api.example.com/health | jq .
```

Expected response:

```json
{
  "status": "healthy",
  "version": "1.0.0"
}
```

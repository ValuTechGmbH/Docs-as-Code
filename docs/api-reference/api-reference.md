# API Reference

This section documents the available API endpoints and interfaces.

## Authentication

All API requests require a valid Bearer token in the `Authorization` header.

```
Authorization: Bearer <your-token>
```

!!! warning
    Tokens expire after 24 hours. Use the `/auth/refresh` endpoint to obtain a new token.

## Endpoints

### `GET /api/v1/items`

Retrieve a list of items.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | integer | No | Page number (default: 1) |
| `limit` | integer | No | Items per page (default: 20, max: 100) |
| `search` | string | No | Full-text search query |

**Response:**

```json
{
  "data": [
    {
      "id": "abc-123",
      "name": "Lorem Ipsum",
      "status": "active",
      "created_at": "2025-01-15T10:30:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 42
  }
}
```

### `GET /api/v1/items/{id}`

Retrieve a single item by ID.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Unique item identifier |

**Response:**

```json
{
  "id": "abc-123",
  "name": "Lorem Ipsum",
  "description": "Dolor sit amet consectetur adipiscing elit",
  "status": "active",
  "metadata": {
    "category": "example",
    "tags": ["lorem", "ipsum"]
  },
  "created_at": "2025-01-15T10:30:00Z",
  "updated_at": "2025-02-01T14:00:00Z"
}
```

### `POST /api/v1/items`

Create a new item.

**Request Body:**

```json
{
  "name": "New Item",
  "description": "Sed do eiusmod tempor incididunt",
  "metadata": {
    "category": "example"
  }
}
```

**Response:** `201 Created`

### `DELETE /api/v1/items/{id}`

Delete an item.

**Response:** `204 No Content`

## Error Handling

All errors follow a consistent format:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "The requested resource was not found.",
    "details": {}
  }
}
```

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 400 | `BAD_REQUEST` | Invalid request parameters |
| 401 | `UNAUTHORIZED` | Missing or invalid token |
| 403 | `FORBIDDEN` | Insufficient permissions |
| 404 | `NOT_FOUND` | Resource not found |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

## Rate Limiting

API requests are limited to **100 requests per minute** per token. Rate limit headers are included in every response:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 97
X-RateLimit-Reset: 1706886400
```

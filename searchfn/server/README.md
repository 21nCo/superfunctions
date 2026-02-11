# @searchfn/server

A lightweight, database-backed full-text search engine designed to work seamlessly as a plugin for **DataFn**.

It provides simple, efficient indexing and search capabilities for your DataFn models without requiring a dedicated search infrastructure (like Elasticsearch) for small-to-medium datasets. It leverages your existing database adapter to store inverted indices.

## Features

- **Zero-Infrastructure**: Uses your existing `@superfunctions/db` adapter (Postgres, SQLite, etc.).
- **DataFn Integration**: Automatically understands your DataFn schema to index string fields.
- **Pluggable**: Exposes standard HTTP endpoints compatible with SuperFunctions HTTP abstraction.
- **Simple API**: Easy-to-use endpoints for manual indexing and querying.

## Installation

```bash
npm install @searchfn/server @superfunctions/db @datafn/core
```

## Quick Start

### 1. Initialize the Server

Integrate `searchfn` into your server setup alongside `datafn`.

```typescript
import { createSearchFnServer } from "@searchfn/server";
import { PostgresAdapter } from "@superfunctions/db-postgres";
import { mySchema } from "./schema"; // Your DataFn schema

// 1. Initialize DB Adapter
const db = new PostgresAdapter({ connectionString: process.env.DATABASE_URL });
await db.initialize();

// 2. Create SearchFn Server
const searchFn = await createSearchFnServer({
  schema: mySchema,
  db: db,
  tablePrefix: "_searchfn_", // Optional: default is "_searchfn_"
});

// 3. Mount Routes (example using standard Request/Response)
// You can mount searchFn.router directly if using SuperFunctions HTTP
// or use a generic handler adapter for Express/Fastify/Next.js.
```

### 2. Index Your Data

Trigger an indexing job. This scans your models and populates the search index.

```bash
curl -X POST http://localhost:3000/searchfn/index \
  -H "Content-Type: application/json" \
  -d '{ "model": "posts" }'
```

### 3. Perform a Search

```bash
curl -X POST http://localhost:3000/searchfn/search \
  -H "Content-Type: application/json" \
  -d '{ "query": "hello world", "model": "posts", "limit": 10 }'
```

## Architecture

SearchFn uses an **Inverted Index** approach stored in a table (default: `_searchfn_index`) within your database.

- **Tokenization**: Text is split into tokens (words), normalized to lowercase, and stripped of special characters.
- **Storage**: Maps `token -> [ (model, recordId, field) ]`.
- **Querying**: Looks up tokens from the query string, finds matching records, and ranks them by occurrence frequency (score).

### Database Schema

The plugin expects (or will attempt to use) a table structure similar to:

| Column | Type | Description |
|--------|------|-------------|
| `term` | String | The tokenized word |
| `model` | String | The DataFn model name |
| `recordId` | String | The ID of the record containing the term |
| `field` | String | The specific field name |

## API Reference

### `createSearchFnServer(config)`

Creates a new server instance.

**Config Options:**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `schema` | `DatafnSchema` | Yes | Your DataFn application schema. |
| `db` | `Adapter` | Yes | An initialized `@superfunctions/db` adapter. |
| `tablePrefix`| `string` | No | Prefix for internal tables. Default: `_searchfn_` |

### HTTP Endpoints

#### `POST /searchfn/index`

Triggers the indexing process.

**Body:**
```json
{
  "model": "optional_model_name"
}
```
If `model` is omitted, all models in the schema with string fields will be indexed.

#### `POST /searchfn/search`

Performs a full-text search.

**Body:**
```json
{
  "query": "search terms",
  "model": "optional_model_filter",
  "limit": 20
}
```

**Response:**
```json
{
  "ok": true,
  "results": [
    {
      "id": "record_123",
      "model": "posts",
      "score": 5,
      "matches": ["search", "terms"]
    }
  ]
}
```

## Advanced Usage

### Custom Indexing Logic

You can import `indexData` directly if you want to run indexing as a background job or CLI script instead of via HTTP.

```typescript
import { indexData } from "@searchfn/server";

await indexData({
  schema: mySchema,
  db: db,
  model: "users"
});
```

### Custom Search Logic

Similarly, use `searchIndex` for programmatic searching:

```typescript
import { searchIndex } from "@searchfn/server";

const results = await searchIndex({
  schema: mySchema,
  db: db,
  query: "john doe"
});
```

## License

MIT

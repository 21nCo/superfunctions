# @searchfn/server

`@searchfn/server` exposes SearchFn over the shared `@superfunctions/http` router abstraction. It does not implement indexing itself; instead, it wraps any `SearchAdapter` with validated HTTP endpoints.

## Installation

```bash
npm install @searchfn/server @searchfn/adapter-memory @superfunctions/http
```

Use a concrete adapter such as `@searchfn/adapter-memory`, `@searchfn/adapter-indexeddb`, `@searchfn/adapter-postgres`, `@searchfn/adapter-elasticsearch`, or `@searchfn/adapter-meilisearch`.

## Quick Start

```ts
import { createSearchFnServer } from "@searchfn/server";
import { MemoryAdapter } from "@searchfn/adapter-memory";

const adapter = new MemoryAdapter();
await adapter.initialize?.({
  resources: [{ name: "docs", searchFields: ["title", "body"] }],
});

const searchfn = await createSearchFnServer({
  adapter,
  basePath: "/searchfn",
  allowUnauthenticated: true, // This example calls the router in-process.
});

const response = await searchfn.router.handle(
  new Request("http://localhost/searchfn/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resource: "docs", query: "hybrid" }),
  }),
);
```

## Endpoints

- `GET /searchfn/status`
- `POST /searchfn/index`
- `POST /searchfn/search`
- `POST /searchfn/search-all`
- `POST /searchfn/remove`
- `POST /searchfn/clear`

All JSON responses use the canonical envelope shape:

```json
{
  "ok": true,
  "result": {}
}
```

or

```json
{
  "ok": false,
  "error": {
    "code": "DFQL_INVALID",
    "message": "Search query must not be empty"
  }
}
```

## Configuration

| Option | Purpose |
| --- | --- |
| `adapter` | Required search adapter. |
| `basePath` | URL prefix for the SearchFn routes. Defaults to `/searchfn`. |
| `limits` | Overrides for request size, query length, search fan-out and indexing batch caps. |
| `authorize` | Policy callback for each action and its effective resource names. |
| `context` | Request context factory. Required when a policy expects fields beyond the standard router context. |
| `allowUnauthenticated` | Explicit opt-in to run without an authorization policy. |
| `observability` | Structured logs and events. |

### Notes

- Server creation requires an `authorize` callback or `allowUnauthenticated: true`. Use the explicit opt-in for in-process callers, local demos, or deployments with an upstream authorization policy covering every operation.
- `authorize(...)` receives the context, action, parsed payload snapshot, original request, and validated list of resource names. Read headers from `request` and body fields from `payload`. Only a return value of `true` permits the operation.
- The application `context` is passed to `authorize`. Router middleware and custom routes receive the standard HTTP router context.
- Send `Content-Type: application/json` on POSTs. Use `resource` for single-resource routes and `resources` for `search-all`. An authorized `search-all` requires a non-empty resource list.
- `limits` controls payload size, query length, search fan-out, and indexing batch caps.
- `close()` delegates to `adapter.dispose()` when the adapter implements it.

### Upgrading to 0.2.0

Update `SearchFnServer<TContext>` annotations to `SearchFnServer`. Supply a `context` factory when an authorization policy needs application fields such as identity or permissions. Factory-free policies can use the standard router context fields, including `query` and `url`.

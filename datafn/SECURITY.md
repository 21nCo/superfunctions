# DataFn Security Model

This document describes the security architecture of DataFn, covering all layers from transport to field-level access control.

---

## Overview

DataFn enforces security through independent checks. A check that is enabled rejects the request immediately. Not every check runs on every route, and several are off unless the server config turns them on.

```text
Core data routes (/datafn/query, /mutation, /transact, /push, …):
  Rate limiting (only if rateLimit.enabled)
  → streaming payload limit
  → JSON parsing
  → request authorization
  → schema validation
  → field-level authorization
  → execution

Plugin routes (for example /datafn/public-links/resolve):
  These do not pass through the core withAuth chain, so they do not run the authorize callback.
  When rateLimit.enabled is set, they use that same limiter, keyed by the route path.
  Without placement, the public-link resolve stream is bounded before it is exposed to middleware.
  With placement, the placement runtime applies its own streaming cap before namespace resolution.
```

---

## Layer 1: Rate Limiting

**When:** Core routes run the limiter before parsing the body. Plugin routes run it after route middleware. Public-link resolve with placement runs it before the namespace lookup. The limiter runs only when `rateLimit.enabled` is true.
**Config:** `createDatafnServer({ rateLimit: { ... } })`

On core data routes the limiter runs before JSON parsing and the `authorize` callback. Plugin routes use the same limiter when it is enabled. They stay callable with their own credentials (a public-link token is not an owner session). The default max and window apply to every endpoint string, including a plugin path, unless `endpoints` overrides that string.

```typescript
const server = await createDatafnServer({
  schema,
  db,
  rateLimit: {
    enabled: true,
    maxRequests: 100,        // per window per client
    windowSeconds: 60,
    endpoints: {
      push:  { maxRequests: 50, windowSeconds: 60 },
      query: { maxRequests: 200, windowSeconds: 60 },
    },
    keyExtractor: (ctx) => ctx.session?.userId ?? "anonymous",
  },
});
```

**Backends:**
- `RedisRateLimiter` — uses atomic `INCR` with TTL (Lua script when available, non-atomic path otherwise).
- `InMemoryRateLimiter` — Map-based, suitable for single-instance deployments. Automatically prunes expired windows.

**Response on rejection:** `429 Too Many Requests`

---

## Layer 2: Payload Size Limits

**When:** Core data routes check the size after rate limiting and before JSON parsing. Without placement, the public-link resolve stream is capped as it is read. With placement, the route uses the placement streaming cap. Failures during context creation follow the router's context error path.
**Config:** `createDatafnServer({ limits: { maxPayloadBytes: 1_048_576 } })`
**Default:** `maxPayloadBytes` is 5,242,880 when unset.

Enforcement:
1. **Fast reject** via `Content-Length` when that header is present and over the limit. The body is not read.
2. **Streaming measurement** when `Content-Length` is absent or under the limit. The server counts bytes as they arrive and cancels the stream once the total exceeds the limit. It does not buffer the rest of an over-limit body.

**Response on rejection:** `413 Payload Too Large` with code `LIMIT_EXCEEDED`

---

## Layer 3: JSON Parsing

**When:** On core data routes, after payload limits and before the `authorize` callback. Plugin routes parse their own bodies and do not use this ordering.
**Purpose:** Ensures the body is valid JSON before any auth logic runs.

This ordering is deliberate: if the body is malformed JSON, the server returns `400 DFQL_INVALID` — never `403 FORBIDDEN`. This prevents information leakage about whether an auth token is valid when the request itself is syntactically invalid.

---

## Layer 4: Request-Level Authorization (the `authorize` callback)

**When:** After JSON parsing, before schema validation.
**Config:** `createDatafnServer({ authorize: fn })`

This is a **coarse-grained, request-level gate**. It receives the full request context (session, headers, cookies — whatever the HTTP framework provides) and decides whether the caller is allowed to perform the action at all.

```typescript
const server = await createDatafnServer({
  schema,
  db,
  authorize: async (ctx, action, payload) => {
    // action: "status" | "query" | "mutation" | "transact" | "seed" | "clone" | "pull" | "push" | "reconcile"
    // payload: the parsed JSON body (null for GET endpoints)
    // ctx: the HTTP framework context (e.g., Express req, Hono context)

    const session = ctx.session;
    if (!session?.userId) return false;       // not authenticated
    if (action === "seed" && !session.isAdmin) return false;  // seed is admin-only
    return true;
  },
});
```

**What it controls:**
- Authentication — is the caller identified?
- Coarse authorization — can this user access this endpoint type?
- Tenant-level access — is this user allowed to interact with this server instance?

**What it does NOT control:**
- Which specific fields can be read or written
- Which resources are accessible

**Response on rejection:** `403 FORBIDDEN` with message `"Authorization denied"` and path `"$"` (whole request).

---

## Layer 5: Schema Validation (DFQL Validation)

**When:** After request-level authorization, before field-level authorization.

Every query and mutation is validated against the schema before execution:

### Query Validation
- Resource must exist in schema
- Selected fields must exist on the resource
- Filter fields must exist and use valid operators
- Sort fields must exist
- Aggregation fields, groupBy, having — all validated
- Relation traversals validated against schema relations

### Mutation Validation
- Resource must exist
- Operation must be valid (`insert`, `merge`, `replace`, `delete`, `relate`, `modifyRelation`, `unrelate`)
- Record keys validated against schema fields (unknown fields rejected)
- Field value types validated against schema type definitions
- Required fields enforced for `insert`/`replace`
- ID prefix validated if defined in schema
- clientId, mutationId, version fields validated

### Validation Limits
These caps prevent complexity-based attacks:

| Limit | Default | Config key |
|---|---|---|
| Select tokens | 50 | `limits.maxSelectTokens` |
| Filter keys per level | 20 | `limits.maxFilterKeysPerLevel` |
| Sort fields | 10 | `limits.maxSortFields` |
| Aggregations | 20 | `limits.maxAggregations` |
| ID length | 255 | `limits.maxIdLength` |
| Push batch size | 500 | (hardcoded) |
| Resources per schema | 100 | (hardcoded) |

### Filter Depth Limiting
Nested filters (`$and`, `$or`) are depth-limited to prevent stack overflow from deeply nested logical expressions.

### Relation Depth Limiting
Select tokens with relation traversals (e.g., `author.posts.comments.*`) are depth-limited.

**Response on rejection:** `400` with code `DFQL_INVALID`, `DFQL_UNKNOWN_RESOURCE`, `DFQL_UNKNOWN_FIELD`, or `DFQL_UNKNOWN_RELATION`.

---

## Layer 6: Field-Level Authorization (Permissions Policy)

**When:** After schema validation, before execution.

This is **fine-grained, field-level access control** defined declaratively in the schema. It controls exactly which fields can be read (queried, filtered, sorted, aggregated) and written (mutated) on each resource.

### Defining a Policy

```typescript
defineSchema({
  resources: [
    {
      name: "users",
      version: 1,
      fields: [
        { name: "id",    type: "string",  required: true },
        { name: "name",  type: "string",  required: true },
        { name: "email", type: "string",  required: true },
        { name: "ssn",   type: "string",  required: false },
      ],
      permissions: {
        read:  { fields: ["id", "name", "email"] },
        write: { fields: ["name", "email"] },
      },
    },
  ],
});
```

With this policy:
- **Queries:** can select/filter/sort/aggregate on `id`, `name`, `email`. Attempting to select `ssn` → `403 FORBIDDEN`.
- **Mutations:** can write `name` and `email`. `id` is always auto-allowed for identity. Attempting to write `ssn` → `403 FORBIDDEN`.
- System fields (`createdAt`, `updatedAt`, etc.) respect the policy — they must be listed in `read.fields` to be selectable.

### Deny-by-Default (VAL-001)

Resources **without** a `permissions` property are **forbidden by default**. Every query and mutation against them returns `403 FORBIDDEN`.

```typescript
// This resource has NO permissions → all access blocked
{ name: "secret_data", version: 1, fields: [...] }
```

**Escape hatch for development:** Set `allowUnknownResources: true` in server config to allow resources without a policy. This should never be used in production.

```typescript
const server = await createDatafnServer({
  schema,
  db,
  allowUnknownResources: true,  // DEV ONLY — disables deny-by-default
});
```

### What Field-Level Authz Covers

| DFQL Feature | Checked Against |
|---|---|
| `select` fields | `permissions.read.fields` |
| `filters` keys | `permissions.read.fields` |
| `sort` fields | `permissions.read.fields` |
| `aggregations` field references | `permissions.read.fields` |
| `groupBy` fields | `permissions.read.fields` |
| `having` clause fields | `permissions.read.fields` |
| `search.fields` | `permissions.read.fields` |
| `record` keys (mutations) | `permissions.write.fields` |
| Relation mutation names | `permissions.write.fields` |

**Response on rejection:** `403 FORBIDDEN` with message `"Authorization denied"` and the specific path (e.g., `select[1]`, `record.ssn`).

### Error Disclosure Control (VAL-009)

Detailed validation and authorization messages are off unless `debug: true`. `NODE_ENV` does not turn them on. Unexpected database and transaction failures always return a generic client message; the driver text is written to the error log only.

---

## Layer 7: Namespace Isolation

DataFn supports multi-tenant data isolation via row-level namespace scoping.

### How It Works

When `namespaceProvider` is configured, every database operation is scoped to a namespace derived from the request context (e.g., `"tenant:456"` or `"user:123"`):

```typescript
const server = await createDatafnServer({
  schema,
  db,
  namespaceProvider: {
    getNamespace: (ctx) => ctx.session.tenantId,
  },
});
```

**Row-level enforcement:** When enabled, the database adapter wraps every query and mutation with a `__ns` discriminator column. A query for `resource: "todos"` in namespace `"tenant:abc"` will only return rows where `__ns = "tenant:abc"`. Inserts automatically set `__ns`. This is transparent to the application.

### WebSocket Namespace Security (SEC-002)

WebSocket connections lock the namespace at connection time based on the server-derived auth context — **never from client-supplied messages**. Even if a client sends a `hello` message with a `namespace` field, it is ignored. This prevents cross-tenant data leakage via WebSocket broadcast.

---

## Input Sanitization

### Prototype Pollution Prevention (SEC-008)

All mutation objects are recursively scanned for prototype pollution keys before processing:

```typescript
// Rejected keys: __proto__, constructor, prototype
const pollutionCheck = checkPrototypePollution(mutationObject);
```

Any mutation containing these keys is rejected with `DFQL_INVALID`.

### REST Path Traversal Prevention (SEC-010)

REST endpoint path segments are sanitized against traversal attacks. URL-decoded segments containing `..`, null bytes, or encoded `/` are rejected.

### Field Value Type Validation (SEC-005)

Every field value in a mutation record is validated against its declared schema type. This prevents type confusion attacks where a string field receives an object, or an object field receives a function-like payload.

---

## WebSocket Security

### Authentication Required (SEC-001)

WebSocket connections require authentication via `addClient()`. Unauthenticated connections must be rejected with WS close code `4401` before calling `addClient()`.

### Connection Limits (SCA-005)

| Limit | Default | Config |
|---|---|---|
| Max total connections | 10,000 | `ws.maxConnections` |
| Max per namespace | 100 | `ws.maxConnectionsPerNamespace` |

Connections exceeding limits are closed with code `4503`.

### Heartbeat (REL-007)

Native WS ping/pong heartbeat detects dead connections:
- Ping interval: 30s (configurable)
- Pong timeout: 10s (configurable)
- Dead connections are automatically closed.

---

## Browser Extension Security

For browser extension deployments, DataFn uses a trust boundary model:

- **Background script** — trusted, authoritative. Holds the actual database connection and runs the sync engine.
- **Content scripts / sidepanel** — untrusted. Communicate with the background via a message bus using canonical RPC envelopes.

The extension transport (`createExtensionTransport`) enforces:
- Per-request timeouts (default 30s) to prevent hung message channels
- Typed RPC envelopes for all operations (query, mutate, subscribe, unsubscribe)
- No direct database access from untrusted contexts

---

## Graceful Shutdown

The server tracks in-flight requests and supports graceful shutdown:
- New requests during shutdown receive `503 Service Unavailable`.
- The server waits for in-flight requests to complete (configurable drain timeout, default 10s).
- Periodic tasks (retention pruning, heartbeat) are stopped cleanly.

---

## Data Retention

Change log and idempotency records can be configured for automatic pruning:

```typescript
const server = await createDatafnServer({
  schema,
  db,
  retention: {
    changeLogDays: 30,
    idempotencyDays: 7,
    pruneOnStartup: true,
    pruneIntervalMs: 3600000,  // hourly
  },
});
```

This prevents unbounded growth of internal tables.

---

## Security Configuration Summary

```typescript
const server = await createDatafnServer({
  schema,                        // Schema with per-resource permissions policies
  db,

  // Layer 1: Rate limiting
  rateLimit: {
    enabled: true,
    maxRequests: 100,
    windowSeconds: 60,
  },

  // Layer 2: Payload limits
  limits: {
    maxPayloadBytes: 1_048_576,  // 1MB
    maxSelectTokens: 50,
    maxFilterKeysPerLevel: 20,
    maxSortFields: 10,
    maxAggregations: 20,
    maxIdLength: 255,
  },

  // Layer 4: Request-level authorization
  authorize: async (ctx, action, payload) => {
    return !!ctx.session?.userId;
  },

  // Layer 7: Namespace isolation
  namespaceProvider: {
    getNamespace: (ctx) => ctx.session.tenantId,
  },

  // Error disclosure control. Off unless set. NODE_ENV does not enable it.
  debug: false,

  // Deny-by-default for resources without permissions policy
  allowUnknownResources: false,  // default

  // WebSocket limits
  ws: {
    maxConnections: 10_000,
    maxConnectionsPerNamespace: 100,
    heartbeatIntervalMs: 30_000,
    heartbeatTimeoutMs: 10_000,
  },

  // Data retention
  retention: {
    changeLogDays: 30,
    idempotencyDays: 7,
  },

  // Graceful shutdown
  shutdownTimeoutMs: 10_000,
});
```

---

## Security Checklist for Production

- [ ] Set `authorize` callback to verify authentication on every request
- [ ] Define `permissions` on every resource in your schema (deny-by-default enforced)
- [ ] Set `allowUnknownResources: false` (the default — do not override in production)
- [ ] Configure `namespaceProvider` for namespace isolation in multi-tenant deployments
- [ ] Leave `debug` unset (or `false`) so clients do not receive field-level error details. Set `debug: true` only on a server you intend to debug.
- [ ] Set `limits.maxPayloadBytes` to prevent oversized request bodies
- [ ] Enable rate limiting with appropriate per-endpoint limits
- [ ] Configure data retention to prevent unbounded internal table growth
- [ ] Authenticate WebSocket connections before calling `addClient()`
- [ ] Review field-level permissions for each resource to ensure least-privilege access

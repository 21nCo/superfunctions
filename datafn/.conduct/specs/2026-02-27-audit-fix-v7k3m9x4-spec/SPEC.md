# SPEC: DataFn Production-Readiness Audit Fix

## Metadata

- **Timestamp**: 2026-02-27T18:00:00Z
- **Agent**: claude-opus-4-6
- **Model**: Claude Opus 4.6 (1M context)
- **Launcher**: Claude Code (Warp)
- **Workspace**: /Users/serro/Documents/dev/n/superfunctions
- **OS**: Darwin 25.3.0 / zsh
- **Branch**: next
- **Commit**: ea87d7e (dirty)
- **spec_folder**: `2026-02-27-audit-fix-v7k3m9x4-spec`
- **spec_type**: audit-fix
- **spec_id**: v7k3m9x4
- **Audit reference**: `datafn/.conduct/audits/2026-02-26-x3cjj10g-full-audit.md` (audit ID: x3cjj10g)
- **Decisions reference**: `datafn/.conduct/audits/2026-02-27-x3cjj10g-audit-decisions.md`
- **Input paths**:
  - `datafn/.conduct/audits/2026-02-26-x3cjj10g-full-audit.md`
  - `datafn/.conduct/audits/2026-02-27-x3cjj10g-audit-decisions.md`
  - `datafn/server/src/ws.ts`
  - `datafn/server/src/execution/transact.ts`
  - `datafn/server/src/execution/sync/push.ts`
  - `datafn/server/src/execution/sync/change-tracking.ts`
  - `datafn/server/src/validation/authz.ts`
  - `datafn/server/src/http/middleware.ts`
  - `datafn/server/src/routes/transact.ts`
  - `datafn/server/src/routes/sync.ts`
  - `datafn/server/src/server.ts`
  - `datafn/server/src/execution/idempotency.ts`
  - `datafn/server/src/execution/mutation/execute.ts`
  - `datafn/server/src/execution/sync/clone.ts`
  - `datafn/server/src/execution/sync/reconcile.ts`
  - `datafn/server/src/middleware/rate-limit.ts`
  - `datafn/core/src/types.ts`
  - `datafn/core/src/schema.ts`
  - `datafn/core/src/filters.ts`
  - `datafn/client/src/debounce.ts`
  - `datafn/client/src/sync/engine.ts`
  - `datafn/client/src/extension/transport.ts`

---

## Overview

This spec addresses ALL 157 issues identified in audit `x3cjj10g` (2026-02-26 full production-readiness audit). It implements the **recommended approaches** from the audit decisions document (`2026-02-27-x3cjj10g-audit-decisions.md`) for all 16 decision points. The spec covers: 18 CRITICAL, 43 HIGH, 62 MEDIUM, 34 LOW issues plus 7 test coverage gaps.

---

## Glossary

| Term | Definition |
|---|---|
| **DFQL** | DataFn Query Language — the JSON-based query/mutation protocol |
| **Namespace** | Tenant isolation boundary; derived from auth context (e.g. `user:123` or `tenant:abc:user:123`) |
| **ServerSeq** | Monotonically increasing sequence number used for change tracking / sync ordering |
| **Push** | Client-to-server sync: sends local mutations to server for persistence |
| **Pull** | Server-to-client sync: fetches changes since a cursor position |
| **Clone** | Full or paginated initial hydration of client state from server |
| **Reconcile** | Client-server count comparison to detect drift |
| **CAS** | Compare-and-swap: atomic read-modify-write used for sequence allocation |
| **Idempotency** | Deduplication of mutations by `clientId + mutationId` |
| **LiveSignal** | Reactive signal that auto-disposes on lifecycle teardown |
| **Prototype pollution** | Attack where `__proto__`/`constructor`/`prototype` keys in JSON modify object prototypes |

---

## Goals

1. Fix ALL 18 CRITICAL issues to achieve production-readiness baseline
2. Fix ALL 43 HIGH issues to achieve beta-readiness
3. Fix ALL 62 MEDIUM issues to achieve GA-readiness
4. Fix ALL 34 LOW issues for code quality
5. Close ALL 7 test coverage gaps
6. Implement decisions 1-16 from the audit decisions document using recommended approaches

## Non-goals

- Feature additions beyond what is required to fix audit findings
- Migration tooling for existing deployments (data migration scripts)
- Performance benchmarking infrastructure (stress tests are in scope, benchmarking dashboards are not)
- Edge runtime compatibility (mentioned in audit but deferred — Node.js-only for now)

---

## Public API Changes

### New config options on `DatafnServerConfig`

```typescript
interface DatafnServerConfig {
  // Existing...
  limits?: {
    maxLimit?: number;           // existing, default 100
    maxTransactSteps?: number;   // existing
    maxPayloadBytes?: number;    // CHANGE: default 5_242_880 (was undefined)
    maxPullLimit?: number;       // existing, default 1000
    maxBatchSize?: number;       // NEW: default 500
    maxCloneRecords?: number;    // NEW: default 10_000
    idempotencyTtlMs?: number;   // NEW: default 86_400_000 (24h)
    idempotencyMaxEntries?: number; // NEW: default 100_000
    maxSelectTokens?: number;    // NEW: default 50
    maxFilterKeysPerLevel?: number; // NEW: default 20
    maxSortFields?: number;      // NEW: default 10
    maxAggregations?: number;    // NEW: default 20
    maxSearchQueryLength?: number; // NEW: default 1000
    maxLikePatternLength?: number; // NEW: default 200
    maxIdLength?: number;        // NEW: default 255
    maxFilterDepth?: number;     // NEW: default 10
  };
  ws?: {
    maxConnections?: number;            // NEW: default 10_000
    maxConnectionsPerNamespace?: number; // NEW: default 100
    heartbeatIntervalMs?: number;       // NEW: default 30_000
    heartbeatTimeoutMs?: number;        // NEW: default 10_000
  };
  shutdownTimeoutMs?: number;   // NEW: default 10_000
  debug?: boolean;              // NEW: default process.env.NODE_ENV !== 'production'
  logger?: DatafnLogger;        // NEW: default console-based
}
```

### New `DatafnLogger` interface

```typescript
interface DatafnLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}
```

### Changed `authz` behavior

- Unknown resources → `FORBIDDEN` (was `ok: true`). Escape hatch: `authz.allowUnknownResources: true` in permissions policy.

### Changed transaction response

- Rolled-back steps: `{ ok: false, rolledBack: true, result: <original> }` (was `{ ok: true, ... }`)
- Transaction adapter failure: returns `INTERNAL` error (was: silent fallthrough to sequential)

### Changed push response

- Change tracking failure → mutation marked as failed (was: silently swallowed)

---

## Data Formats / Protocol

### Prototype pollution — blocked keys

These keys MUST be rejected at ALL validation entry points with `DFQL_INVALID`:
- `__proto__`
- `constructor`
- `prototype`

Rejection is **recursive** — applies to nested objects in mutation records, filter values, and query parameters.

### Field value type validation rules

| Schema type | Valid JS types | Notes |
|---|---|---|
| `string` | `typeof === "string"` | |
| `number` | `typeof === "number"` and `!isNaN` | |
| `boolean` | `typeof === "boolean"` | |
| `date` | ISO 8601 string or epoch number | Validated via regex + `!isNaN(Date.parse())` or `typeof === "number"` |
| `object` | Plain object (not array, not null) | `typeof === "object" && !Array.isArray && value !== null` |
| `array` | `Array.isArray` | |
| `file` | `typeof === "string"` | File reference (URL/path) |

Error format: `"Field '{fieldName}' expects {schemaType}, got {actualType}"`

### Transaction response envelope (changed)

```json
{
  "ok": false,
  "results": [
    { "ok": false, "rolledBack": true, "result": { "ok": true, "record": {...} } },
    { "ok": false, "rolledBack": true, "result": { "ok": true, "record": {...} } },
    { "ok": false, "error": { "code": "DFQL_NOT_FOUND", "message": "..." } }
  ],
  "error": { "code": "TRANSACTION_ROLLED_BACK", "message": "Step 2 failed; all steps rolled back" }
}
```

---

## Semantics

### WebSocket authentication (Decision #1 — Option A)

- Auth MUST occur during HTTP upgrade handshake
- Server derives namespace from `authContextProvider.getContext(upgradeRequest)`
- Client-supplied `namespace` in `hello` message MUST be **ignored** — server always uses the derived namespace
- Connections without valid auth MUST be rejected with WS close code `4401`
- `addClient()` MUST require an `AuthContext` parameter

### Change tracking failure semantics (Decision #2 — Option A + C)

- If `recordChange()` fails, the mutation MUST be treated as failed
- Before failing, retry `recordChange()` up to 2 times with 50ms, 100ms delay
- `push.ts` MUST be consistent with `execute.ts` — both propagate change tracking failures

### Transaction fallback (Decision #3 — Option A)

- If `db.transaction()` throws for non-application reasons, return `INTERNAL` error
- Sequential fallback ONLY when `db.transaction` is `undefined` (memory adapter)
- NEVER silently fall through to sequential execution when atomic was requested

### Rolled-back result semantics (Decision #4 — Option A)

- All pre-failure step results MUST be annotated: `{ ok: false, rolledBack: true, result: <original> }`
- Top-level response: `{ ok: false, error: { code: "TRANSACTION_ROLLED_BACK" } }`

### Field value type validation (Decision #5 — Option A)

- Strict validation: schema type MUST match JS type
- `null` allowed only when field is `nullable: true`
- `undefined` fields omitted (treated as not provided, distinct from `null`)

### Batch size limits (Decision #6 — Option A)

- `limits.maxBatchSize` default: 500
- Applied at push and batch mutation endpoints
- Error: `DFQL_INVALID` with message `"Batch size {n} exceeds limit {max}"`

### Clone pagination (Decision #7 — Option B)

- `limits.maxCloneRecords` default: 10,000
- Non-paginated clone works for datasets under the limit
- When exceeded: return partial response with `{ paginated: true, next: { table, afterId, limit } }`

### WebSocket limits and heartbeat (Decision #8)

- Connection limit: `ws.maxConnections` default 10,000
- Per-namespace: `ws.maxConnectionsPerNamespace` default 100
- Heartbeat: native WS ping/pong, 30s interval, 10s timeout
- Dead connections closed automatically after missed pong
- Namespace-scoped broadcasting via `Map<namespace, Set<Client>>`

### Graceful shutdown (Decision #9 — Option A)

- On SIGTERM/SIGINT:
  1. Stop accepting new HTTP requests and WS connections
  2. Send WS close frame (1001 Going Away) to all clients
  3. Wait for in-flight requests to complete (up to `shutdownTimeoutMs`)
  4. Force-close remaining connections
  5. Clean up rate limit timers, idempotency sweep timers
  6. Resolve `close()` Promise

### Prototype pollution protection (Decision #10 — Option A)

- Reject with `DFQL_INVALID`: `"Disallowed key: __proto__"`
- Check recursively in all nested objects
- Block list: `__proto__`, `constructor`, `prototype`

### Idempotency store TTL (Decision #11)

- `MemoryIdempotencyStore`: LRU eviction at `idempotencyMaxEntries` + TTL sweep every 5 minutes
- Default TTL: 24 hours. Default max entries: 100,000

### Authz for unknown resources (Decision #12 — Option A)

- Unknown resource → `FORBIDDEN`
- Error message: `"No authorization policy found for resource '{name}'. Define a policy or use allowUnknownResources: true to allow."`

### Default payload size (Decision #13)

- `limits.maxPayloadBytes` defaults to 5,242,880 (5MB)
- Fix byte measurement: use `Buffer.byteLength(body, 'utf8')` not `body.length`

### Structured logging (Decision #14 — Option A)

- Pluggable `DatafnLogger` interface
- Default: console-based with JSON output in production, pretty-print in development
- `redactSensitiveFields` extended to common names: `password`, `token`, `secret`, `authorization`, `cookie`

### `$or` filter operator (Decision #15)

- MUST be rejected with `DFQL_INVALID: "$or filter operator is not yet supported"` if not fully implemented
- If implemented: same semantics as `$and` but with OR logic

### Error message disclosure (Decision #16 — Option A)

- `debug: true` (dev): full details with field names, valid operators, schema hints
- `debug: false` (prod): error code + generic message only
- Default: `process.env.NODE_ENV !== 'production'`

---

## Invariants

1. **Auth invariant**: Every WS connection and HTTP request MUST have a validated auth context before accessing any data
2. **Namespace invariant**: Namespace MUST be server-derived, never client-supplied
3. **Atomicity invariant**: If `atomic: true` is requested, either ALL steps succeed or NONE persist
4. **Sync invariant**: Every persisted mutation MUST have a corresponding change log entry. If change tracking fails, the mutation MUST fail
5. **Type invariant**: Field values in the DB MUST match their schema-declared types
6. **Batch invariant**: No endpoint MUST accept more than `limits.maxBatchSize` mutations
7. **Memory invariant**: No in-memory store MUST grow without bound — all stores MUST have TTL or LRU eviction
8. **Prototype invariant**: `__proto__`, `constructor`, `prototype` keys MUST never reach application logic

---

## Security

### Authorization boundaries

- `validateQueryAuthz` MUST check: `select`, `filters`, `aggregations`, `groupBy`, `having`, `sort`, `search.fields`
- `validateMutationAuthz` MUST check: `record` keys for insert/merge/replace, relation target fields for relate/modifyRelation/unrelate
- `/transact` endpoint MUST call `validateQueryAuthz` or `validateMutationAuthz` per step
- Unknown resources → FORBIDDEN by default

### Validation rules

- Prototype pollution: block `__proto__`, `constructor`, `prototype` recursively
- Field value types: strict match against schema
- Batch sizes: capped at `maxBatchSize`
- Payload sizes: measured in bytes (UTF-8), default 5MB
- ID length: capped at `maxIdLength` (255)
- Search query length: capped at `maxSearchQueryLength` (1000)
- LIKE pattern length: capped at `maxLikePatternLength` (200)
- Filter depth: capped at `maxFilterDepth` (10)
- Select tokens: capped at `maxSelectTokens` (50)
- Sort fields: capped at `maxSortFields` (10)

### Privacy

- Error messages in production: generic (no schema details)
- Logging: redact `password`, `token`, `secret`, `authorization`, `cookie`, `encrypt: true` fields

---

## Limits / Caps

| Limit | Config key | Default | Applies to |
|---|---|---|---|
| Payload size | `limits.maxPayloadBytes` | 5,242,880 | All incoming HTTP bodies |
| Batch mutations | `limits.maxBatchSize` | 500 | Push + batch mutation |
| Clone records | `limits.maxCloneRecords` | 10,000 | Non-paginated clone |
| Query limit | `limits.maxLimit` | 100 | Query `limit` param |
| Pull limit | `limits.maxPullLimit` | 1,000 | Pull changes per request |
| Transaction steps | `limits.maxTransactSteps` | 100 | Transact steps array |
| Idempotency TTL | `limits.idempotencyTtlMs` | 86,400,000 | MemoryIdempotencyStore |
| Idempotency max entries | `limits.idempotencyMaxEntries` | 100,000 | MemoryIdempotencyStore |
| Select tokens | `limits.maxSelectTokens` | 50 | Query select array |
| Filter keys per level | `limits.maxFilterKeysPerLevel` | 20 | Filter object depth |
| Sort fields | `limits.maxSortFields` | 10 | Query sort array |
| Aggregation count | `limits.maxAggregations` | 20 | Query aggregations |
| Search query length | `limits.maxSearchQueryLength` | 1,000 | Search query string |
| LIKE pattern length | `limits.maxLikePatternLength` | 200 | $like/$ilike values |
| ID length | `limits.maxIdLength` | 255 | Record IDs |
| Filter depth | `limits.maxFilterDepth` | 10 | Nested $and/$or |
| WS connections | `ws.maxConnections` | 10,000 | Total WS connections |
| WS per-namespace | `ws.maxConnectionsPerNamespace` | 100 | Per-tenant WS limit |
| WS heartbeat | `ws.heartbeatIntervalMs` | 30,000 | Ping interval |
| WS timeout | `ws.heartbeatTimeoutMs` | 10,000 | Pong deadline |
| Shutdown timeout | `shutdownTimeoutMs` | 10,000 | Graceful shutdown drain |

---

## Observability

- All log calls via `DatafnLogger` interface (pluggable)
- Redaction of sensitive fields before logging
- Rate limit 429 responses MUST include `Retry-After` header
- Timer phases MUST be accurate (fix `Promise.all` timing issue)
- Errors MUST include context: step index, operation, resource (for transaction step errors)
- Change tracking CAS retries MUST be logged at `warn` level with retry count

---

## Compatibility / Versioning

- Authz `allowUnknownResources: true` escape hatch for backward compatibility with decision #12
- Transaction response format is a **breaking change** — clients MUST be updated to handle `rolledBack: true`
- WebSocket `hello` message `namespace` field ignored (non-breaking — server just stops trusting it)
- `maxPayloadBytes` gaining a default (5MB) is potentially breaking for clients sending >5MB payloads
- `$or` filter: if not implemented, explicit rejection is a behavior change from silent drop

---

## Undefined / Explicitly User-Deferred

- Edge runtime compatibility (L-S09 `createHash("sha256")`) — Node.js only for now
- Dead-letter queue for change tracking (Decision #2 — explicitly noted as future enhancement)
- Per-resource batch size limits (Decision #6 — Option B rejected)
- Structured logging JSON schema (logging format is implementation detail of default logger)

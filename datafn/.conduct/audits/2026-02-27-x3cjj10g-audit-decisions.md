# Audit Decision Points — Expanded Analysis

Based on audit `x3cjj10g` with full codebase review.

---

## 1. WebSocket Authentication Strategy
**Audit refs:** SEC-C1, SEC-C2

**Current state:** `ws.ts` accepts any connection via `addClient()` with zero auth. The `hello` message carries a client-supplied `namespace` that is trusted directly. HTTP routes already have a well-structured auth flow: `authContextProvider.getContext(ctx)` → `extractNamespace()` → row-level isolation.

### Options

**A) Reuse HTTP auth flow on WS upgrade (Recommended)**
- Validate auth token during the HTTP upgrade handshake (the `Upgrade` request is a normal HTTP request)
- Derive namespace from `authContextProvider` just like HTTP routes do
- Reject `hello` messages that supply a `namespace` — server always derives it
- Pros: Single auth path, no new token format, consistent with existing `extractNamespace()` pattern
- Cons: Requires access to the request object during WS upgrade (most WS libraries support this)

**B) JWT in `hello` message**
- Client sends a signed JWT in the `hello` payload, server validates it
- Pros: Works with WS libraries that don't expose the upgrade request
- Cons: New token exchange flow, duplicates auth logic, clients need to obtain and refresh JWTs separately

**C) Separate WS middleware**
- Build a standalone WS auth middleware
- Pros: Full control, can add WS-specific claims
- Cons: Most complexity, two auth systems to maintain

### Recommendation: **Option A**
The `authContextProvider` interface is already generic (takes a context `TContext`). Passing the upgrade request through it keeps auth unified. The WS manager just needs a `namespace` derived at connection time, not per-message.

---

## 2. Change Tracking Failure Semantics
**Audit refs:** REL-C2, REL-H6

**Current state:** Mixed behavior. In `execute.ts`, change tracking failure propagates as an error (throws). In `push.ts`, the error is logged but swallowed — the mutation succeeds but the change log entry is lost, permanently desynchronizing all sync clients.

### Options

**A) Fail the mutation (Recommended)**
- If `recordChange()` fails, treat the entire mutation as failed and roll it back
- Pros: Sync consistency guaranteed — no "ghost" mutations invisible to other clients. Simple to reason about. Already the behavior in `execute.ts`
- Cons: A transient change-tracking failure (e.g., sequence store timeout) rejects a valid write. Under heavy load, this could cascade

**B) Dead-letter queue**
- On failure, write the failed change entry to a dead-letter table/queue for later replay
- Pros: Writes never blocked by change tracking issues. Can be replayed later to restore sync
- Cons: Significant complexity — need a replay mechanism, monitoring, and a way to reorder replayed entries into the sequence. If the dead letter itself fails, you're back to silent data loss

**C) Retry inline with backoff**
- Retry `recordChange()` 2-3 times with short backoff before failing
- Pros: Handles transient failures transparently
- Cons: Adds latency to the hot path. Doesn't solve persistent failures

### Recommendation: **Option A, with Option C as enhancement**
Fail the mutation on change tracking failure (make `push.ts` consistent with `execute.ts`). Add 1-2 fast retries (50ms, 100ms) before failing. This keeps the system simple and correct. Dead-letter can be a future enhancement if change tracking failures become a real operational problem, but for now the complexity isn't justified.

---

## 3. Transaction Fallback Behavior
**Audit refs:** REL-C1

**Current state:** `execution/transact.ts` attempts `db.transaction()`. If the adapter throws a non-application error (serialization failure, timeout), the code silently falls through to sequential non-atomic execution. The caller never knows atomicity was lost.

### Options

**A) Return INTERNAL error, never fall through (Recommended)**
- If `db.transaction()` throws for non-application reasons, return an error to the caller
- Only use sequential fallback when the adapter genuinely lacks `transaction()` support (memory adapter)
- Pros: Caller always knows what happened. No silent partial application. Explicit contract
- Cons: Transient DB issues cause transaction failures even when sequential execution would have succeeded

**B) Fall through but flag it**
- Execute sequentially, but add `atomicity: "lost"` or `fallback: true` to the response
- Pros: More resilient — operations succeed even under DB stress
- Cons: Clients must check the flag. Most won't. Silent data integrity issues when they ignore it. Contradicts the purpose of requesting `atomic: true`

**C) Fall through only for specific error types**
- Whitelist certain transient errors (connection timeout) for fallback, treat others (serialization) as hard failures
- Pros: Nuanced handling
- Cons: Fragile — error classification depends on DB-specific messages (already a problem per M-E05). Adapter-specific behavior differences

### Recommendation: **Option A**
If the caller requests `atomic: true` (the default), they should get atomicity or an error. The sequential fallback should only engage when `db.transaction` doesn't exist (memory adapter), which is already detectable at setup time, not at runtime. For transient failures, the client can retry the transaction.

---

## 4. Transaction Rolled-Back Result Semantics
**Audit refs:** REL-C3

**Current state:** When a step fails inside `db.transaction()`, earlier steps have `ok: true` in the results array even though the DB rolled them back. Clients may update local state with data that doesn't exist.

### Options

**A) Clear pre-failure results (Recommended)**
- Replace all results before the failed step with `{ ok: false, rolledBack: true }` or null
- Pros: No phantom data. Client can't accidentally apply rolled-back mutations. Clear signal
- Cons: Client loses visibility into what the transaction *would have* done

**B) Annotate with `rolledBack: true`**
- Keep `ok: true` results but add `rolledBack: true` flag
- Pros: Client can see what succeeded before rollback (useful for debugging, retrying individual steps)
- Cons: Clients that don't check `rolledBack` will treat them as real data. More error-prone

**C) Return only the error step**
- Truncate results at the failure point
- Pros: Simplest. No ambiguity
- Cons: Loses information about which steps were attempted

### Recommendation: **Option A**
Annotate rolled-back steps as `{ ok: false, rolledBack: true, result: <original> }`. This preserves debug info while making the `ok: false` status impossible to ignore. The client SDK can strip the `result` field if it doesn't need it.

---

## 5. Field Value Type Validation Strictness
**Audit refs:** SEC-C5

**Current state:** Record keys are validated against schema, but values are never type-checked. A `type: "number"` field happily accepts `"hello"`, `[]`, `{}`. Field types defined in core: `string, number, boolean, object, array, date, file`.

### Options

**A) Strict — reject mismatches (Recommended)**
- `number` requires `typeof value === "number"`, `string` requires `typeof value === "string"`, etc.
- `date` accepts ISO 8601 strings and numbers (epoch), `object` accepts plain objects, `array` accepts arrays
- Pros: Catches bugs early. No ambiguity about what's stored. DB adapters won't choke on unexpected types
- Cons: Slightly more friction for clients sending numeric strings. Breaking change if existing clients send loose types

**B) Coercive — attempt conversion**
- `"123"` → `123` for numbers, `"true"` → `true` for booleans, etc.
- Pros: More forgiving, especially for form inputs or URL params
- Cons: Lossy — `"123abc"` → `NaN` or 123? `"0"` → false? Coercion rules are notoriously surprising. Creates implicit behavior that's hard to debug. Server becomes responsible for data cleaning

**C) Configurable per-field**
- Schema field gets `coerce: true/false` option
- Pros: Maximum flexibility
- Cons: Over-engineered. Schema complexity increases. Two validation paths to maintain

### Recommendation: **Option A**
Strict validation. The schema already has explicit types — enforce them. Date fields should accept both ISO strings and epoch numbers since the codebase already does date coercion in `push.ts`. For the `object` type, validate it's a plain object (not array, not null). For `array`, validate it's an array. Add clear error messages: `"Field 'age' expects number, got string"`.

---

## 6. Batch Size Limits
**Audit refs:** SEC-C6

**Current state:** No limit on mutation arrays. Push and mutation endpoints accept unbounded arrays. The client sync engine already uses `pushBatchSize: 100` as default, but the server doesn't enforce a cap.

### Options

**A) Global configurable default of 500 (Recommended)**
- Add `limits.maxBatchSize` to `DatafnServerConfig` (alongside existing `maxLimit`, `maxTransactSteps`, `maxPullLimit`)
- Default: 500. Applies to push mutations and batch mutation endpoint
- Pros: Consistent with existing `limits` config pattern. Simple. Prevents memory exhaustion
- Cons: Fixed limit may not fit all use cases

**B) Per-resource limits**
- Each resource schema gets a `maxBatchSize` override
- Pros: Fine-grained control (small records can have higher limits)
- Cons: Over-engineered for a safety valve. No existing per-resource limit pattern in the config

**C) Per-endpoint limits**
- Separate limits for `/push` vs `/mutation`
- Pros: Push (trusted sync) could have higher limits than mutation (user-facing)
- Cons: Adds config surface area for marginal benefit

### Recommendation: **Option A**
A single `limits.maxBatchSize` default of **500** fits the existing config pattern (`limits.maxLimit: 100`, `limits.maxTransactSteps`, `limits.maxPullLimit: 1000`). The client already batches at 100, so 500 gives 5x headroom. If someone needs more, they set `limits.maxBatchSize: 2000`.

---

## 7. Clone Pagination
**Audit refs:** SCA-C2

**Current state:** Clone already supports optional pagination via `page: { table, afterId, limit }` with a max of 1000 per page. But without `page`, it loads ALL records from ALL tables into a single response. The client defaults to `clonePageSize: 1000`.

### Options

**A) Enforce mandatory server-side pagination**
- Server rejects clone requests without `page` parameter
- Pros: Eliminates unbounded memory risk entirely
- Cons: Breaking change. Simple apps with small datasets now need pagination logic. Over-protective

**B) Add configurable default limit, keep non-paginated path (Recommended)**
- If no `page` is provided, apply `limits.maxCloneRecords` (default: 10,000) across all tables
- If total records exceed the limit, return a `paginated: true` flag and cursors for the client to continue
- Pros: Non-breaking. Small apps work as before. Large datasets get automatic safety. Follows existing pattern of sensible defaults
- Cons: Slightly more complex response handling

**C) Per-table limit with auto-pagination**
- Server enforces per-table limit (e.g., 5000) and returns `next` cursors automatically
- Pros: Granular control
- Cons: Client must handle partial clone responses even for small tables

### Recommendation: **Option B**
Add `limits.maxCloneRecords: 10000` to config. Non-paginated clone works for small datasets (the common case). When it would exceed the limit, the server returns a partial response with cursors. The client sync engine already handles paginated clone via its `clonePageSize` config, so the client-side code mostly works as-is.

---

## 8. WebSocket Connection Limits & Heartbeat
**Audit refs:** SCA-H1, REL-H1

**Current state:** `clients` is an unbounded `Set`. No heartbeat. No per-namespace tracking (broadcast iterates ALL clients). Dead connections accumulate.

### Options & Recommendation

This isn't really a fork — all three measures are needed:

**Connection limit:**
- Add `ws.maxConnections` to config (default: **10,000**)
- Add `ws.maxConnectionsPerNamespace` (default: **100**)
- Reject new connections with 503 when limit reached
- Rationale: 10k is a reasonable upper bound for a single process. Per-namespace limits prevent one tenant from starving others

**Heartbeat:**
- Ping/pong interval: **30 seconds** (standard for most WS implementations)
- Timeout: **10 seconds** (if no pong received, close connection)
- Use the native WS ping/pong frames (not application-level messages)
- Rationale: 30s is the industry standard (used by Socket.IO, Phoenix, etc.). Short enough to detect dead connections quickly, long enough to not waste bandwidth

**Namespace-scoped broadcasting:**
- Replace `Set<Client>` with `Map<namespace, Set<Client>>` for O(1) broadcast scoping
- This is an implementation detail, not a config decision

### Defaults summary
```
ws.maxConnections: 10000
ws.maxConnectionsPerNamespace: 100
ws.heartbeatIntervalMs: 30000
ws.heartbeatTimeoutMs: 10000
```

---

## 9. Graceful Shutdown
**Audit refs:** REL-H3

**Current state:** No shutdown handling. In-flight requests are dropped, WS connections are not closed, pending changes are not flushed.

### Options

**A) Drain with timeout (Recommended)**
- Stop accepting new connections immediately
- Let in-flight HTTP requests complete (up to a timeout)
- Close WS connections with a `1001` (Going Away) close code
- Flush any pending change tracking writes
- Pros: Clean shutdown. Clients get proper close codes and can reconnect. No data loss
- Cons: Adds shutdown coordination logic

**B) Immediate hard close**
- Close all connections immediately
- Pros: Simplest. Fast restart
- Cons: In-flight mutations may be lost. WS clients get no signal. Data integrity risk

**C) Wait for all pending sync pushes**
- Block shutdown until all in-progress pushes complete
- Pros: Maximum data safety
- Cons: Unbounded shutdown time. A slow push can hang the process forever

### Recommendation: **Option A with configurable timeout**
Add `server.shutdownTimeoutMs` (default: **10,000ms**). On SIGTERM/SIGINT:
1. Stop accepting new HTTP requests and WS connections
2. Send WS close frame (1001) to all clients
3. Wait for in-flight requests to complete (up to timeout)
4. Force-close remaining connections
5. Clean up rate limit timers (`destroy()`)

This follows the standard Node.js graceful shutdown pattern. 10s is enough for most in-flight requests without blocking deployment.

---

## 10. Prototype Pollution Protection
**Audit refs:** SEC-C8

**Current state:** No protection. `__proto__`, `constructor`, `prototype` as JSON string keys pass validation and reach downstream spread/assign operations.

### Options

**A) Reject with validation error (Recommended)**
- Return `DFQL_INVALID` with message `"Disallowed key: __proto__"`
- Pros: Explicit. Caller knows exactly what's wrong. No silent data modification. Defense in depth
- Cons: Slightly less forgiving

**B) Silently strip**
- Remove dangerous keys before processing
- Pros: Never breaks clients. "Just works"
- Cons: Silent data loss — client sends `{ __proto__: {...}, name: "test" }` and the `__proto__` field vanishes. Hard to debug. Client thinks data was saved

### Recommendation: **Option A**
Reject with a clear error. These keys should never appear in legitimate data. Silent stripping masks bugs in client code. Add the check at the validation entry point (before any spread/assign), checking recursively for nested objects too. Block list: `__proto__`, `constructor`, `prototype`.

---

## 11. Idempotency Store TTL
**Audit refs:** SCA-C4

**Current state:** `MemoryIdempotencyStore` is a plain `Map` with no eviction. The `DbIdempotencyStore` similarly has no TTL. The server config already has a `retention` field (used for change log pruning) but idempotency isn't covered.

### Recommendation

**TTL: 24 hours. Max entries: 100,000.**

Rationale:
- The client sync engine has `pushMaxRetries: 3` and `pushRetryBackoff` maxing at 60s. A mutation that hasn't been retried within 24h is never going to be retried
- 100k entries at ~200 bytes each ≈ 20MB — reasonable for a long-running process
- Eviction strategy: LRU (evict oldest entry when max exceeded) + periodic TTL sweep (every 5 minutes, like the rate limiter's 60s sweep)

Config:
```typescript
limits.idempotencyTtlMs: 86400000    // 24 hours
limits.idempotencyMaxEntries: 100000  // LRU cap
```

This fits the existing `limits` namespace in `DatafnServerConfig`. The `retention.idempotencyDays` in the config already exists for DB-backed pruning — align the memory TTL with it.

---

## 12. Authz for Unknown Resources
**Audit refs:** M-V01

**Current state:** `validateQueryAuthz` and `validateMutationAuthz` return `ok: true` for resources not found in the policy. This means any new resource is wide-open until an authz policy is explicitly added.

### Options

**A) Deny by default (Recommended)**
- Unknown resource → `FORBIDDEN`
- Pros: Secure by default. Forces explicit authz configuration. Prevents accidental exposure of new resources
- Cons: Breaking change. Adding a new resource without updating authz config will block all access

**B) Allow but warn**
- Unknown resource → `ok: true` + console warning
- Pros: Non-breaking. Visibility into gaps
- Cons: Warnings are easily ignored. Insecure default. Opposite of the schema's `multiTenant: true` secure-by-default stance

**C) Configurable default**
- Config option: `authz.defaultPolicy: "allow" | "deny"`
- Pros: User chooses their tradeoff
- Cons: Another config knob. "allow" is almost never the right default

### Recommendation: **Option A**
Deny by default. This is consistent with the codebase's secure-by-default philosophy (`multiTenant: true`, row-level namespace enabled by default). The breaking change is actually a feature — it surfaces unprotected resources. Add a clear error message: `"No authorization policy found for resource 'foo'. Define a policy or use authz.allowUnknownResources: true to allow."` Provide the escape hatch but make the secure path the default.

---

## 13. Default Payload Size Limit
**Audit refs:** M-V10

**Current state:** `maxPayloadBytes` defaults to `undefined`. The `checkPayloadLimit` and `readBodyWithLimit` functions skip enforcement when undefined. The config has no default.

### Recommendation: **5MB**

Rationale:
- DataFn payloads are JSON (mutations, queries, sync data). Typical mutation payloads are 1-50KB
- Clone responses can be larger, but those are server→client, not client→server
- Push with 500 mutations × 1KB each = 500KB — well within 5MB
- 5MB matches common defaults (Express default: 100KB, Fastify: 1MB, AWS API Gateway: 10MB)
- For DataFn's use case (structured data, not file uploads), 5MB is generous

Also fix SEC-C7 at the same time: switch from `body.length` to `Buffer.byteLength(body, 'utf8')`.

Config: `limits.maxPayloadBytes: 5_242_880` (5MB)

---

## 14. Structured Logging
**Audit refs:** L-S04

**Current state:** `console.log/warn/error` throughout. The `redactSensitiveFields` function exists but only checks `encrypt: true`.

### Options

**A) Pluggable logging interface (Recommended)**
- Define a `Logger` interface: `{ info, warn, error, debug }` with structured context parameter
- Default implementation: `console.*` with JSON output (production) or pretty-print (development)
- Users can pass their own logger (pino, winston, etc.) via config
- Pros: Zero-dependency default. Users bring their own logger. Follows DataFn's pluggable architecture (same pattern as `authContextProvider`, `kvStore`, `redis`)
- Cons: Need to define the interface and update all log sites

**B) Built-in structured logger**
- Bundle a lightweight structured logger (like pino)
- Pros: Good defaults out of the box
- Cons: Adds a dependency. May conflict with user's existing logger. Not how the rest of the config works

**C) Event-based logging**
- Emit log events via the existing event system, let users subscribe
- Pros: Decoupled
- Cons: Logging is synchronous and critical — event-based adds complexity. Missed events = missed logs

### Recommendation: **Option A**

```typescript
interface DatafnLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

// Config
{
  logger?: DatafnLogger  // default: console-based implementation
}
```

This is the lowest-effort option that gives users full control. The default console logger can add JSON formatting for production. Update `redactSensitiveFields` to also check common field names (`password`, `token`, `secret`, `authorization`).

---

## 15. `$or` Filter Operator Silent Drop
**Audit ref:** M-S16 (not in original questions but critical)

**Current state:** `$or` filter operator is silently dropped — users get unfiltered results, which is a data leak.

### Recommendation
This isn't really a decision — it's a bug. `$or` should either be implemented or rejected with a clear validation error. Since the filter system already supports `$and` and the core types reference `$or`, implement it. If that's too much work for the current phase, reject it with `DFQL_INVALID: "$or filter operator is not yet supported"`.

---

## 16. Error Message Information Disclosure
**Audit ref:** M-V09

**Current state:** Validation error messages disclose schema structure (field names, resource names, valid operations). This aids attacker enumeration.

### Options

**A) Generic errors in production, detailed in development (Recommended)**
- In production: `"Validation failed"` with an error code
- In development: Full details with field names and suggestions
- Control via config: `debug: true/false` or `NODE_ENV`
- Pros: Secure in production, developer-friendly in development
- Cons: Need to thread the debug flag through validation

**B) Always detailed**
- Pros: Best DX
- Cons: Schema enumeration in production

**C) Always generic**
- Pros: Most secure
- Cons: Terrible DX, impossible to debug

### Recommendation: **Option A**
Add `debug` (default: `process.env.NODE_ENV !== 'production'`) to server config. Validation functions check this flag. In production, return the error code and path but not the full schema details. In development, return everything.

---

## Priority Matrix

| Decision | Severity | Complexity | Recommended Action |
|---|---|---|---|
| 1. WS Auth | CRITICAL | Medium | Reuse HTTP auth on upgrade |
| 2. Change Tracking Failures | CRITICAL | Low | Fail mutation + fast retry |
| 3. Transaction Fallback | CRITICAL | Low | Error, no fallthrough |
| 4. Rolled-Back Results | CRITICAL | Low | `ok: false, rolledBack: true` |
| 5. Type Validation | CRITICAL | Medium | Strict validation |
| 6. Batch Size | CRITICAL | Low | 500 default, configurable |
| 7. Clone Pagination | CRITICAL | Medium | Default limit 10k, auto-paginate |
| 8. WS Limits/Heartbeat | HIGH | Medium | 10k/100/30s/10s defaults |
| 9. Graceful Shutdown | HIGH | Medium | Drain with 10s timeout |
| 10. Prototype Pollution | CRITICAL | Low | Reject with error |
| 11. Idempotency TTL | CRITICAL | Low | 24h TTL, 100k max |
| 12. Unknown Resource Authz | MEDIUM | Low | Deny by default |
| 13. Payload Size | MEDIUM | Low | 5MB default |
| 14. Structured Logging | LOW | Medium | Pluggable interface |
| 15. `$or` Silent Drop | HIGH | Medium | Implement or reject |
| 16. Error Disclosure | MEDIUM | Low | Generic in prod, detailed in dev |

## Table of contents

- DX-001 — Nucleus ergonomics without Flux-style wrapper stores
- NUC-001 — Nucleus removes Flux runtime usage
- NUC-002 — Nucleus replaces global mutation event filtering with datafn subscriptions/signals
- NUC-003 — Nucleus replaces KeyValueStore with datafn KV API
- NUC-004 — Nucleus extension uses `sync.remoteAdapter` + remote event propagation
- CFG-001 — Remote adapter injection (`sync.remoteAdapter`)
- CFG-002 — Local-only mode support
- API-001 — Resource-aware ID generation (`generateId({resource,idPrefix})`)
- API-002 — Mutation context support (`mutation.context`)
- EVT-001 — Mutation event payload completeness
- EVT-002 — Context filtering (keys + shallow equality)
- SIG-001 — Selective signal invalidation (resource + relations)
- SIG-002 — Debounced/batched signal refresh
- KV-001 — Built-in KV resource existence and persistence
- KV-002 — KV convenience API semantics (get/set/merge/delete/signal)
- SYNC-001 — Paginated clone protocol (records + joins)
- SYNC-002 — Hydration plan (boot vs background resources)
- SYNC-003 — Pull protocol supports per-table cursors (canonical)
- SYNC-004 — Pull backward compatibility (legacy global cursor)
- SYNC-005 — Push supports relation mutations
- SYNC-006 — Join row propagation via clone/pull/apply
- SYNC-007 — Reconcile endpoint (counts) and client reconcile
- OFFQ-001 — Index-aware local query routing (id eq, indexed eq)
- OFFQ-002 — Local filter operator coverage ($and/$or, comparisons, in/nin)
- OFFM-001 — Offline apply for relation mutations (relate/modifyRelation/unrelate)
- CODEC-001 — Date field codec (serialize + parse)
- HOOK-001 — Client runs beforeSync/afterSync hooks for all sync phases
- EVT-003 — Sync lifecycle events emitted with deterministic context
- AUTH-001 — Server permissions policy shape and enforcement
- AUTH-002 — Namespace correctness (no hard-coded namespace in execution)
- EXT-001 — Extension mode remote event propagation contract

---

### DX-001

- **ID**: DX-001
- **Priority**: P0
- **Statement**: Nucleus MUST use datafn tables/signals/subscriptions directly and MUST NOT introduce Flux-like wrapper stores that replace or hide signal-driven reactivity.
- **Rationale**: Wrapping datafn in ResourceStore-style abstractions risks losing the core benefits (signals, shared invalidation, deterministic query keys).
- **Acceptance criteria**:
  - Nucleus components that render data use `table.signal(...)` + `toSvelteStore(...)` (or equivalent) as their primary reactive read mechanism.
  - “Common operations” (archive/trash/lock/etc) are implemented as small stateless utility functions that call `table.mutate(...)` and do not own cached state.
  - UI-only state (e.g., “active editing record”) remains in UI stores/components and is not persisted as a parallel data cache.
- **Test vectors**: TV-NUC-005 (positive), TV-NUC-005N (negative)
- **Notes**:
  - This requirement constrains architecture, not runtime semantics; violations are detectable by import graphs and file-level conventions.

### NUC-001

- **ID**: NUC-001
- **Priority**: P0
- **Statement**: Nucleus MUST remove Flux from runtime data paths and MUST use datafn as the sole data runtime for querying, mutations, subscriptions, and sync.
- **Rationale**: User explicitly requires immediate refactor with no phased migration and no intermediate abstractions.
- **Acceptance criteria**:
  - Nucleus app build succeeds without importing `client/components/flux/**` in runtime bundles.
  - No code path dispatches or listens to Flux `GlobalEvent.MUTATION` for data invalidation.
  - Data reads and writes go through `@datafn/client` surfaces.
- **Test vectors**: TV-NUC-001 (positive), TV-NUC-001N (negative)
- **Notes**:
  - Flux code may remain in repo for reference but MUST not be on the runtime path.

### NUC-002

- **ID**: NUC-002
- **Priority**: P0
- **Statement**: Nucleus MUST replace `ComponentBaseLayer` mutation filtering with datafn subscriptions/signals supporting resource, id, context, and field-based filtering equivalently.
- **Rationale**: Flux UI reactivity relies on granular mutation event filtering; this must be preserved.
- **Acceptance criteria**:
  - Filters by resource and ids are implemented using `DatafnEventFilter.resource` and `DatafnEventFilter.ids`.
  - Filters by context value are implemented using `DatafnEventFilter.context` (shallow equality) or a deterministic normalization of string contexts to object form.
  - Field-based filtering for merge-like updates uses `DatafnEventFilter.fields`.
- **Test vectors**: TV-NUC-002 (positive), TV-NUC-002N (negative)
- **Notes**:
  - The exact UI refresh behavior is app-specific; this requirement focuses on the filtering capability parity.

### NUC-003

- **ID**: NUC-003
- **Priority**: P0
- **Statement**: Nucleus MUST replace Flux `KeyValueStore` usage with `client.kv` and preserve persisted semantics across reloads and offline usage.
- **Rationale**: KV is a core persistence surface in Nucleus; Flux KeyValueStore must be replaced cleanly.
- **Acceptance criteria**:
  - Nucleus KV reads use `client.kv.get(...)` (or signals for reactive reads).
  - KV writes use `client.kv.set/merge/delete(...)` with context tags where needed.
  - KV persists in IndexedDB and is available in local-only mode.
- **Test vectors**: TV-NUC-003 (positive), TV-NUC-003N (negative)
- **Notes**:
  - Data migration from old Flux KV storage is addressed as a consumer integration task (Phase 13) if required.

### NUC-004

- **ID**: NUC-004
- **Priority**: P1
- **Statement**: Nucleus extension contexts MUST configure datafn with `sync.remoteAdapter` and MUST receive background-originated mutation/sync events via remote event propagation.
- **Rationale**: Flux currently mediates extension delegation; datafn must replace it fully.
- **Acceptance criteria**:
  - Content/sidepanel code does not open IndexedDB directly when background is authoritative (single source of truth).
  - `client.subscribe()` in content/sidepanel receives events emitted by the background runtime.
  - Unsubscribe stops deliveries deterministically.
- **Test vectors**: TV-NUC-004 (positive), TV-NUC-004N (negative)
- **Notes**:
  - This requirement is satisfied by EXT-001 plus correct Nucleus configuration.

### CFG-001

- **ID**: CFG-001
- **Priority**: P0
- **Statement**: The client MUST support `sync.remoteAdapter?: DatafnRemoteAdapter` and MUST use it for all remote calls when provided.
- **Rationale**: Required to support extension transports and non-HTTP remotes, and to unblock direct Nucleus refactor without Flux relays.
- **Acceptance criteria**:
  - When `sync.remoteAdapter` is present, all `query/mutation/transact/seed/clone/pull/push` calls go through it.
  - When `sync.remoteAdapter` is absent and `sync.remote` is present, the default HTTP transport is used.
  - When both are present, `remoteAdapter` takes precedence deterministically.
  - If neither is present in `mode: "sync"`, the client throws a deterministic config error.
- **Test vectors**: TV-CFG-001 (positive), TV-CFG-001N (negative)
- **Notes**:
  - WebSocket wakeups depend on `wsUrl` or `remote` for derivation; this is specified in SPEC.md.

### CFG-002

- **ID**: CFG-002
- **Priority**: P0
- **Statement**: The client MUST support `sync.mode: "local-only"` where queries and mutations execute locally without a remote.
- **Rationale**: Flux supports guest/local mode; Nucleus requires equivalent capability.
- **Acceptance criteria**:
  - In `local-only`, `createDatafnClient` succeeds without `sync.remote` or `sync.remoteAdapter`.
  - In `local-only`, all non-remote-only resources are treated as hydrated (`ready`) for query routing.
  - In `local-only`, `mutate()` applies locally and appends to changelog.
  - `sync.start()` MUST be a no-op and MUST NOT throw.
- **Test vectors**: TV-CFG-002 (positive), TV-CFG-002N (negative)
- **Notes**:
  - Local-only still requires `clientId` when storage/offlinability are enabled.

### API-001

- **ID**: API-001
- **Priority**: P0
- **Statement**: The client MUST support resource-aware ID generation via `generateId({ resource, idPrefix })` and MUST ensure inserted IDs respect schema prefix rules.
- **Rationale**: Nucleus IDs are resource-prefixed; Flux code assumes `resource:id` formatting.
- **Acceptance criteria**:
  - For inserts without explicit `id`, the client generates an id that begins with `schema.resources[].idPrefix` if set, else `${resource}:`.
  - Generated IDs are deterministic given the chosen generator and inputs (no hidden randomness beyond generator).
  - If the generator returns an invalid id (wrong prefix), the client rejects the mutation with deterministic error `DFQL_INVALID`.
- **Test vectors**: TV-ID-001 (positive), TV-ID-001N (negative)
- **Notes**:
  - This requirement does not constrain the suffix format (UUID/ULID/etc) beyond prefix rules.

### API-002

- **ID**: API-002
- **Priority**: P0
- **Statement**: DFQL mutations MUST accept an optional `context` object and the client and server MUST propagate it into events, hooks, and logs (with redaction rules).
- **Rationale**: Nucleus subscriptions rely on mutation context filtering; auditability requires context.
- **Acceptance criteria**:
  - `context` is accepted on all mutation operations (record and relation).
  - Client emits `mutation_applied/mutation_rejected` events with `event.context` equal to mutation.context (or omitted if absent).
  - Server hooks receive the context in hook ctx (or payload) deterministically.
  - Logging includes context keys only (or redacted values) as configured.
- **Test vectors**: TV-CTX-001 (positive), TV-CTX-001N (negative)
- **Notes**:
  - `context` MUST be JSON-serializable; non-serializable values are rejected.

### EVT-001

- **ID**: EVT-001
- **Priority**: P0
- **Statement**: Mutation events MUST include `resource`, `ids`, `mutationId`, `clientId`, `action`, `fields`, `timestampMs`, and `context` (when provided) deterministically.
- **Rationale**: Fine-grained subscriptions and signals require complete metadata.
- **Acceptance criteria**:
  - For any successful mutation, a `mutation_applied` event is emitted with full metadata.
  - For any failed mutation (result error or thrown), a `mutation_rejected` event is emitted with full metadata and deterministic `context` error payload.
  - `fields` are derived from `mutation.record` keys excluding `id`, sorted lexicographically.
  - `action` equals `mutation.operation`.
- **Test vectors**: TV-EVT-001 (positive), TV-EVT-001N (negative)
- **Notes**:
  - Batch mutations emit one event per mutation (deterministic order = input order).

### EVT-002

- **ID**: EVT-002
- **Priority**: P0
- **Statement**: Event subscriptions MUST support filtering by context keys and by shallow key/value equality against `event.context`.
- **Rationale**: Nucleus filters by specific context values (e.g. “ComponentBaseLayer”).
- **Acceptance criteria**:
  - `contextKeys` matches only if all keys exist.
  - `context` matches only if every key/value pair matches (`===`) on `event.context`.
  - If `event.context` is missing, any context filter fails to match.
- **Test vectors**: TV-EVT-002 (positive), TV-EVT-002N (negative)
- **Notes**:
  - Deep matching is Undefined (not required).

### SIG-001

- **ID**: SIG-001
- **Priority**: P0
- **Statement**: Signals MUST refresh only when a mutation could affect their query footprint (primary resource or referenced relations), not on all mutations of the same resource unconditionally.
- **Rationale**: Prevents UI thrash in Nucleus-scale apps.
- **Acceptance criteria**:
  - Each signal registers a footprint derived from normalized DFQL query (resource + relation resources referenced by select tokens).
  - On events, only signals whose footprint intersects the event’s affected resources refresh.
  - Relation mutations affecting join stores trigger refresh for signals that expand that relation.
- **Test vectors**: TV-SIG-001 (positive), TV-SIG-001N (negative)
- **Notes**:
  - Footprint derivation rules are normative in SPEC.md.

### SIG-002

- **ID**: SIG-002
- **Priority**: P0
- **Statement**: Signal refreshes MUST be batched/debounced so multiple matching mutations in the same tick cause at most one refresh per signal.
- **Rationale**: Matches Flux’s practical “debounce at source” behavior and prevents redundant local/remote queries.
- **Acceptance criteria**:
  - For N matching events within the debounce window, only 1 refresh executes.
  - A queued refresh executes after the in-flight refresh completes (no lost updates).
- **Test vectors**: TV-SIG-002 (positive), TV-SIG-002N (negative)
- **Notes**:
  - Debounce window value is configurable; default is specified in SPEC.md.

### KV-001

- **ID**: KV-001
- **Priority**: P0
- **Statement**: The system MUST provide a built-in KV resource/table that exists in client storage and on server regardless of consumer schema.
- **Rationale**: Replaces Flux `KeyValueStore` ergonomics; Nucleus relies heavily on KV state.
- **Acceptance criteria**:
  - Client storage adapters create a dedicated KV store.
  - Server supports KV persistence and sync under namespace isolation.
  - KV entries are queryable and syncable offline-first.
- **Test vectors**: TV-KV-001 (positive), TV-KV-001N (negative)
- **Notes**:
  - KV keys are strings; canonical id mapping is specified in SPEC.md.

### KV-002

- **ID**: KV-002
- **Priority**: P0
- **Statement**: The KV API MUST support `get/set/merge/delete/signal` with deterministic semantics and event emission.
- **Rationale**: Required to replace Flux kv auto-persist patterns without wrapper stores.
- **Acceptance criteria**:
  - `set` replaces value and emits mutation events with context.
  - `merge` shallow-merges object values and emits mutation events with fields listing changed keys.
  - `signal(key)` refreshes when that key changes (not on all KV mutations).
- **Test vectors**: TV-KV-002 (positive), TV-KV-002N (negative)
- **Notes**:
  - Merge semantics for non-object values must reject with deterministic error.

### SYNC-001

- **ID**: SYNC-001
- **Priority**: P0
- **Statement**: Clone MUST support pagination and MUST optionally include join rows so large datasets can hydrate without OOM and relations work offline.
- **Rationale**: Flux supports clone pagination; Nucleus needs scalable hydration.
- **Acceptance criteria**:
  - Clone request can specify `{ page: { table, afterId, limit } }`.
  - Clone response includes `next` when more pages exist.
  - When `includeJoins` is true, join rows are included in response.
- **Test vectors**: TV-SYNC-001 (positive), TV-SYNC-001N (negative)
- **Notes**:
  - Paging order is deterministic: `id:asc`.

### SYNC-002

- **ID**: SYNC-002
- **Priority**: P0
- **Statement**: The client sync engine MUST support a hydration plan that hydrates `bootResources` first and hydrates `backgroundResources` asynchronously.
- **Rationale**: Matches Flux “essential clone then paginate” behavior without Flux.
- **Acceptance criteria**:
  - Boot resources reach `ready` before the client reports boot hydration done.
  - Background resources remain `hydrating` until complete.
  - Queries touching hydrating resources use remote fallback when remote exists.
- **Test vectors**: TV-SYNC-002 (positive), TV-SYNC-002N (negative)
- **Notes**:
  - Local-only mode is a special case (no remote fallback).

### SYNC-003

- **ID**: SYNC-003
- **Priority**: P0
- **Statement**: Pull MUST support canonical per-table cursors and MUST return record upserts/deletes and join row deltas with updated cursors.
- **Rationale**: Enables selective pulls and correct partial hydration.
- **Acceptance criteria**:
  - Pull accepts `{ cursors: { [resource]: cursor } }`.
  - Response returns `{ records, deleted, joins, cursors }`.
  - Cursor updates are monotonic per resource.
- **Test vectors**: TV-SYNC-003 (positive), TV-SYNC-003N (negative)
- **Notes**:
  - Global cursor remains derived (optimization).

### SYNC-004

- **ID**: SYNC-004
- **Priority**: P1
- **Statement**: The server MUST accept the legacy global-cursor pull request shape for backward compatibility during a defined compatibility window.
- **Rationale**: Existing clients/tests currently use global cursor.
- **Acceptance criteria**:
  - `{ clientId, cursor, limit }` is accepted and returns the legacy `{ changes, nextCursor }` shape.
  - The server documents a deterministic deprecation path (versioning section).
- **Test vectors**: TV-SYNC-004 (positive), TV-SYNC-004N (negative)
- **Notes**:
  - Nucleus refactor uses per-table cursors; this is ecosystem compatibility.

### SYNC-005

- **ID**: SYNC-005
- **Priority**: P0
- **Statement**: Push MUST accept and apply relation mutations (`relate/modifyRelation/unrelate`) with idempotency and change tracking.
- **Rationale**: Required for offline relation operations to sync across devices.
- **Acceptance criteria**:
  - Push validation accepts relation operations per schema.
  - Applied relation mutations record join deltas in change tracking.
  - Idempotency works for relation mutations the same as record mutations.
- **Test vectors**: TV-REL-001 (positive), TV-REL-001N (negative)
- **Notes**:
  - Join table naming and polymorphic support are specified in SPEC.md.

### SYNC-006

- **ID**: SYNC-006
- **Priority**: P0
- **Statement**: Clone and pull MUST hydrate join rows into client join stores so many-many expansion works offline deterministically.
- **Rationale**: Client offline query relation expansion depends on join stores.
- **Acceptance criteria**:
  - Clone includes join rows when requested.
  - Pull includes join row upsert/delete deltas when they occur.
  - Client apply logic routes join deltas to `storage.upsertJoinRow/deleteJoinRow`.
- **Test vectors**: TV-REL-002 (positive), TV-REL-002N (negative)
- **Notes**:
  - Hydration state semantics for joins are specified in SPEC.md.

### SYNC-007

- **ID**: SYNC-007
- **Priority**: P1
- **Statement**: The system MUST provide reconcile/repair via a server counts endpoint and a client `sync.reconcileNow()` that rehydrates mismatched resources/joins.
- **Rationale**: Flux has reconcile to repair drift and large sync-down anomalies.
- **Acceptance criteria**:
  - Server returns deterministic counts for requested resources and join stores.
  - Client compares counts and triggers re-clone for mismatches.
  - Reconcile emits `sync_applied` or `sync_failed` events with `phase: "reconcile"`.
- **Test vectors**: TV-RECON-001 (positive), TV-RECON-001N (negative)
- **Notes**:
  - Hash/digest-based reconcile is Undefined unless explicitly implemented.

### OFFQ-001

- **ID**: OFFQ-001
- **Priority**: P0
- **Statement**: Local query execution MUST be index-aware for `id eq` and indexed `field eq` filters to avoid full scans.
- **Rationale**: Nucleus datasets are large; full scans are not acceptable.
- **Acceptance criteria**:
  - `filters: { id: { eq: X } }` uses `getRecord`.
  - `filters: { field: { eq: V } }` uses `findRecords` when the index exists.
  - Fallback to scan is allowed only when index is unavailable.
- **Test vectors**: TV-OFFQ-001 (positive), TV-OFFQ-001N (negative)
- **Notes**:
  - Deterministic ordering for equal values must be preserved.

### OFFQ-002

- **ID**: OFFQ-002
- **Priority**: P0
- **Statement**: Local filter evaluation MUST support `$and`, `$or`, comparisons, and set membership operators as specified in SPEC.md.
- **Rationale**: Nucleus requires expressive local queries for offline-first UX.
- **Acceptance criteria**:
  - `$or` short-circuits deterministically.
  - Comparisons behave consistently across number/date/string types (with explicit coercion rules).
  - Unsupported operators are rejected with deterministic error `DFQL_UNSUPPORTED`.
- **Test vectors**: TV-OFFQ-002 (positive), TV-OFFQ-002N (negative)
- **Notes**:
  - Nested path filtering is Undefined unless explicitly specified.

### OFFM-001

- **ID**: OFFM-001
- **Priority**: P0
- **Statement**: Offline mutation apply MUST support `relate`, `modifyRelation`, and `unrelate` for schema-defined relations, updating join stores/FKs deterministically.
- **Rationale**: User explicitly requested offline relation apply; required for parity and correctness.
- **Acceptance criteria**:
  - For many-many: upsert/delete join rows in the correct join store(s).
  - For modifyRelation: update metadata for an existing join row or reject with NOT_FOUND.
  - For many-one/one-many: update/clear FK fields deterministically when relation operations are used.
- **Test vectors**: TV-OFFM-001 (positive), TV-OFFM-001N (negative)
- **Notes**:
  - Polymorphic relations MUST be supported where schema defines arrays.

### CODEC-001

- **ID**: CODEC-001
- **Priority**: P1
- **Statement**: The client MUST provide a schema-driven date codec that serializes Date fields on outbound mutations and parses date fields to Date objects on inbound query results.
- **Rationale**: Flux DataMapper parses dates; Nucleus code expects Date objects.
- **Acceptance criteria**:
  - Outbound: Date → ISO 8601 string.
  - Inbound: ISO 8601 string → Date for fields of type `date`.
  - Invalid date strings are rejected deterministically (`DFQL_INVALID`) or surfaced as query errors.
- **Test vectors**: TV-CODEC-001 (positive), TV-CODEC-001N (negative)
- **Notes**:
  - Codec runs must preserve determinism; timezone handling is explicit (UTC).

### HOOK-001

- **ID**: HOOK-001
- **Priority**: P1
- **Statement**: The client MUST run `beforeSync/afterSync` hooks for `seed/clone/pull/push/cloneUp/reconcile` phases.
- **Rationale**: Intent/spec requires sync hooks; Nucleus requires observability and extension points.
- **Acceptance criteria**:
  - Hooks run in registration order.
  - `beforeSync` is fail-closed; `afterSync` is fail-open.
  - Hook context includes schema and phase and deterministic payload/result.
- **Test vectors**: TV-HOOK-001 (positive), TV-HOOK-001N (negative)
- **Notes**:
  - Hook error shapes must include deterministic `path` entries.

### EVT-003

- **ID**: EVT-003
- **Priority**: P1
- **Statement**: The client MUST emit `sync_applied` and `sync_failed` events for all sync phases with deterministic context payloads.
- **Rationale**: Nucleus UI needs sync status feedback; Flux emits syncDown events.
- **Acceptance criteria**:
  - On success: `sync_applied` includes `context.phase` and relevant cursor/resource stats.
  - On failure: `sync_failed` includes `context.phase` and error information.
- **Test vectors**: TV-EVT-003 (positive), TV-EVT-003N (negative)
- **Notes**:
  - A separate `sync_started` event is Undefined unless added explicitly.

### AUTH-001

- **ID**: AUTH-001
- **Priority**: P1
- **Statement**: The server MUST define and enforce a permissions policy for resources and fields, rejecting unauthorized access with `FORBIDDEN`.
- **Rationale**: Spec intent requires server-side authz; needed for production correctness.
- **Acceptance criteria**:
  - Query validates select/filter fields against allowed read fields.
  - Mutation validates record fields against allowed write fields.
  - Owner-scoped resources enforce actor ownership rules when configured.
- **Test vectors**: TV-AUTH-001 (positive), TV-AUTH-001N (negative)
- **Notes**:
  - Exact policy shape is defined in SPEC.md Security section.

### AUTH-002

- **ID**: AUTH-002
- **Priority**: P0
- **Statement**: All server execution paths MUST use the extracted namespace consistently (no hard-coded `"datafn"` namespace) for DB operations and change tracking.
- **Rationale**: Prevents cross-tenant leakage and maintains correct ordering per user/tenant.
- **Acceptance criteria**:
  - Mutation endpoint, push, pull, clone, and relation operations use `namespace` parameter consistently.
  - Change tracking entries are keyed by namespace and cannot cross-contaminate.
- **Test vectors**: TV-AUTH-002 (positive), TV-AUTH-002N (negative)
- **Notes**:
  - This requirement applies even in single-tenant mode (namespace = default).

### EXT-001

- **ID**: EXT-001
- **Priority**: P1
- **Statement**: In extension environments, the client MUST support remote event propagation such that `client.subscribe()` observes mutation and sync events originating in the authoritative background runtime.
- **Rationale**: Flux uses extension mediation; Nucleus requires equivalent behavior with datafn.
- **Acceptance criteria**:
  - When using an extension remote adapter, local event bus is fed by inbound remote events.
  - Subscription lifecycle supports subscribe/unsubscribe without leaks.
- **Test vectors**: TV-EXT-001 (positive), TV-EXT-001N (negative)
- **Notes**:
  - BroadcastChannel fanout is optional, but message bus fanout is required.


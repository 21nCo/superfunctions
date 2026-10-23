## Metadata

- **timestamp**: 2026-02-06T08:02:33Z
- **agent_name**: unknown-agent
- **model**: GPT-5.2
- **launcher**: Cursor
- **workspace_root**: `/Users/ar/dev`
- **project_root**: `/Users/ar/dev/superfunctions/datafn`
- **OS**: darwin 25.0.0
- **shell**: zsh
- **repo (datafn / superfunctions)**:
  - **is_git_repo**: true
  - **branch**: `heads/next`
  - **commit**: `98c71853911e3aa96e9a72f892ee34e720ccc553`
  - **dirty**: true
- **repo (nucleus)**:
  - **is_git_repo**: true
  - **branch**: `dev`
  - **commit**: `a23d27444e72aed68feab1ca928b9885a1edb881`
  - **dirty**: true
- **spec_type**: audit-fix
- **spec_id**: k4m2p9x7
- **spec_folder**: `2026-02-06-audit-fix-k4m2p9x7-spec`
- **spec_path**: `/Users/ar/dev/superfunctions/datafn/.conduct/specs/2026-02-06-audit-fix-k4m2p9x7-spec`
- **authoritative inputs read**:
  - `/Users/ar/dev/superfunctions/datafn/.conduct/intent/datafn.intent.md`
  - `/Users/ar/dev/superfunctions/datafn/.conduct/intent/spec.md`
  - `/Users/ar/dev/superfunctions/datafn/.conduct/intent/implementation.md`
  - `/Users/ar/dev/superfunctions/datafn/.conduct/intent/migration-plan-from-nucleus.md`
  - `/Users/ar/dev/superfunctions/datafn/.conduct/other/EXPLANATION.md`
  - `/Users/ar/dev/superfunctions/datafn/.conduct/other/DESIGN_ANALYSIS_PER_RESOURCE_STORES.md`
  - `/Users/ar/dev/nucleus/client/components/flux/flux.ts`
  - `/Users/ar/dev/nucleus/client/components/flux/resourceStores/resource.store.ts`
  - `/Users/ar/dev/nucleus/client/components/flux/resourceStores/kv.store.ts`
  - `/Users/ar/dev/nucleus/client/layout/layers/ComponentBaseLayer.svelte`
- **audit reference**:
  - This spec fixes gaps identified by a Flux→datafn gap analysis performed in this session by inspecting Nucleus Flux implementation and current datafn implementation. There is no standalone audit artifact created specifically for this spec.

## Context

- **Project name**: `datafn` (superfunctions monorepo) + immediate adoption in `nucleus`
- **One-sentence goal**: Close all identified Flux→datafn parity gaps and refactor Nucleus to use datafn directly (no Flux, no migration shims) while preserving offline-first sync, reactivity, subscriptions, extension operation, and determinism.
- **Target users**:
  - Developers: Nucleus maintainers integrating `@datafn/*`.
  - End-users: Nucleus web and extension users relying on offline-first operation and reactive UI.
- **Target environments**:
  - Browser (Svelte app): online/offline, IndexedDB storage.
  - Browser extension: background/service worker, sidepanel, content script; message bus transport; optional BroadcastChannel where available.
  - Server (Node): `@datafn/server` mounted in Nucleus backend.
- **Languages/packages required**:
  - TypeScript packages: `@datafn/core`, `@datafn/client`, `@datafn/server`, `@datafn/svelte`.
  - Nucleus: Svelte + TypeScript.
- **Existing systems to integrate with**:
  - Nucleus UI patterns: resource-centric data access, change subscriptions with context filtering, and reactive stores.
  - Extension messaging infrastructure (message bus).
  - Host-app auth context and multi-tenant namespace isolation.
- **Data model summary**:
  - Nucleus resources (non-exhaustive): `node`, `collection`, `task`, `goal`, `link`, and many KV-style preference/state values.
  - Relations exist conceptually (parent/children, collections contain items, tags/properties, etc). This spec requires many-many relation join rows to be first-class offline + sync-capable.
- **Security model**:
  - Schema-bounded validation on all requests.
  - Server-side authz enforcement (table/field-level) based on a defined permission policy shape.
  - Namespace isolation per user/tenant for change tracking and DB operations.
  - Sensitive data must not leak via logs/events.
- **Performance constraints**:
  - Must handle large datasets (clone/rehydration) without blocking UI or exhausting memory.
  - Local queries must avoid full-table scans when indexable.
  - Reactive invalidation must avoid “refresh on every mutation” thrash.
- **Non-goals / out of scope**:
  - No “phased migration” compatibility layer between Flux and datafn. Nucleus will be refactored to datafn directly.
  - No redefinition of DFQL beyond what is required to close gaps (this spec extends shapes only where necessary).
  - No product UX changes beyond those required to preserve existing behavior (e.g., edit/focus mode remains UI-owned).
- **Hard constraints**:
  - Deterministic behavior: stable ordering, stable event metadata derivation, deterministic sync application.
  - Idempotency: `(clientId, mutationId)` MUST dedupe retries for sync and offline.

## Overview

This spec defines the required changes to `datafn` (client/server/storage/adapters) and the required Nucleus refactor so that:

- Nucleus can drop Flux entirely and rely on datafn for:
  - reactivity (signals + framework adapters)
  - change subscriptions (fine-grained events with context/value filtering)
  - offline-first mutations (including relation mutations) and durable changelog
  - sync (clone/pull/push/cloneUp) with scalable hydration strategies
  - KV-style state (special KV support to replace Flux KeyValueStore ergonomics)
  - extension operation (remote adapter injection + remote event propagation)
- All behaviors are deterministic and testable via golden vectors.

The spec covers **all gaps identified** in the Flux→datafn gap analysis:

1) local-only mode
2) remote adapter injection (`sync.remoteAdapter?: DatafnRemoteAdapter`)
3) context-aware subscriptions (value-level)
4) selective + debounced reactive invalidation
5) Nucleus data ergonomics without losing signals (no heavy wrapper stores)
6) clone scalability (pagination + hydration plan)
7) pull cursor model alignment (per-table vs global; decision documented)
8) reconcile/repair
9) local query performance + operator coverage
10) offline apply for relation mutations (plus full sync propagation)
11) ID conventions + date mapping
12) client sync hooks + sync events
13) server authz/permissions enforcement (plus namespace isolation correctness)

## Glossary

- **DFQL**: DataFn Query Language JSON shape for queries, mutations, and transactions.
- **Resource / table**: A schema-defined record collection (e.g., `node`, `task`).
- **Record**: JSON object with required `id: string` plus schema fields.
- **Relation**: Schema-defined association between resources (`many-one`, `one-many`, `many-many`, `htree`).
- **Join row**: A stored row representing a many-many relation edge; contains at minimum `{ from, to }` plus optional metadata.
- **Join store**: Client-side IndexedDB object store dedicated to a relation edge set.
- **Mutation context**: Optional metadata attached to a mutation for auditability and subscription filtering.
- **Event**: An emitted `DatafnEvent` representing a mutation or sync lifecycle signal.
- **Signal**: A `DatafnSignal<T>` representing a reactive query result.
- **Hydration state**: Per-resource state machine: `notStarted → hydrating → ready`.
- **Cursor**: A monotonic server sequence (base-10 integer string) used to track sync progress.
- **Global cursor**: The maximum cursor across resources; used for optimization and websocket wakeups.
- **Namespace**: Server-side isolation key derived from auth context (e.g., `tenant:...:user:...`) used for DB operations and change tracking.
- **Local-only mode**: Client mode where no remote is configured but storage + offline semantics still function (guest/offline app use).
- **Remote adapter**: `DatafnRemoteAdapter` implementation for transport (HTTP, extension message bus, etc).

## Goals / Non-goals

### Goals

- Nucleus MUST be able to remove Flux and use datafn directly for data access and reactivity.
- datafn MUST support local-only operation (no remote) without breaking mutate/query semantics.
- datafn MUST support extension contexts via `sync.remoteAdapter?: DatafnRemoteAdapter`.
- datafn events MUST support context (value-level filtering), ids, action, and fields.
- datafn signals MUST refresh selectively and with batching/debouncing to avoid UI thrash.
- datafn MUST provide first-class KV support that replaces Flux `KeyValueStore` ergonomics without treating KV as “just another app table”.
- datafn sync MUST scale to large datasets via paginated clone and partial hydration strategies.
- datafn MUST support offline relation mutations end-to-end (local apply + push + pull/clone hydration of join rows).
- datafn MUST enforce deterministic behavior and clear failure modes.
- Server MUST enforce authz/permissions and namespace isolation.

### Non-goals

- This spec does not require Flux API compatibility shims.
- This spec does not require CRDTs or advanced conflict UX; default conflict remains LWW by server ordering unless overridden by server plugins (as already intended).

## Public API

### Client configuration

`@datafn/client` MUST support an injectable remote adapter.

```ts
export interface DatafnRemoteAdapter {
  query(q: unknown): Promise<unknown>;
  mutation(m: unknown): Promise<unknown>;
  transact(t: unknown): Promise<unknown>;
  seed(payload: unknown): Promise<unknown>;
  clone(payload: unknown): Promise<unknown>;
  pull(payload: unknown): Promise<unknown>;
  push(payload: unknown): Promise<unknown>;
}

export interface DatafnSyncConfig {
  offlinability?: boolean;

  /**
   * Remote server URL used by the default HTTP transport and for deriving wsUrl.
   * Optional when `remoteAdapter` is provided.
   */
  remote?: string;

  /**
   * Optional injected adapter used instead of DefaultHttpTransport.
   * Required for extension environments.
   */
  remoteAdapter?: DatafnRemoteAdapter;

  ws?: boolean;
  wsUrl?: string;
  pushInterval?: number;
  pushBatchSize?: number;
  pushMaxRetries?: number;

  /**
   * Hydration plan for large datasets.
   */
  hydration?: {
    /**
     * Resources that MUST be cloned to `ready` before the app can consider itself hydrated.
     */
    bootResources?: string[];
    /**
     * Resources that MAY hydrate in the background after boot.
     */
    backgroundResources?: string[];
    /**
     * Per-resource clone page size limits used by paginated clone.
     */
    clonePageSize?: number | Record<string, number>;
  };

  /**
   * Explicit mode selection.
   * - "sync": requires remote or remoteAdapter.
   * - "local-only": remote is not required; all local tables start as `ready`.
   */
  mode?: "sync" | "local-only";
}

export interface DatafnClientConfig<S extends DatafnSchema> {
  schema: S;
  sync?: DatafnSyncConfig;
  plugins?: DatafnPlugin[];
  clientId: string;
  storage?: DatafnStorageAdapter | DatafnStorageFactory;
  authContext?: AuthContext | AuthContextProvider;

  /**
   * Resource-aware ID generator (replaces generateId()).
   */
  generateId?: (params: { resource: string; idPrefix?: string }) => string;
}
```

### Table API (unchanged shape, clarified semantics)

`DatafnTable` remains the primary authoring surface for Nucleus (no Flux-style wrapper stores required).

```ts
export interface DatafnTable<S extends DatafnSchema = DatafnSchema> {
  name: string;
  version: number;

  query(q: DfqlQueryFragment): Promise<unknown>;
  mutate(m: DfqlMutationFragment | DfqlMutationFragment[]): Promise<unknown>;
  transact(payload: DfqlTransact): Promise<unknown>;
  signal(q: DfqlQueryFragment): DatafnSignal<unknown>;
  subscribe(handler: (e: DatafnEvent) => void, filter?: DatafnEventFilter): () => void;
}
```

### KV API (new)

`@datafn/client` MUST expose a first-class KV facade that is available regardless of user schema content.

```ts
export interface DatafnKvApi {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(
    key: string,
    value: T,
    params?: { context?: Record<string, unknown> }
  ): Promise<{ ok: true; key: string } | { ok: false; error: DatafnError }>;
  merge(
    key: string,
    patch: Record<string, unknown>,
    params?: { context?: Record<string, unknown> }
  ): Promise<{ ok: true; key: string } | { ok: false; error: DatafnError }>;
  delete(
    key: string,
    params?: { context?: Record<string, unknown> }
  ): Promise<{ ok: true; key: string } | { ok: false; error: DatafnError }>;

  /**
   * Reactive read of a KV key (Svelte-friendly via @datafn/svelte helpers).
   */
  signal<T = unknown>(
    key: string,
    options?: { defaultValue?: T }
  ): DatafnSignal<T>;
}
```

### Mutation context (new)

DFQL mutations MUST accept an optional `context` object which is propagated to events and hooks.

```ts
export type DfqlMutation = {
  resource: string;
  version: number;
  operation: "insert" | "merge" | "replace" | "delete" | "relate" | "modifyRelation" | "unrelate";
  id: string;
  record?: Record<string, unknown>;
  relations?: Record<string, unknown>;
  if?: unknown;
  clientId?: string;
  mutationId?: string;

  /**
   * Optional audit/subscription context.
   * MUST be JSON-serializable and deterministic.
   */
  context?: Record<string, unknown>;
};
```

### Events + filters (extended)

`DatafnEvent` MUST include `context` for mutation events.

```ts
export interface DatafnEvent {
  type: "mutation_applied" | "mutation_rejected" | "sync_applied" | "sync_failed";
  resource?: string;
  ids?: string[];
  mutationId?: string;
  clientId?: string;
  timestampMs: number;
  action?: string; // derived from mutation.operation
  fields?: string[]; // derived from mutation.record keys (excluding id)
  context?: Record<string, unknown>; // NEW: mutation context propagation
}

export type DatafnEventFilter = Partial<{
  type: DatafnEvent["type"] | Array<DatafnEvent["type"]>;
  resource: string | string[];
  ids: string | string[];
  mutationId: string | string[];
  action: string | string[];
  fields: string | string[];

  /**
   * Context matching.
   * - contextKeys: all keys MUST exist on event.context.
   * - context: all key/value pairs MUST match (shallow match).
   */
  contextKeys: string[];
  context: Record<string, unknown>;
}>;
```

### Sync endpoints (extended)

This spec introduces new/extended sync shapes to enable:
- paginated clone
- join row hydration
- reconcile
- per-table cursors (decision in Semantics section)

Exact envelopes are defined in “Data formats / protocol”.

## Data formats / protocol

### Canonical envelopes

Unless otherwise stated, server endpoints MUST return a canonical Datafn envelope:

```json
{ "ok": true, "result": <payload> }
```

or

```json
{ "ok": false, "error": { "code": "DFQL_INVALID", "message": "...", "details": { "path": "..." } } }
```

Client-side transports MAY return either an envelope or an unwrapped payload; the client MUST unwrap deterministically.

### Query

Unchanged from existing runtime:
- non-aggregate: `{ data, count?, nextCursor }`
- aggregate: `{ groups, nextCursor }`

### Mutation

Unchanged envelope shape, but context propagation affects events and hooks.

```json
{ "ok": true, "mutationId": "m-123", "affectedIds": ["node:..."], "deduped": false }
```

On error:

```json
{ "ok": false, "mutationId": "m-123", "affectedIds": [], "errors": [{ "code": "CONFLICT", "message": "...", "path": "if", "retryable": false }], "deduped": false }
```

### Sync: clone (paginated, join-aware)

`POST /datafn/clone` request:

```json
{
  "clientId": "client:device-1",
  "tables": ["node", "goal"],
  "page": {
    "table": "node",
    "afterId": "node:abc",
    "limit": 1000
  },
  "includeJoins": true
}
```

Response `result`:

```json
{
  "ok": true,
  "data": { "node": [/* records */], "goal": [/* records */] },
  "joins": {
    "join_node_properties_property": [ { "from": "node:1", "to": "property:1", "value": "..." } ]
  },
  "cursors": { "node": "123", "goal": "120" },
  "next": { "node": "node:lastIdOrNull" }
}
```

Notes:
- `joins` keys are client join-store names (see Semantics).
- `next` indicates further pages for a table; when absent/null, table clone is complete.

### Sync: pull (per-table cursors)

**Decision**: This spec makes per-table cursors canonical for pull to support partial hydration and selective pulls. Global cursor remains a derived optimization (see Semantics).

`POST /datafn/pull` request:

```json
{
  "clientId": "client:device-1",
  "cursors": { "node": "120", "goal": "88" },
  "limit": 200,
  "includeJoins": true
}
```

Response `result`:

```json
{
  "ok": true,
  "records": { "node": [/* upserts */], "goal": [/* upserts */] },
  "deleted": { "node": ["node:old"], "goal": [] },
  "joins": {
    "join_node_properties_property": {
      "upsert": [ { "from": "node:1", "to": "property:1", "value": "..." } ],
      "delete": [ { "from": "node:2", "to": "property:9" } ]
    }
  },
  "cursors": { "node": "123", "goal": "120" }
}
```

### Sync: push (relation-aware)

`POST /datafn/push` request:

```json
{
  "clientId": "client:device-1",
  "mutations": [
    { "resource": "node", "version": 1, "operation": "merge", "id": "node:1", "record": { "label": "X" }, "clientId": "client:device-1", "mutationId": "m-1", "context": { "tag": "ui" } },
    { "resource": "node", "version": 1, "operation": "relate", "id": "node:1", "relations": { "properties": [{ "$ref": "property:1", "value": "abc" }] }, "clientId": "client:device-1", "mutationId": "m-2", "context": { "tag": "ui" } }
  ]
}
```

Response `result`:

```json
{ "ok": true, "applied": ["m-1", "m-2"], "errors": [], "cursor": "124" }
```

### Sync: reconcile

`POST /datafn/reconcile` request:

```json
{ "clientId": "client:device-1", "resources": ["node", "goal"], "includeJoins": true }
```

Response `result`:

```json
{
  "ok": true,
  "counts": { "node": 1200, "goal": 42 },
  "joinCounts": { "join_node_properties_property": 9000 },
  "latestCursor": "124"
}
```

## Semantics

### 1) Local-only mode

- If `sync.mode === "local-only"`:
  - The client MUST NOT require `sync.remote` or `sync.remoteAdapter`.
  - All non-remote-only tables MUST be treated as hydrated (`ready`) immediately.
  - `mutate()` MUST apply locally (record ops and relation ops) and MUST append to the changelog for future sync/cloneUp.
  - `query()` MUST execute locally (no remote fallback).
  - `sync.start()` MUST be a no-op (but MUST NOT throw).

### 2) Remote adapter injection

- If `sync.remoteAdapter` is provided, the client MUST use it for all remote calls.
- If `sync.ws === true`:
  - If `sync.wsUrl` is provided, SyncEngine MUST use it.
  - Else if `sync.remote` is provided, SyncEngine MUST derive wsUrl as today.
  - Else websocket support is **disabled** and MUST emit `sync_failed` with deterministic error code `TRANSPORT_ERROR` if attempted.

### 3) Mutation context propagation and context filtering

- The client MUST propagate mutation `context` into:
  - `mutation_applied` / `mutation_rejected` events
  - client plugin hooks (`beforeMutation/afterMutation`)
  - server plugin hooks (`beforeMutation/afterMutation`)
  - request logging metadata (redacted as needed)
- Event filtering MUST support:
  - `contextKeys`: match by key presence
  - `context`: match by shallow key/value equality

### 4) Reactive invalidation (signals)

- Signals MUST register an “interest footprint” derived from the normalized query:
  - Primary resource
  - Resources referenced by relation expansion tokens in `select`
- On mutation events, signals MUST refresh only when:
  - event.resource intersects the signal footprint, OR
  - event indicates join-store changes intersecting the footprint (many-many), OR
  - event indicates FK changes affecting the footprint (many-one/one-many)
- Refreshes MUST be batched/debounced so multiple mutations in the same tick cause at most one refresh per signal.

### 5) Nucleus data ergonomics without losing signals

Nucleus MUST use the datafn primitives directly:
- table handles (`client.<resource>`)
- signals (`table.signal(query)`)
- event subscriptions (`client.subscribe(...)` or `table.subscribe(...)`)

Instead of Flux-style wrapper stores, this spec introduces:
- **Nucleus-local utilities** (in Nucleus repo) for common CRUD patterns (archive/trash/lock) implemented as small pure functions that call `datafn.table(...).mutate(...)`.
- Optional Svelte helpers (in `@datafn/svelte`) to:
  - derive `Readable` stores from signals (`toSvelteStore` already exists)
  - create “record signals” keyed by `{resource, id, select}` for common view components

### 6) Clone scalability and hydration plan

- Server clone MUST support pagination per table.
- Client SyncEngine MUST support a hydration plan:
  - Clone all `bootResources` to `ready` before reporting “boot hydration done”.
  - Clone `backgroundResources` in the background, keeping them `hydrating` until complete.
  - During `hydrating`, queries touching that table MUST use remote fallback when remote is available; in local-only mode, queries MUST return local results (which may be partial/empty).

### 7) Pull cursor model

- This spec adopts **per-table cursors** as canonical for pull to support selective hydration and correctness when not all resources are always pulled.
- Global cursor remains as:
  - `max(cursors[resource])` for resources known to the client
  - used for websocket wakeups and coarse “are we behind?” checks

### 8) Reconcile/repair

- The server MUST expose a reconcile endpoint returning per-resource counts and join counts.
- The client MUST expose `sync.reconcileNow()` that:
  - compares local counts and join counts
  - for any mismatch, triggers paginated clone for those resources/join stores

### 9) Local query performance + operator coverage

- The local query engine MUST use indexed lookups when possible:
  - `id eq X` MUST use `getRecord`
  - `{ field: { eq: value } }` on an indexed field MUST use `findRecords(resource, field, value)`
- Local filters MUST support at minimum:
  - `$and`, `$or`
  - `eq/$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`
  - `$contains` for arrays

### 10) Offline apply for relation mutations (end-to-end)

For `operation: relate | modifyRelation | unrelate`:

- Client offline apply MUST update local join stores/FKs deterministically.
- Server push MUST accept and apply relation mutations (same as mutation endpoint).
- Server change tracking + pull MUST propagate relation changes to clients.
- Clone MUST include join rows so a fresh client can expand relations offline.

### 11) ID conventions + date mapping

- Inserts MUST generate IDs that respect schema `idPrefix` (or default to `${resource}:`).
- Client MUST provide a codec layer so:
  - outbound mutations serialize `Date` fields to ISO strings
  - inbound query results parse schema `date` fields into `Date` objects (for Nucleus parity)

### 12) Sync lifecycle hooks and events

- Client MUST run `beforeSync/afterSync` hooks for `seed/clone/pull/push/cloneUp/reconcile`.
- Client MUST emit `sync_applied` and `sync_failed` events with deterministic context payload:
  - `{ phase, cursorDelta?, resources?, error? }`

### 13) Server authz/permissions enforcement

- Server MUST enforce a defined permissions policy shape per resource/field.
- Server MUST enforce namespace isolation (no hard-coded `"datafn"` namespace for multi-tenant paths).

## Invariants

- **Determinism**:
  - Stable sorting MUST be applied where ordering affects results (ids asc tie-breakers).
  - Event `fields` MUST be sorted and derived deterministically.
  - Signal invalidation MUST be deterministic for the same event stream.
- **Idempotency**:
  - `(clientId, mutationId)` MUST dedupe push retries.
- **Ordering**:
  - server assigns monotonic `serverSeq` per namespace; this is the source of truth.
- **Conflict default**:
  - LWW by server ordering for overlapping writes to the same record unless a server plugin overrides.

## Security

- Schema-bounded validation MUST reject unknown resources/fields/relations.
- Authz MUST be enforced on the server (table + field level).
- Logs MUST redact sensitive fields for resources/fields marked sensitive (or via policy plugin).
- Extension transports MUST treat background runtime as authoritative; content/sidepanel are untrusted surfaces and MUST not bypass authz.

## Limits/caps

- Server MUST enforce:
  - max `limit` for queries (default 100, configurable)
  - max payload bytes (configurable)
  - max transact steps (configurable)
- Clone pagination MUST enforce a maximum page size (default 1000).
- Pull MUST enforce a maximum per-table limit (default 200).

## Observability

- Client MUST emit events:
  - mutation_applied / mutation_rejected
  - sync_applied / sync_failed
- Server MUST log:
  - endpoint, clientId, mutationId (if present), resource, operation, duration_ms
  - redacted record payload where applicable

## Compatibility / versioning strategy

- Existing `createDatafnClient` configs using `sync.remote: string` MUST continue to work.
- `sync.remoteAdapter` is additive; when present it MUST take precedence.
- Pull endpoint migration:
  - Server MUST accept both the legacy global-cursor pull shape and the new per-table cursor shape during a compatibility window.
  - Client MUST default to per-table cursors when storage is configured.

## Undefined / Explicitly user-deferred only

- **User-deferred items**: None.
- Any behavior not explicitly specified in this document is **Undefined** and therefore **NOT required**.


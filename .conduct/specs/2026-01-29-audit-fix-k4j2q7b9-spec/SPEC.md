# Metadata

- **timestamp**: 2026-01-29T07:54:36Z
- **agent_name**: Droid
- **model**: GPT-5.2
- **launcher**: CLI
- **workspace**: /Users/ar/dev/superfunctions
- **os**: darwin 25.0.0
- **shell**: unknown
- **git.branch**: heads/next
- **git.commit**: 98c71853911e3aa96e9a72f892ee34e720ccc553
- **git.dirty**: true
- **spec_type**: audit-fix
- **spec_id**: k4j2q7b9
- **spec_folder**: 2026-01-29-audit-fix-k4j2q7b9-spec
- **spec_path**: /Users/ar/dev/superfunctions/.conduct/specs/2026-01-29-audit-fix-k4j2q7b9-spec
- **authoritative_inputs**:
  - https://www.fetch.at/spec.txt
  - /Users/ar/dev/superfunctions/datafn/.conduct/audits/flux-to-datafn-migration-gap-analysis.md
- **audit_reference**:
  - filename: flux-to-datafn-migration-gap-analysis.md
  - path: /Users/ar/dev/superfunctions/datafn/.conduct/audits/flux-to-datafn-migration-gap-analysis.md
  - section: 2.1 Clone Up / Local-to-Cloud Upload (CRITICAL)

# Overview

This spec adds **Clone Up / Local-to-Cloud Upload** to Datafn so offline-first users who create data locally (before having a cloud identity) can **upload all existing local records to the cloud** after signup without data loss.

The feature introduces:

- A **server endpoint** `POST /datafn/cloneup` that accepts bulk records for a single resource and persists them with **change tracking**.
- A **client convenience method** `client.sync.cloneUpNow()` that reads all local records from configured storage and uploads them **resource-by-resource** (and chunked).

## Context

- **Project name:** Superfunctions monorepo (`datafn` packages)
- **One-sentence goal:** Implement Datafn “clone up” so local IndexedDB data can be uploaded to the cloud on signup.
- **Target users:** App developers migrating from Flux/Flux.ts patterns, and any offline-first app using `@datafn/client` + `@datafn/server`.
- **Target environments:**
  - Client: browser (IndexedDB) and Node (tests)
  - Server: Node 18+
- **Languages/packages:** TypeScript; `@datafn/client`, `@datafn/server`, `@datafn/core`, `@superfunctions/db`, `@superfunctions/http`
- **Existing systems to integrate with:**
  - Server auth/namespace isolation via `authContextProvider` (optional)
  - Server authorization callback `authorize()`
  - Server change tracking (`__datafn_meta`, `__datafn_changes`) and optional `SequenceStore`
- **Data model summary:**
  - User-defined resources (schema `resources`) keyed by `id`
  - Server global sequence (`serverSeq`) recorded per namespace in `__datafn_meta` and `__datafn_changes`
- **Security model:**
  - Per-request authorization via `DatafnServerConfig.authorize`
  - Optional per-user/tenant namespace via `authContextProvider` (affects where uploaded data is written)
- **Performance constraints:**
  - Must support large local datasets by chunking uploads and avoiding unnecessary writes
- **Hard constraints:**
  - No new external dependencies
  - Deterministic behavior for ordering, cursors, and error reporting

# Glossary

- **Local mode**: An app mode where data is written only to client storage (e.g., IndexedDB) prior to obtaining a cloud identity/session.
- **Clone down**: Download the full dataset from server to client (`/datafn/clone`).
- **Pull**: Incremental download of changes since a cursor (`/datafn/pull`).
- **Push**: Incremental upload of mutations from a client changelog (`/datafn/push`).
- **Clone up**: Bulk upload of existing local records to the server (this spec).
- **Resource**: A schema-defined table name (`DatafnSchema.resources[].name`).
- **Record**: A JSON object representing a resource row, MUST include string `id`.
- **Namespace**: A server-side partition key used for multi-user/tenant isolation of data and change tracking.
- **serverSeq**: Monotonic integer sequence allocated by the server for change tracking.
- **Cursor**: A base-10 integer string representing a `serverSeq` boundary.

# Goals / Non-goals

## Goals

1. Datafn MUST support uploading all local records to the server after a user transitions from local/offline mode to cloud mode.
2. Clone up MUST support **resource-by-resource** uploads (matching Flux’s workflow) and MUST be chunkable.
3. Server-side clone up MUST record change tracking so other clients can pull the uploaded records.
4. Clone up MUST be **idempotent by content**: repeating the same upload MUST NOT generate additional change tracking entries for unchanged records.

## Non-goals

1. This spec does not change `push()` semantics (incremental mutation upload remains unchanged).
2. This spec does not add reconciliation, pagination workflows, KV store patterns, or in-memory store patterns.
3. This spec does not define a new cross-resource transaction primitive for clone up; uploads are per-resource and may partially succeed.

# Public API

## Server HTTP API

### Endpoint

- **Method/Path**: `POST /datafn/cloneup`
- **Content-Type**: `application/json`
- **Response envelope**: `DatafnEnvelope<CloneUpResult>`

### Request: `CloneUpRequest`

```ts
export type CloneUpRequest = {
  clientId: string;
  resource: string;
  records: Array<Record<string, unknown>>;
};
```

### Result: `CloneUpResult`

```ts
export type CloneUpResult = {
  ok: true;
  resource: string;
  inserted: string[];
  updated: string[];
  skipped: string[];
  errors: Array<{
    id: string;
    code: string;
    message: string;
    path: string;
  }>;
  cursor: string; // base-10 integer string
};
```

Notes:

- Request-level validation failures MUST return `{ ok: false, error: ... }` with an appropriate HTTP status (typically 400).
- Record-level failures MUST be reported in `errors[]` while allowing other records to proceed.

## Client TypeScript API (`@datafn/client`)

### Remote adapter

```ts
export interface DatafnRemoteAdapter {
  // existing
  seed(payload: unknown): Promise<unknown>;
  clone(payload: unknown): Promise<unknown>;
  pull(payload: unknown): Promise<unknown>;
  push(payload: unknown): Promise<unknown>;

  // new
  cloneUp(payload: unknown): Promise<unknown>;
}
```

### Sync facade (delegating method)

```ts
export interface SyncFacade {
  // existing
  seed(payload: unknown): Promise<unknown>;
  clone(payload: unknown): Promise<unknown>;
  pull(payload: unknown): Promise<unknown>;
  push(payload: unknown): Promise<unknown>;

  // new (delegates to remote.cloneUp)
  cloneUp(payload: unknown): Promise<unknown>;
}
```

### Sync convenience method (local-to-cloud)

`createDatafnClient()` MUST expose an additional method on `client.sync`:

```ts
export type CloneUpNowOptions = {
  /** If omitted, upload all schema resources (including isRemoteOnly). */
  resources?: string[];
  /** Max records per request. Default: 500. */
  batchSize?: number;
};

export type CloneUpNowSummary = {
  ok: boolean; // true iff no per-record errors occurred
  cursor: string; // max cursor observed across all cloneup calls (or current cursor if no writes)
  resources: Array<{
    resource: string;
    inserted: string[];
    updated: string[];
    skipped: string[];
    errors: CloneUpResult["errors"];
  }>;
};

// new method
client.sync.cloneUpNow(options?: CloneUpNowOptions): Promise<CloneUpNowSummary>;
```

## Plugin hook API (`@datafn/core`)

`DatafnPlugin.beforeSync` / `afterSync` MUST accept the additional phase:

```ts
type SyncPhase = "seed" | "clone" | "pull" | "push" | "cloneup";
```

# Data formats / protocol

## Envelope

All server responses MUST conform to `DatafnEnvelope<T>`:

```ts
type DatafnEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };
```

## Canonical clone up request/response

### Request JSON

```json
{
  "clientId": "client:device-1",
  "resource": "task",
  "records": [
    { "id": "task:1", "title": "a" },
    { "id": "task:2", "title": "b" }
  ]
}
```

### Success response JSON

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "resource": "task",
    "inserted": ["task:1", "task:2"],
    "updated": [],
    "skipped": [],
    "errors": [],
    "cursor": "2"
  }
}
```

### Request-level error response JSON

```json
{
  "ok": false,
  "error": {
    "code": "DFQL_INVALID",
    "message": "Invalid DFQL: clientId must be string",
    "details": { "path": "clientId" }
  }
}
```

# Semantics

## Server: `/datafn/cloneup`

### Validation

The server MUST validate, in order:

1. `clientId` MUST be a string.
2. `resource` MUST be a string and MUST exist in `DatafnSchema.resources`.
3. `records` MUST be an array.
4. Each `records[i]` MUST be an object (non-null, not an array) and MUST include `id: string`.
5. If the resource schema defines `idPrefix`, then `record.id` MUST start with that prefix.
6. Each record’s keys MUST be valid writable fields for that resource per server schema validation rules.

Request-level validation failures MUST return envelope error (`ok: false`) and MUST NOT partially apply any writes.

### Persistence + change tracking

For each valid record:

- The server MUST apply **upsert semantics**:
  - If the record does not exist: `create` it.
  - If the record exists: `update` it using **merge semantics** (only the provided keys).
- The server MUST record a change tracking entry **only if** the upsert changes persisted content.
  - If the existing record already matches the incoming record for all provided keys, the server MUST treat it as `skipped` and MUST NOT record a change.

The server MUST allocate `serverSeq` using `ChangeTrackingService.getNextServerSeq()` for each recorded change, and MUST return `cursor` as the maximum `serverSeq` recorded during this request, or the current global `serverSeq` if no changes were recorded.

### Partial failures

- If a specific record fails validation (e.g., unknown field) the server MUST report it in `errors[]` and continue processing remaining records.
- If a database operation fails for a specific record, the server MUST report it in `errors[]` with `code: "INTERNAL"` and continue processing remaining records.

## Client: `client.sync.cloneUpNow()`

### Preconditions

- The client MUST have a configured `storage` adapter.
- The client MUST have a configured `sync.remote` (i.e., a remote adapter that implements `cloneUp`).

If these are not met, `cloneUpNow()` MUST throw a deterministic `DatafnClientError`:

- Missing storage → `DFQL_INVALID` with `details.path = "storage"`.
- Missing remote cloneUp method → `TRANSPORT_ERROR` with `details.path = "sync.cloneUp"`.

### Resource selection

- If `options.resources` is provided, the client MUST upload only those resources, in the given order.
- Otherwise, the client MUST upload all schema resources in schema order, including those marked `isRemoteOnly`.

### Record selection + ordering

For each selected resource:

1. Read all local records via `storage.listRecords(resource)`.
2. If zero records, skip remote call for that resource.
3. Sort records by `id` ascending (lexicographic) for determinism.
4. Chunk into batches of at most `options.batchSize` (default 500) and call `/datafn/cloneup` once per batch.

### Aggregation

The client MUST aggregate per-batch results into a per-resource summary, concatenating `inserted/updated/skipped` arrays in the order batches were sent.

The client MUST compute `summary.cursor` as the maximum numeric cursor returned by any batch result (or the current stored cursor if no batches ran).

# Invariants

## Determinism

- Given the same request payload and server state, `/datafn/cloneup` MUST produce the same `inserted/updated/skipped/errors` partitioning and MUST allocate `serverSeq` in a deterministic order (processing records sorted by `id`).
- Error ordering MUST be deterministic: errors MUST be listed in ascending record `id` order within the request.

## Idempotency

- Repeating the same clone up request (same `resource`, same set of records and values) MUST NOT create additional change tracking entries for unchanged records.
- A partially successful request MAY be retried; already-applied identical records MUST be skipped.

## Ordering

- Within a request, record processing order MUST be `id` ascending.
- Across client resources, processing order MUST match the client’s resource iteration order.

# Security

## Authorization

- `DatafnServerConfig.authorize` MUST support the new action string `"cloneup"`.
- Authorization MUST run only after JSON parsing succeeds (consistent with existing `withAuth`).

## Namespace isolation

- The clone up endpoint MUST write records to the namespace returned by `authContextProvider` when configured; otherwise it MUST use the default namespace (`"datafn"`).

## Validation

- The server MUST validate unknown resources/fields and reject or report deterministically.
- The server MUST NOT log record bodies.

# Limits / caps

- The server MAY enforce request payload limits via `limits.maxPayloadBytes` (existing middleware).
- The client MUST provide chunking (default 500 records per request) to keep payload sizes bounded.

# Observability

- The server MUST log a structured `logRequest` entry for `/datafn/cloneup` including: timestamp, endpoint, operation="cloneup", clientId, resource, count, duration_ms.
- Errors MUST be surfaced only via response envelopes and MUST NOT include sensitive record contents.

# Compatibility / versioning strategy

- This change is additive:
  - Adds a new endpoint (`/datafn/cloneup`).
  - Extends types to include a new sync phase and new remote method.
- Existing endpoints (`clone`, `pull`, `push`, `seed`) MUST remain behaviorally unchanged.

# Undefined / Explicitly user-deferred only

None.

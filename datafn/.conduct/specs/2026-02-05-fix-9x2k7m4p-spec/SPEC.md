## Metadata

- **timestamp**: 2026-02-05T07:45:05Z
- **agent_name**: unknown-agent
- **model**: GPT-5.2
- **launcher**: Cursor
- **workspace/project path**: /Users/ar/dev/superfunctions/datafn
- **OS + shell**: darwin 25.0.0, zsh
- **git**
  - **toplevel**: /Users/ar/dev/superfunctions
  - **branch**: next
  - **commit**: 98c71853911e3aa96e9a72f892ee34e720ccc553
  - **dirty**: yes
- **spec**
  - **spec_type**: fix
  - **spec_id**: 9x2k7m4p
  - **spec_folder**: 2026-02-05-fix-9x2k7m4p-spec
  - **spec_folder_path**: /Users/ar/dev/superfunctions/datafn/.conduct/specs/2026-02-05-fix-9x2k7m4p-spec
- **input paths (notes/intent/docs read)**
  - /Users/ar/dev/superfunctions/datafn/.conduct/audits/flux-to-datafn-migration-gap-analysis.md
  - /Users/ar/dev/superfunctions/datafn/.conduct/audits/sync-remote-audit-2026-01-25.md
  - /Users/ar/dev/superfunctions/datafn/.conduct/intent/datafn.intent.md
  - /Users/ar/dev/superfunctions/datafn/.conduct/intent/spec.md
  - /Users/ar/dev/superfunctions/datafn/.conduct/intent/implementation.md
  - /Users/ar/dev/superfunctions/datafn/.conduct/intent/migration-plan-from-nucleus.md
  - /Users/ar/dev/superfunctions/datafn/.conduct/intent/2026-01-26-fixes/client-intent-1.md
  - /Users/ar/dev/superfunctions/datafn/server/README.md
- **audit-fix reference**
  - **audit**: /Users/ar/dev/superfunctions/datafn/.conduct/audits/flux-to-datafn-migration-gap-analysis.md
  - **finding(s) addressed**: “2.1 Clone Up / Local-to-Cloud Upload (CRITICAL)”

---

## Overview

This spec defines a **deterministic, idempotent “offline user → cloud” conversion workflow** for `@datafn/client`, enabling a user who has accumulated a **local-first dataset while unauthenticated / local-only** to **sign up** and then **upload (clone up) their existing local dataset** into the authenticated server namespace without losing data.

This fixes the critical gap identified in the Nucleus→Datafn migration audit: Datafn currently has no first-class equivalent of Flux’s `cloneUp()` that uploads **existing local state** on signup.

---

## Glossary

- **Offline user**: A user operating a Datafn-powered app in a local-first mode where server writes are not possible (no session yet, no auth, or intentionally local-only).
- **Cloud conversion**: The one-time process performed after signup/login to upload a user’s existing local dataset into their authenticated server namespace.
- **CloneUp**: The Datafn term for cloud conversion upload (analogue of Flux `cloneUp()`).
- **Namespace**: Server-side isolation key used for change-tracking and storage scoping (e.g. `user:alice`, `tenant:acme:user:alice`). Derived by the host server via `authContextProvider` / extraction logic.
- **Storage adapter**: Client persistence backend implementing `DatafnStorageAdapter` (e.g. `IndexedDbStorageAdapter`).
- **Join store**: Client-side store holding many-many relation rows, named using the convention `join_${from}_${relation}_${to}`.
- **Join row**: A many-many edge record with `from`, `to`, and optional metadata fields.
- **Idempotency**: Repeating the same upload MUST not duplicate server state or create divergent results.
- **Determinism**: Given the same local dataset + same schema + same options, CloneUp MUST generate the same upload plan and mutation IDs.

---

## Goals

- **G1 — Prevent data loss on signup**: A local-only/offline user MUST be able to sign up and have their existing local dataset uploaded to the cloud namespace.
- **G2 — Deterministic + idempotent**: Upload retries and re-runs MUST be safe and MUST not duplicate or corrupt server state.
- **G3 — Schema-bounded**: Upload MUST validate/match schema resources and relation metadata constraints.
- **G4 — Work with existing server contracts**: The default implementation MUST work with existing `/datafn/push` semantics (TypeScript + Python servers) and existing idempotency behavior.
- **G5 — Many-many preservation**: Many-many relations represented in client join stores MUST be uploaded with metadata (when schema declares metadata).
- **G6 — Post-conversion sync consistency**: After successful conversion, the client MUST be able to continue normal sync (push/pull) without re-sending obsolete history.

---

## Non-goals

- **NG1**: Designing a full multi-device merge UX for conflicting pre-existing cloud data. (This spec defines a default conflict policy and exposes explicit options; it does not prescribe product UX.)
- **NG2**: Providing raw-SQL or arbitrary server-side execution for conversion.
- **NG3**: Migrating between different client storage databases (e.g. device-db → user-db). This spec focuses on **cloud upload**, not local DB renaming/migration. (Local DB migration remains undefined here.)
- **NG4**: Automatically detecting “signup happened” in the client. The host app invokes `cloneUp()` explicitly.

---

## Context (assumptions + constraints)

- **Project**: `superfunctions/datafn`
- **One-sentence goal**: Add `sync.cloneUp()` to upload existing local dataset to cloud on signup.
- **Target users**: Apps migrating from Nucleus/Flux patterns; any Datafn consumer supporting guest/offline usage.
- **Target environments**:
  - Client: browser (IndexedDB) and test environments
  - Server: TypeScript (`@datafn/server`) and Python (`datafn`) backends
- **Security model**: Server determines namespace via auth context; client may be unauthenticated before conversion.

Assumptions (explicit):
- **A1**: On signup/login, the host app can make authenticated requests to `/datafn/push` (cookie auth or equivalent).
- **A2**: Local records have stable `id` fields compatible with server schema (including `idPrefix` when configured).
- **A3**: The server push path supports `merge` upsert semantics for all resources used in conversion.

---

## Public API

### TypeScript client API (`@datafn/client`)

`createDatafnClient(...)` MUST expose a new sync method:

```ts
export type CloneUpOptions = {
  /**
   * Which resources to upload. If omitted, uploads all schema resources
   * where `isRemoteOnly !== true`.
   */
  resources?: string[];

  /**
   * Whether to upload many-many join rows derived from schema relations.
   * Default: true.
   */
  includeManyMany?: boolean;

  /**
   * Operation to use for record upload.
   * - "merge" is upsert semantics (default; safest).
   * - "replace" overwrites full record on server.
   * - "insert" attempts create-only (may error if already exists).
   */
  recordOperation?: "merge" | "replace" | "insert";

  /**
   * Batch size for push calls. Default: config.sync.pushBatchSize ?? 100.
   */
  batchSize?: number;

  /**
   * Retry attempts per push batch on transport errors only.
   * Default: config.sync.pushMaxRetries ?? 3.
   */
  maxRetries?: number;

  /**
   * If true, abort on the first server-side mutation error in any batch.
   * Default: true.
   */
  failFast?: boolean;

  /**
   * If true, clears local changelog after successful cloneUp.
   * Default: true.
   */
  clearChangelogOnSuccess?: boolean;

  /**
   * If true, set local global cursor to the server cursor returned from push batches.
   * Default: true.
   */
  setGlobalCursorOnSuccess?: boolean;

  /**
   * If true, trigger an immediate pull after cloneUp completes successfully.
   * Default: true.
   */
  pullAfter?: boolean;

  /**
   * Prefix used in deterministic mutationId generation to avoid collisions.
   * Default: "cloneup".
   */
  mutationIdPrefix?: string;
};

export type CloneUpResult = {
  ok: boolean;
  /** Highest cursor observed across push batches (base-10 integer string). */
  cursor: string;
  /** Counts by resource and by join-store. */
  stats: {
    /** Includes every resource in the resolved upload scope (zero counts allowed). */
    resources: Record<string, { records: number; mutations: number }>;
    /** Includes every enumerated join store (zero counts allowed). */
    joinStores: Record<string, { rows: number; mutations: number }>;
    /** Total number of `/datafn/push` batch calls performed by cloneUp. */
    batches: number;
  };
  /** Aggregated server-side errors (if any). */
  errors: Array<{ mutationId: string; code: string; message: string; path: string }>;
};

export interface SyncFacade {
  seed(payload: unknown): Promise<unknown>;
  clone(payload: unknown): Promise<unknown>;
  pull(payload: unknown): Promise<unknown>;
  push(payload: unknown): Promise<unknown>;

  /**
   * Upload existing local dataset (records + many-many join rows) to the server
   * using deterministic, idempotent push batches.
   */
  cloneUp(options?: CloneUpOptions): Promise<CloneUpResult>;
}
```

### Server API

No new server endpoint is required by this spec.

`cloneUp()` MUST be implemented as a client-side workflow that sends DFQL mutations to the existing `/datafn/push` endpoint (TypeScript or Python server).

---

## Data formats / protocol

### Wire protocol used by CloneUp

CloneUp uses the existing `push` request shape:

```json
{
  "clientId": "client:device-1",
  "mutations": [
    {
      "resource": "tasks",
      "version": 1,
      "operation": "merge",
      "id": "tasks:t1",
      "record": { "title": "Build feature" },
      "clientId": "client:device-1",
      "mutationId": "cloneup:rec:tasks:tasks:t1:1onhffr",
      "timestamp": 1738740000000
    }
  ]
}
```

The server response is the canonical Datafn envelope:

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "applied": ["...mutationId..."],
    "errors": [],
    "cursor": "123"
  }
}
```

### Deterministic mutationId generation

CloneUp MUST generate mutation IDs deterministically from the local record/join-row payload so that retries/re-runs are safe.

Canonical algorithm (fully specified):
- Construct a **hash input object** (per “Semantics” below).
- Normalize the hash input using `@datafn/core` canonicalization:
  - `normalized = normalizeDfql(hashInput)`
  - `canonicalString = JSON.stringify(normalized)`
- Compute `hash32 = FNV-1a (32-bit)` over the **UTF-8 bytes** of `canonicalString`:
  - offset basis: `0x811c9dc5`
  - prime: `0x01000193`
  - for each byte `b`: `hash = (hash ^ b) * prime mod 2^32`
- Encode the unsigned 32-bit hash as a **lowercase base36** string with no prefix:
  - `hashSuffix = hash32.toString(36)`
- Use `hashSuffix` as the suffix in `mutationId`.

Mutation ID formats (canonical):
- Record upsert:
  - `"{prefix}:rec:{resource}:{id}:{hash}"`
- Many-many relate (join row):
  - `"{prefix}:rel:{joinStore}:{from}:{to}:{hash}"`

Where:
- `prefix = options.mutationIdPrefix ?? "cloneup"`
- `hash` MUST be the base36 output of the specified FNV-1a 32-bit computation.

---

## Semantics

### High-level workflow

When `client.sync.cloneUp()` is called:

1. **Validate prerequisites**
   - Storage MUST be configured (CloneUp requires enumerating local records and join rows).
   - A remote adapter MUST be configured (CloneUp uses `/datafn/push`).
   - Schema MUST be available (CloneUp is schema-bounded).

2. **Resolve upload scope**
   - Determine resources to upload:
     - If `options.resources` is provided: validate each resource exists in schema and is not `isRemoteOnly`.
     - Else: use all resources with `isRemoteOnly !== true`.

3. **Stage A — Upload records**
   - For each resource:
     - Enumerate `storage.listRecords(resource)`.
     - Sort records by `id` ascending (lexicographic string compare) before generating mutations.
     - For each record:
       - Convert to DFQL mutation (`merge` default).
       - Ensure `id` is a string.
       - Ensure `record` excludes `id` and includes only schema-declared fields (unknown local fields are omitted).
       - Generate deterministic `mutationId`.
       - **Hash input object (records)**:
         - `hashInput = { kind: "rec", resource, operation: recordOperation, id, record }`
         - `hash = fnv1a32_base36(JSON.stringify(normalizeDfql(hashInput)))`
         - `mutationId = "{prefix}:rec:{resource}:{id}:{hash}"`
     - Push this resource’s record mutations in batches using `remote.push({ clientId, mutations })`.
     - Retry a batch only if the failure is a **transport error** (see determinism + retry policy).

4. **Stage B — Upload many-many join rows (optional)**
   - If `options.includeManyMany !== false`:
     - For each schema relation of type `many-many` where the relation’s `from` resource is included in the resolved upload scope, enumerate all join stores implied by the schema:
       - `join_${from}_${relation}_${to}` for each combination of `from`/`to` arrays.
     - Sort computed join store names lexicographically before enumerating join rows.
     - For each join store:
       - Enumerate `storage.listJoinRows(joinStore)` (missing stores are treated as empty).
       - For each join row:
         - Validate `from`/`to` exist and are strings.
         - Compute `metaFiltered` by selecting schema-declared metadata keys for that relation; if any other metadata keys are present, CloneUp MUST fail with `DFQL_UNKNOWN_FIELD`.
       - Sort join rows deterministically by `(from, to, dfqlKey(metaFiltered))`.
       - For each join row (in sorted order):
         - Convert to a DFQL `relate` mutation on the `from` resource:
           - `resource = fromResource`
           - `operation = "relate"`
           - `id = row.from`
           - `relations = { [relationName]: { "$ref": row.to, ...metaFiltered } }`
         - Generate deterministic `mutationId`.
         - **Hash input object (join rows)**:
           - `hashInput = { kind: "rel", joinStore, resource: fromResource, relation: relationName, from, to, metadata: metaFiltered }`
           - `hash = fnv1a32_base36(JSON.stringify(normalizeDfql(hashInput)))`
           - `mutationId = "{prefix}:rel:{joinStore}:{from}:{to}:{hash}"`
       - Push this join store’s `relate` mutations in batches using `remote.push({ clientId, mutations })`.
       - Retry a batch only if the failure is a **transport error** (see determinism + retry policy).

5. **Finalize local sync state**
   - Let `startingCursor = (await storage.getCursor("__global_cursor__")) ?? "0"` (captured before any cursor updates in this method).
   - If `options.pullAfter !== false`, CloneUp MUST perform a pull catch-up loop starting from `startingCursor`:
     - Repeatedly call `remote.pull({ clientId, cursor, limit: 100 })` until caught up.
     - After each successful pull page:
       - Apply `changes[]` in order (`upsert` → `storage.upsertRecord`, `delete` → `storage.deleteRecord`).
       - Advance `__global_cursor__` monotonically:
         - if `nextCursor !== null`: set cursor to `nextCursor`
         - else if `changes.length > 0`: set cursor to `String(changes[changes.length - 1].serverSeq)`
         - else: do not update cursor
   - If `options.setGlobalCursorOnSuccess !== false`, set local cursor `__global_cursor__` monotonically to the max cursor observed across push batches (so local cursor is at least the server cursor returned by push).
   - If `options.clearChangelogOnSuccess !== false`, clear/ack the local changelog by draining it:
     - Loop: `pending = await storage.changelogList({ limit: 1000 })`
     - If `pending.length === 0`, stop.
     - Else: `await storage.changelogAck({ throughSeq: pending[pending.length - 1].seq })` and continue.

### Retry policy

- CloneUp MUST retry a failed push batch up to `maxRetries` **only** when the error is a transport error (`TRANSPORT_ERROR`, network failure, timeout).
- CloneUp MUST NOT retry for schema validation errors, authorization errors, or other deterministic server rejections.

### Failure policy

- If `failFast` is true (default):
  - Any server-side push batch returning non-empty `errors` MUST cause CloneUp to return `ok=false` and MUST NOT clear local changelog nor advance local cursor.
- If `failFast` is false:
  - CloneUp MAY continue processing remaining batches and return aggregated errors; it still MUST NOT clear local changelog nor advance local cursor when any errors occurred.

### Error codes (client-side)

CloneUp MUST use existing Datafn client error codes and stable `details.path` values.

- **`DFQL_INVALID`** (thrown):
  - missing prerequisites: `details.path ∈ {"storage","sync.remote"}`
  - invalid options: `details.path ∈ {"batchSize","maxRetries","resources[i]","records[i].id","joinRows[i].from","joinRows[i].to"}`
  - message MUST be one of:
    - `Invalid cloneUp: storage is required`
    - `Invalid cloneUp: sync.remote is required`
    - `Invalid cloneUp: batchSize must be a positive integer`
    - `Invalid cloneUp: maxRetries must be a non-negative integer`
    - `Invalid cloneUp: record id must be a string` (path `records[i].id`)
    - `Invalid cloneUp: join row from/to must be a string` (path `joinRows[i].from` / `joinRows[i].to`)
    - `Invalid cloneUp: remote-only resources are not allowed` (path `resources[i]`)
- **`DFQL_UNKNOWN_RESOURCE`** (thrown): unknown resource name in `options.resources` (`details.path="resources[i]"`)
  - message MUST be: `Invalid cloneUp: unknown resource`
- **`DFQL_UNKNOWN_FIELD`** (thrown): join-row metadata contains keys not declared by schema relation metadata (path points to the specific key)
  - message MUST be: `Invalid cloneUp: unknown join metadata field`
- **`INTERNAL`** (thrown): unexpected invariant violations (e.g., schema missing at runtime)
- **`TRANSPORT_ERROR`** (thrown): push batch transport failure after exhausting retries (`details.path="sync.push"`)
- **`TRANSPORT_ERROR`** (thrown): pull transport failure during `pullAfter` (`details.path="sync.pull"`)

Server-side mutation errors returned inside `CloneUpResult.errors[]` are pass-through values from `/datafn/push` and are not constrained by this spec beyond having stable `mutationId`, `code`, `message`, and `path` fields.

---

## Invariants

- **INV-IDEMP-001 (Idempotency)**: Re-running CloneUp with the same local dataset MUST be safe. It MUST NOT create duplicate logical rows (server-side upserts/relates are idempotent) and MUST NOT produce divergent server state.
- **INV-DET-001 (Determinism)**: Given the same local dataset + schema + options, CloneUp MUST generate the same mutation set and mutationIds in the same order.
- **INV-ORDER-001 (Ordering)**: Record upserts MUST be pushed before many-many `relate` mutations so that relation target records exist on server.
- **INV-SYNC-STATE-001**: On successful completion, the client MUST be able to enter normal sync without pushing the pre-conversion history again.

---

## Security

- CloneUp MUST rely on the server’s existing authorization model for `/datafn/push` (e.g. namespace extraction + permission checks).
- CloneUp MUST NOT log or emit full record payloads by default in client events; it may emit counts and mutation IDs only.
- Any metadata keys included in relation payloads MUST be schema-declared to prevent unbounded/PII leakage.

---

## Limits / caps

Client MUST enforce or default:
- `batchSize` default 100; MUST be a positive integer.
- A maximum payload byte cap MAY be enforced by the server; CloneUp MUST support batching to respect server caps.

Server constraints are inherited from `/datafn/push`.

---

## Observability

CloneUp MUST emit `DatafnEvent` events using existing event types:
- On failure: emit `sync_failed` with `context: { phase: "cloneup", error }`.
- On success: emit `sync_applied` with `context: { phase: "cloneup", cursor, stats }`.

---

## Compatibility / versioning strategy

- This spec is **additive**:
  - Adds a new method `sync.cloneUp()` on the client.
  - Does not require server changes.
- Existing apps are unaffected unless they call the new method.

---

## Undefined / Explicitly user-deferred only

None.


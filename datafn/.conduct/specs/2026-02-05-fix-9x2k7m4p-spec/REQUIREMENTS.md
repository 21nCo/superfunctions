## Table of contents

- CLONEUP-API-001
- CLONEUP-API-002
- CLONEUP-SCOPE-001
- CLONEUP-JOIN-001
- CLONEUP-ORDER-001
- CLONEUP-MUT-001
- CLONEUP-MUT-002
- CLONEUP-PUSH-001
- CLONEUP-PUSH-002
- CLONEUP-STATE-001
- CLONEUP-STATE-002
- CLONEUP-EVT-001
- CLONEUP-COMPAT-001

---

### ID: CLONEUP-API-001

- **Priority**: P0
- **Statement**: `@datafn/client` MUST expose `client.sync.cloneUp(options?: CloneUpOptions): Promise<CloneUpResult>` with the option defaults and return shape defined in `SPEC.md` (“Public API”).
- **Rationale**: Apps migrating from Flux require a first-class offline→cloud upload workflow at signup.
- **Acceptance criteria**:
  - `createDatafnClient(...)` returns an object whose `sync` member has a callable `cloneUp` function.
  - Calling `cloneUp()` without options uses the documented defaults.
  - The resolved `CloneUpResult` contains: `ok`, `cursor`, `stats`, and `errors` fields.
- **Test vectors**: TV-CLONEUP-001, TV-CLONEUP-002, TV-CLONEUP-006
- **Notes**:
  - This is additive API; it MUST NOT break existing `sync.*` methods.

---

### ID: CLONEUP-API-002

- **Priority**: P0
- **Statement**: `cloneUp()` MUST validate prerequisites (storage configured, remote configured, schema available) and MUST fail with `DFQL_INVALID` when prerequisites are not met.
- **Rationale**: CloneUp cannot function without enumerating local state or pushing to server.
- **Acceptance criteria**:
  - If `storage` is missing, `cloneUp()` throws a `DatafnClientError` with `code="DFQL_INVALID"` and `details.path="storage"`.
  - If `sync.remote` is missing, `cloneUp()` throws a `DatafnClientError` with `code="DFQL_INVALID"` and `details.path="sync.remote"`.
  - If schema is missing/invalid at runtime, `cloneUp()` throws a `DatafnClientError` with `code="INTERNAL"` and a stable error message.
- **Test vectors**: TV-CLONEUP-001, TV-CLONEUP-003, TV-CLONEUP-004
- **Notes**:
  - “Schema missing/invalid at runtime” is defensive; `createDatafnClient` already validates schema at construction.

---

### ID: CLONEUP-SCOPE-001

- **Priority**: P0
- **Statement**: `cloneUp()` MUST compute the upload resource set deterministically from `options.resources` and schema, and MUST exclude `isRemoteOnly` resources by default.
- **Rationale**: Remote-only tables are not guaranteed to exist locally and must not be uploaded unintentionally.
- **Acceptance criteria**:
  - With `options.resources` undefined, resources uploaded are exactly `schema.resources.filter(r => !r.isRemoteOnly).map(r => r.name)` in schema order.
  - With `options.resources` provided, any unknown resource name causes `DFQL_UNKNOWN_RESOURCE` with `details.path="resources[i]"`.
  - If `options.resources` includes a remote-only resource, `cloneUp()` fails with `DFQL_INVALID` and `details.path="resources[i]"`.
- **Test vectors**: TV-CLONEUP-001, TV-CLONEUP-002, TV-CLONEUP-005
- **Notes**:
  - “Schema order” means the order of `schema.resources[]` as provided.

---

### ID: CLONEUP-JOIN-001

- **Priority**: P0
- **Statement**: When `includeManyMany !== false`, `cloneUp()` MUST enumerate many-many join stores using the canonical client naming convention `join_${from}_${relation}_${to}` for each many-many relation combination implied by schema.
- **Rationale**: `DatafnStorageAdapter` requires a join-store key; the client must derive it from schema consistently with offline relation expansion.
- **Acceptance criteria**:
  - For each schema relation with `type="many-many"` whose `from` resource is included in the resolved upload scope, `cloneUp()` computes join store names using:
    - `fromResources = Array.isArray(from) ? from : [from]`
    - `toResources = Array.isArray(to) ? to : [to]`
    - `relName = relation.relation ?? "rel"`
    - store names are all `join_${f}_${relName}_${t}` combinations.
  - Non-existent join stores MUST be ignored safely (treated as empty) and MUST NOT fail cloneUp.
- **Test vectors**: TV-CLONEUP-001, TV-CLONEUP-007, TV-CLONEUP-009
- **Notes**:
  - This requirement matches `client/src/offline/relations.ts` behavior.

---

### ID: CLONEUP-ORDER-001

- **Priority**: P0
- **Statement**: `cloneUp()` MUST generate and push mutations in a deterministic order so that retries/re-runs produce the same batch plan.
- **Rationale**: Deterministic ordering is required for reproducible batching, debugging, and consistent progress reporting.
- **Acceptance criteria**:
  - Resource iteration order is deterministic:
    - when `options.resources` is omitted: schema resource order (already defined by `CLONEUP-SCOPE-001`)
    - when `options.resources` is provided: the provided order after validation
  - Within a resource, record mutations are generated in ascending lexicographic order by `id`.
  - Stage ordering is enforced: all record upsert push batches (Stage A) complete successfully before any many-many `relate` push batches (Stage B) are attempted.
  - Join store enumeration order (when enabled) is ascending lexicographic by join store name.
  - Within a join store, join-row mutations are generated in ascending lexicographic order by `(from, to, dfqlKey(metaFiltered))`.
  - Batch segmentation is a pure partition of the deterministic mutation order (no reordering during batching).
- **Test vectors**: TV-CLONEUP-001, TV-CLONEUP-010, TV-CLONEUP-012
- **Notes**:
  - If the underlying storage adapter returns records/join rows in nondeterministic order, cloneUp is still required to sort as above.

---

### ID: CLONEUP-MUT-001

- **Priority**: P0
- **Statement**: `cloneUp()` MUST transform each local record into a schema-bounded DFQL mutation using `recordOperation` (default `"merge"`), and MUST generate deterministic `mutationId`s for idempotency.
- **Rationale**: Upload must be replay-safe and compatible with server idempotency (`(clientId, mutationId)`).
- **Acceptance criteria**:
  - For each local record `{ id, ...fields }`, cloneUp creates a mutation:
    - `resource = <resource>`
    - `version = schema.resources[resource].version`
    - `operation = recordOperation`
    - `id = record.id`
    - `record = record without id, including only schema-declared fields (unknown fields are omitted)`
    - `clientId = client.config.clientId`
    - `mutationId` follows the canonical format `{prefix}:rec:{resource}:{id}:{hash}`
  - Hash input is produced from normalized payload (stable key ordering, no undefined), and hash output is stable across runs using the FNV-1a 32-bit algorithm specified in `SPEC.md`.
  - If any local record is missing a string `id`, cloneUp fails with `DFQL_INVALID` and `details.path="records[i].id"`.
- **Test vectors**: TV-CLONEUP-001, TV-CLONEUP-008
- **Notes**:
  - The hash is non-cryptographic by design (FNV-1a 32-bit).

---

### ID: CLONEUP-MUT-002

- **Priority**: P0
- **Statement**: `cloneUp()` MUST transform each many-many join row into a DFQL `relate` mutation on the `from` resource, and MUST enforce schema metadata constraints for relation payloads.
- **Rationale**: Many-many data must be preserved; schema-bounded validation prevents silent corruption and server rejection.
- **Acceptance criteria**:
  - For each join row `{ from, to, ...meta }` in a join store derived from schema relation `(fromResource, relationName, toResource)`:
    - mutation fields are:
      - `resource = fromResource`
      - `version = fromResource.version`
      - `operation = "relate"`
      - `id = <row.from>`
      - `relations = { [relationName]: { "$ref": <row.to>, ...metaFiltered } }`
      - `mutationId` follows `{prefix}:rel:{joinStore}:{from}:{to}:{hash}`
  - The `{hash}` component MUST be computed using the FNV-1a 32-bit algorithm specified in `SPEC.md`.
  - If join row metadata contains keys not declared in schema relation `metadata`, cloneUp fails with `DFQL_UNKNOWN_FIELD` and a stable path referencing that key.
- **Test vectors**: TV-CLONEUP-001, TV-CLONEUP-009
- **Notes**:
  - Join rows missing `from` or `to` MUST fail with `DFQL_INVALID`.

---

### ID: CLONEUP-PUSH-001

- **Priority**: P0
- **Statement**: `cloneUp()` MUST push generated mutations to the server using `/datafn/push` in deterministic batches, and MUST retry batches only on transport errors up to `maxRetries`.
- **Rationale**: Large datasets require batching; retrying non-transport failures can cause nondeterministic loops and wasted load.
- **Acceptance criteria**:
  - Batch size defaults to `config.sync.pushBatchSize ?? 100` and MUST be overridable via `options.batchSize`.
  - Invalid `batchSize` or `maxRetries` values cause `DFQL_INVALID` at `details.path="batchSize"` / `"maxRetries"`.
  - A batch is retried only when `isTransportError(err) === true`.
  - After successful push, cloneUp tracks the highest `cursor` returned (base-10 integer string).
- **Test vectors**: TV-CLONEUP-010, TV-CLONEUP-011, TV-CLONEUP-013
- **Notes**:
  - “Deterministic batches” means mutation order is stable, and batching is a pure segmentation of that order.

---

### ID: CLONEUP-PUSH-002

- **Priority**: P0
- **Statement**: `cloneUp()` MUST treat any non-empty server `errors` array from a push result as a CloneUp failure (unless `failFast=false`), and MUST NOT clear changelog nor advance local cursor when any errors occurred.
- **Rationale**: Partial failures must not be acknowledged as success; otherwise the client can permanently lose un-uploaded state.
- **Acceptance criteria**:
  - If any push batch result contains `errors.length > 0`, cloneUp returns `ok=false` with aggregated `errors`.
  - In this case, local cursors are unchanged and local changelog is not cleared.
- **Test vectors**: TV-CLONEUP-001, TV-CLONEUP-009, TV-CLONEUP-012
- **Notes**:
  - The SyncEngine’s default behavior is not reused; cloneUp defines stricter semantics for safety.

---

### ID: CLONEUP-STATE-001

- **Priority**: P0
- **Statement**: On full success, `cloneUp()` MUST (a) set the local global cursor `__global_cursor__` monotonically to the highest server cursor observed, (b) clear the local changelog when configured, and (c) optionally trigger a pull.
- **Rationale**: After conversion, the client must not re-push the same pre-conversion dataset and should be able to synchronize cleanly.
- **Acceptance criteria**:
  - If `setGlobalCursorOnSuccess !== false`, `storage.setCursor("__global_cursor__", cursor)` is performed monotonically.
  - If `clearChangelogOnSuccess !== false`, the changelog is fully cleared/acked.
  - If `pullAfter !== false`, cloneUp triggers a `pullNow()` (or equivalent) after upload to pick up server-only seed/default data.
- **Test vectors**: TV-CLONEUP-006, TV-CLONEUP-011, TV-CLONEUP-012
- **Notes**:
  - “Monotonically” means only advancing if new cursor > existing.

---

### ID: CLONEUP-STATE-002

- **Priority**: P0
- **Statement**: On any failure, `cloneUp()` MUST leave local storage unchanged with respect to changelog contents and cursors.
- **Rationale**: Failure must be safely retryable without losing local state.
- **Acceptance criteria**:
  - On failure, `__global_cursor__` is unchanged.
  - On failure, changelog entries remain intact.
- **Test vectors**: TV-CLONEUP-009, TV-CLONEUP-012
- **Notes**:
  - CloneUp may still have performed remote side effects; idempotency rules ensure retry safety.

---

### ID: CLONEUP-EVT-001

- **Priority**: P1
- **Statement**: `cloneUp()` MUST emit `DatafnEvent` events: `sync_applied` on success and `sync_failed` on failure, with `context.phase="cloneup"`.
- **Rationale**: Consumers need observability to drive UI and debugging.
- **Acceptance criteria**:
  - On success, exactly one `sync_applied` is emitted with cursor + stats in context.
  - On failure, exactly one `sync_failed` is emitted with error details in context.
- **Test vectors**: TV-CLONEUP-006, TV-CLONEUP-012
- **Notes**:
  - Event types remain within the existing `DatafnEvent["type"]` union.

---

### ID: CLONEUP-COMPAT-001

- **Priority**: P0
- **Statement**: CloneUp MUST be compatible with both TypeScript and Python server implementations by using only the canonical `/datafn/push` envelope and schema-bounded DFQL mutations.
- **Rationale**: Datafn’s protocol is shared across server SDKs; client must not require a new endpoint for conversion.
- **Acceptance criteria**:
  - CloneUp uses only `remote.push({ clientId, mutations })` with mutations shaped as server validators expect.
  - No new server routes are required for correctness.
- **Test vectors**: TV-CLONEUP-001, TV-CLONEUP-010, TV-CLONEUP-014
- **Notes**:
  - If a server adds stricter limits (payload bytes), CloneUp batching remains sufficient.


# Requirements

## Table of contents

- CLONEUP-001
- CLONEUP-002
- CLONEUP-003
- CLONEUP-004
- CLONEUP-005
- CLONEUP-006
- CLONEUP-007
- CLONEUP-008
- CLONEUP-009
- CLONEUP-010
- CLONEUP-011
- CLONEUP-012
- CLONEUP-013
- CLONEUP-014

---

### ID: CLONEUP-001

- **Priority:** P0
- **Statement:** The server MUST expose `POST /datafn/cloneup` that returns a `DatafnEnvelope<CloneUpResult>`.
- **Rationale:** Datafn lacks the Flux `cloneUp()` capability; this endpoint is the server-side primitive for local-to-cloud upload.
- **Acceptance criteria:**
  - A request matching `CloneUpRequest` returns HTTP 200 with `{ ok: true, result: { ok: true, ... } }`.
  - Invalid request-level inputs return `{ ok: false, error: ... }` with a non-2xx status.
- **Test vectors:** TV-CLONEUP-001, TV-CLONEUP-005
- **Notes:** Endpoint path is appended to client `sync.remote` base URL (e.g., `${baseUrl}/cloneup`).

### ID: CLONEUP-002

- **Priority:** P0
- **Statement:** The server MUST reject invalid request-level fields (`clientId`, `resource`, `records`) with an envelope error and MUST NOT apply any writes.
- **Rationale:** Request-level validation failures are unrecoverable for safe partial execution and must fail deterministically.
- **Acceptance criteria:**
  - Missing or non-string `clientId` returns `DFQL_INVALID` with `details.path = "clientId"`.
  - Unknown `resource` returns `DFQL_UNKNOWN_RESOURCE` with `details.path = "resource"`.
  - Non-array `records` returns `DFQL_INVALID` with `details.path = "records"`.
  - For any of the above failures, no records are created/updated in the database.
- **Test vectors:** TV-CLONEUP-001 (positive), TV-CLONEUP-005, TV-CLONEUP-006
- **Notes:** This is distinct from per-record failures (CLONEUP-003).

### ID: CLONEUP-003

- **Priority:** P0
- **Statement:** The server MUST validate records individually and MUST report invalid records in `CloneUpResult.errors[]` while continuing to process other valid records.
- **Rationale:** Local datasets may contain a small number of malformed rows; clone up should salvage remaining user data.
- **Acceptance criteria:**
  - A record that is not an object is reported as an error with a deterministic `path` referencing `records[i]`.
  - A record missing `id: string` is reported as an error and is not written.
  - A record containing unknown fields is reported as an error and is not written.
  - Valid records in the same request are still inserted/updated.
- **Test vectors:** TV-CLONEUP-002 (positive), TV-CLONEUP-005 (negative control: request-level failure stops all)
- **Notes:** Error ordering MUST be deterministic (SPEC.md → Invariants → Determinism).

### ID: CLONEUP-004

- **Priority:** P0
- **Statement:** The server MUST apply upsert semantics for valid records and MUST NOT record change tracking for records whose persisted content is unchanged.
- **Rationale:** Signup flows can retry; idempotency-by-content avoids cursor inflation and redundant downstream pulls.
- **Acceptance criteria:**
  - If a record does not exist, it is created and its id appears in `inserted`.
  - If a record exists and differs, it is updated and its id appears in `updated`.
  - If a record exists and matches for all provided keys, it is not written and its id appears in `skipped`.
  - Only inserted/updated records produce `__datafn_changes` entries and advance `serverSeq`.
- **Test vectors:** TV-CLONEUP-001, TV-CLONEUP-003, TV-CLONEUP-004, TV-CLONEUP-002 (negative)
- **Notes:** Comparison MUST be deterministic deep-equality on JSON values for the provided keys.

### ID: CLONEUP-005

- **Priority:** P0
- **Statement:** The server MUST return `cursor` as a base-10 integer string representing the latest `serverSeq` observed after processing the request.
- **Rationale:** The client and other clients need a stable cursor boundary for subsequent pulls.
- **Acceptance criteria:**
  - If at least one change is recorded, `cursor` equals the maximum allocated `serverSeq` for this request.
  - If no changes are recorded, `cursor` equals the current global `serverSeq` for the namespace.
  - `cursor` matches `/^\d+$/`.
- **Test vectors:** TV-CLONEUP-001 (positive), TV-CLONEUP-003 (positive+negative), TV-CLONEUP-005 (negative request-level)
- **Notes:** Cursor semantics match `/datafn/push` (global cursor).

### ID: CLONEUP-006

- **Priority:** P1
- **Statement:** The server MUST write clone up data into the namespace derived from `authContextProvider` when configured, otherwise into the default namespace `"datafn"`.
- **Rationale:** Clone up must respect multi-user/multi-tenant isolation, or it will leak data across identities.
- **Acceptance criteria:**
  - When `authContextProvider` returns `userId`, clone up writes are isolated to that user namespace.
  - When `authContextProvider` is absent, clone up writes go to `"datafn"`.
- **Test vectors:** TV-CLONEUP-001 (default namespace), TV-CLONEUP-012 (namespace isolation)
- **Notes:** TV-CLONEUP-012 is a multi-step test that creates two contexts and ensures isolation.

### ID: CLONEUP-007

- **Priority:** P1
- **Statement:** Server plugins MUST receive `beforeSync/afterSync` callbacks for clone up as `phase = "cloneup"`.
- **Rationale:** Sync hooks are part of the server extension model; clone up must be observable and interceptable.
- **Acceptance criteria:**
  - A `beforeSync` hook can transform clone up payload.
  - A throwing/rejecting `beforeSync` hook rejects the request with an envelope error.
  - An `afterSync` hook runs after successful execution.
- **Test vectors:** TV-CLONEUP-007
- **Notes:** Hook runner semantics must remain consistent (fail-closed before, fail-open after).

### ID: CLONEUP-008

- **Priority:** P1
- **Statement:** `DatafnServerConfig.authorize` MUST accept the action `"cloneup"` and MUST be invoked after successful JSON parsing.
- **Rationale:** Authorization must cover all endpoints uniformly and must not mask parse errors.
- **Acceptance criteria:**
  - Invalid JSON returns `DFQL_INVALID` without calling `authorize`.
  - When `authorize` returns false, server responds with HTTP 403 and `{ ok: false, error: { code: "FORBIDDEN", ... } }`.
- **Test vectors:** TV-CLONEUP-001 (positive allow), TV-CLONEUP-008 (negative deny)
- **Notes:** Mirrors AUTH-001 behavior already implemented for other endpoints.

### ID: CLONEUP-009

- **Priority:** P0
- **Statement:** `@datafn/client` MUST extend `DatafnRemoteAdapter` and `DefaultHttpTransport` with a `cloneUp()` method that POSTs to `${baseUrl}/cloneup`.
- **Rationale:** The client needs a transport-level entry point for the new endpoint.
- **Acceptance criteria:**
  - `DefaultHttpTransport.cloneUp(payload)` calls `POST {baseUrl}/cloneup` with JSON body.
  - Non-2xx responses are surfaced through the existing envelope handling.
- **Test vectors:** TV-CLONEUP-009 (positive), TV-CLONEUP-006 (negative server response)
- **Notes:** Endpoint naming MUST be lowercase `cloneup` to match existing conventions.

### ID: CLONEUP-010

- **Priority:** P0
- **Statement:** `@datafn/client` MUST extend `SyncFacade` with `cloneUp(payload)` that delegates to `remote.cloneUp` and unwraps envelopes.
- **Rationale:** SyncFacade is the existing delegation surface for sync methods; clone up should be available there.
- **Acceptance criteria:**
  - `client.sync.cloneUp(payload)` calls `remote.cloneUp(payload)`.
  - If the server returns `{ ok: false, error: ... }`, the client throws a `DatafnClientError`.
- **Test vectors:** TV-CLONEUP-009
- **Notes:** Consistent with existing `seed/clone/pull/push` facade behavior.

### ID: CLONEUP-011

- **Priority:** P0
- **Statement:** `@datafn/client` MUST implement `client.sync.cloneUpNow()` to upload all existing local records to the server without requiring a changelog-to-mutation conversion.
- **Rationale:** This is the direct replacement for Flux `cloneUp()` used during offline→signup migration.
- **Acceptance criteria:**
  - Reads local records via `storage.listRecords(resource)`.
  - Uploads per resource; does not require offline changelog entries.
  - Skips resources with zero local records.
  - Returns an aggregate summary across resources.
- **Test vectors:** TV-CLONEUP-010 (positive), TV-CLONEUP-011 (negative)
- **Notes:** This method is intentionally distinct from `push()`.

### ID: CLONEUP-012

- **Priority:** P1
- **Statement:** `cloneUpNow({ resources })` MUST allow uploading a subset of resources and MUST preserve the caller-provided ordering.
- **Rationale:** Migration flows may intentionally scope uploads for performance or staged rollout.
- **Acceptance criteria:**
  - Only resources in `options.resources` are uploaded.
  - Upload order matches `options.resources`.
- **Test vectors:** TV-CLONEUP-013 (positive), TV-CLONEUP-011 (negative control)
- **Notes:** If a requested resource does not exist in schema, the client MUST throw `DFQL_UNKNOWN_RESOURCE` with `details.path = "resources[i]"`.

### ID: CLONEUP-013

- **Priority:** P2
- **Statement:** `cloneUpNow()` MUST chunk uploads per resource with a configurable `batchSize` (default 500) and MUST sort record batches by `id` for determinism.
- **Rationale:** Prevents payload limit issues and makes behavior reproducible.
- **Acceptance criteria:**
  - With `batchSize = N`, a resource with `N+1` records makes exactly 2 cloneup calls.
  - Each call’s `records` are sorted by `id` ascending.
- **Test vectors:** TV-CLONEUP-010
- **Notes:** Chunking is by record count; byte-size chunking is not required.

### ID: CLONEUP-014

- **Priority:** P1
- **Statement:** `@datafn/core` MUST extend sync hook phase types to include `"cloneup"`.
- **Rationale:** Prevents type-level drift and enables plugin authors to handle clone up.
- **Acceptance criteria:**
  - TypeScript compilation succeeds for core, client, and server after adding the new phase.
  - Plugins can declare `beforeSync(ctx, "cloneup", payload)` without type errors.
- **Test vectors:** TV-CLONEUP-014 (positive typecheck), TV-CLONEUP-014-N (negative typecheck)
- **Notes:** Typecheck vectors are validated via `npm -w @datafn/core typecheck`.

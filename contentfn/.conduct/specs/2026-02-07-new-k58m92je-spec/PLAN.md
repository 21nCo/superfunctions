# ContentFn Implementation Plan

## Architecture sketch

**Package layout (recommended; aligned with `datafn`/`docsfn` patterns):**

```
superfunctions/
  contentfn/
    .conduct/
      logs.csv
      tracker.csv
      specs/{spec_folder}/...
    core/                  # package: @contentfn/core
    server/                # package: @contentfn/server
    client/                # package: @contentfn/client
    cli/                   # package: @contentfn/cli
    packages/
      storage-adapter-*/    # optional adapters for storage backends
    examples/
      basic-server/
      next-preview/
```

**Module responsibilities**

- `@contentfn/core`
  - canonical types (schema/doc/query/patch/envelope/errors)
  - schema validation + normalization
  - CFQL validation + normalization (deterministic keys, canonical ordering)
  - patch path parsing + validation helpers (shared)
  - deterministic helpers (cursor encoding/decoding, stable ordering rules)
- `@contentfn/server`
  - HTTP endpoints (SPEC.md canonical endpoints)
  - storage implementation using `@superfunctions/db` adapter (documents, revisions, datasets, webhooks, event log)
  - publish/unpublish atomic operations
  - webhook delivery engine (queue + retry)
  - realtime transport (WebSocket or SSE) and subscription routing
  - authorization hook plumbing and limit enforcement
  - status endpoint + capabilities
- `@contentfn/client`
  - typed client for HTTP + realtime
  - retries/backoff for transient errors (RATE_LIMITED, WEBHOOK_DELIVERY_FAILED where applicable)
  - cursor handling as opaque strings
- `@contentfn/cli`
  - schema validate/upsert
  - dataset export/import
  - basic document ops

**Storage model (conceptual tables/collections; namespaced by adapter namespace + dataset):**

- `contentfn_datasets`: dataset registry (name, createdAt, deletedAt?)
- `contentfn_schema`: dataset schema (version, schemaJson, schemaHash, updatedAt)
- `contentfn_docs_published`: published docs (id, type, docJson, rev, createdAt, updatedAt, publishedAt)
- `contentfn_docs_drafts`: draft docs (id, type, docJson, rev, createdAt, updatedAt)
- `contentfn_revisions`: immutable revision records (docId, perspective, rev, timestamp, docJson or delta)
- `contentfn_assets`: asset metadata (assetId, dataset, contentType, filename, size, width/height?, url, createdAt)
- `contentfn_webhooks`: webhook registrations (webhookId, dataset, url, secret?, events, createdAt)
- `contentfn_webhook_queue`: delivery attempts (eventId, webhookId, attempt, nextRunAt, status, lastError)
- `contentfn_events`: append-only change events (eventId, dataset, type, timestamp, actor, docId, rev, changedPaths)
- `contentfn_rt_sessions`: optional realtime session tracking (connectionId, subject, dataset scopes)

## Dependency graph

- PHASE_00 establishes types, core validation helpers, and storage schema migration utilities.
- PHASE_01 depends on PHASE_00 and implements dataset + schema APIs (DS-001, SCHEMA-001, SCHEMA-002).
- PHASE_02 depends on PHASE_01 and implements documents create/get/delete + system fields (DOC-001, DOC-002).
- PHASE_03 depends on PHASE_02 and implements patch engine + `ifRev` concurrency (PATCH-001, REV-001).
- PHASE_04 depends on PHASE_02–03 and implements publish/unpublish semantics + event emission hooks (DOC-003).
- PHASE_05 depends on PHASE_02–04 and implements history + restore (HIST-001).
- PHASE_06 depends on PHASE_02 and implements CFQL query core (QRY-001, QRY-002).
- PHASE_07 depends on PHASE_06 and implements reference expansion (REF-001).
- PHASE_08 depends on PHASE_01 and implements assets subsystem (ASSET-001).
- PHASE_09 depends on PHASE_04 and implements webhooks delivery engine (WH-001).
- PHASE_10 depends on PHASE_04 and implements realtime feed (RT-001).
- PHASE_11 depends on PHASE_01–10 and implements dataset export/import (IMP-001) and its endpoints.
- PHASE_12 is cross-cutting: authorization, limits, observability, and status endpoint (AUTH-001, LIMIT-001, OBS-001, STATUS-001).
- PHASE_13 implements CLI (CLI-001) using stable HTTP/SDK.
- PHASE_14 implements search/match integration behaviors (SEARCH-001) (if not already fully satisfied in earlier query phases).

## Phases overview

| Phase | Goal | Delivered capability | Verification method |
|------:|------|----------------------|---------------------|
| 00 | Core scaffolding | Types, envelope/errors, schema/query/patch validators; storage schema and migrations | Typecheck + unit tests |
| 01 | Datasets + schema | Dataset create/list/delete; schema upsert/get; schema hash | TV-DS-*, TV-SCHEMA-* |
| 02 | Documents CRUD | docs.create/get/delete; perspectives baseline; required field validation | TV-DOC-* |
| 03 | Patch + concurrency | docs.patch ops + path validation; `ifRev` → REV_CONFLICT | TV-PATCH-*, TV-REV-* |
| 04 | Publish workflow | docs.publish/unpublish atomicity + event emission | TV-DOC-PUBLISH-*, TV-DOC-UNPUBLISH-*, TV-RT-EVENTS-001 (stubbed) |
| 05 | History + restore | docs.history and docs.restore semantics | TV-HIST-*, TV-RESTORE-* |
| 06 | CFQL query engine | /query filter/order/projection/limit/cursor determinism | TV-QRY-* |
| 07 | Reference expansion | bounded expand + cycle safety | TV-REF-* |
| 08 | Assets | asset upload/get + metadata | TV-ASSET-* |
| 09 | Webhooks | register/list/delete + signed payloads + retry queue | TV-WH-* |
| 10 | Realtime | subscribe + event streaming for doc changes | TV-RT-* |
| 11 | Import/export | deterministic artifact export/import + endpoints | TV-IMP-* |
| 12 | Security + limits + logs + status | authorize hook; limits; structured logs; /status | TV-AUTH-*, TV-LIMIT-*, TV-OBS-*, TV-STATUS-* |
| 13 | CLI | schema validate/upsert; dataset export/import; doc ops | TV-CLI-* |
| 14 | Search/match | deterministic match behavior (enabled vs disabled) | TV-QRY-MATCH-* |

## Definition of Done (global)

No phase is complete unless:
1. All deliverables for that phase are implemented.
2. All verification steps for that phase pass locally.
3. All requirements listed as covered for that phase have:
   - passing positive test vector(s)
   - passing negative test vector(s)
4. No regressions: rerun the full suite of vectors implemented so far and confirm determinism invariants.

# ContentFn Implementation Plan

## Architecture sketch

### Package layout (proposed; aligned with `datafn` / `docsfn` patterns)

```
superfunctions/
  contentfn/
    .conduct/
      specs/...
    core/                      # package: @contentfn/core
    server/                    # package: @contentfn/server
    client/                    # package: @contentfn/client
    cli/                       # package: @contentfn/cli
    examples/
      basic-blog/              # optional integration demo
```

### Module responsibilities

- **`@contentfn/core`**
  - Error/envelope types (`ContentfnError`, `ContentfnEnvelope`)
  - Schema types and validation helpers (`validateSchema`)
  - CFQL types + validation + deterministic normalization (stable key ordering, canonical defaults)
  - Patch types + validation + deterministic application helpers (pure functions)
  - Canonical encodings (reference objects, asset refs)
  - Constants for limits and defaults

- **`@contentfn/server`**
  - HTTP router (status + dataset/schema/doc/query/asset/webhook endpoints)
  - Storage layer built on `@superfunctions/db` adapter (namespaced tables/models)
  - Revision history persistence
  - Draft/published mapping and atomic publish/unpublish
  - CFQL query execution (translate to adapter queries when possible; fallback to filtered in-memory only when explicitly allowed and bounded)
  - Webhook registry + delivery worker with retries and signature
  - Realtime transport (SSE or WebSocket) + subscription registry
  - Authorization hook integration for every operation
  - Limits enforcement + structured logging

- **`@contentfn/client`**
  - Typed client for HTTP endpoints
  - Realtime connection + subscribe helpers
  - Optional helpers for preview perspective and drafts overlay

- **`@contentfn/cli`**
  - Schema validate/upsert
  - Dataset export/import
  - Basic document operations (create/get/query/patch/publish)
  - Deterministic error output and exit codes

### Storage design (high-level)

Storage MUST use `@superfunctions/db` adapter. A reference schema (exact table names are implementation-defined but MUST be namespaced per dataset):

- `contentfn_datasets`: dataset registry + metadata
- `contentfn_schema`: dataset → current schema JSON + version + hash
- `contentfn_docs_published`: published docs (current head) keyed by dataset + `_id`
- `contentfn_docs_draft`: drafts (current head) keyed by dataset + `_id` (with `drafts.` IDs)
- `contentfn_revisions`: immutable revisions keyed by dataset + docId + rev + perspective
- `contentfn_assets`: asset metadata keyed by dataset + assetId
- `contentfn_webhooks`: webhooks per dataset
- `contentfn_events`: append-only event log for webhook/realtime fanout + audit (may be sharded/partitioned by dataset)

### Eventing model

- All document/asset mutations emit an internal event to an in-process bus.
- Webhook delivery and realtime fanout consume from the bus.
- Events MUST have deterministic ordering guarantees within a dataset:
  - `events` are ordered by a monotonically increasing `seq` per dataset.
  - Realtime subscriptions MAY support resuming from a `seq` cursor.

## Dependency graph

- Phase 00 (scaffold + core types + storage schema) is prerequisite for all server phases.
- Phase 01 (datasets) is prerequisite for schema/doc operations.
- Phase 02 (schema) is prerequisite for document validation on write.
- Phase 03 (basic docs) is prerequisite for patch, publish, history, query.
- Phase 04 (draft/publish) is prerequisite for webhooks/realtime semantics around `doc.published`.
- Phase 05 (patch + concurrency) is prerequisite for deterministic revisions and events correctness.
- Phase 06 (history/restore) depends on patch + publish semantics.
- Phase 07 (CFQL query) depends on docs persistence.
- Phase 08 (references + expand) depends on CFQL projection engine.
- Phase 09 (assets) depends on dataset + auth + storage integration.
- Phase 10 (webhooks) depends on events bus and publish/patch.
- Phase 11 (realtime) depends on events bus and auth.
- Phase 12 (import/export) depends on schema/docs/assets/history.
- Phase 13 (cross-cutting limits/obs/status hardening) spans all prior phases.
- Phase 14 (CLI) depends on stable HTTP APIs.
- Phase 15 (search/match integration) depends on query + optional index.

## Phases overview

| Phase | Goal | Delivered capability | Verification |
|-------|------|----------------------|--------------|
| 00 | Scaffold + core types + storage schema | `@contentfn/core` types and validators; server storage tables/models; basic build | `npx turbo run build --filter=@contentfn/*` |
| 01 | Datasets | dataset create/list/delete; isolation enforced | TV-DS-* |
| 02 | Schema | schema upsert/get; validation + version monotonicity | TV-SCHEMA-* |
| 03 | Documents (published) | create/get/delete published docs with system fields | TV-DOC-CREATE/GET/DELETE |
| 04 | Drafts + publish | draft IDs + perspectives + publish/unpublish + events in log | TV-DOC-DRAFT-*, TV-DOC-PUBLISH/UNPUBLISH |
| 05 | Patch + concurrency | patch ops + `ifRev` optimistic concurrency | TV-PATCH-*, TV-REV-* |
| 06 | History + restore | revisions list + restore-to-draft semantics | TV-HIST-*, TV-RESTORE-* |
| 07 | CFQL query | filter/order/projection + deterministic cursor pagination | TV-QRY-* |
| 08 | References | canonical ref validation + bounded expand + cycle safety | TV-REF-* |
| 09 | Assets | upload/get + metadata extraction | TV-ASSET-* |
| 10 | Webhooks | register/list/delete + delivery with signature + retry | TV-WH-* |
| 11 | Realtime | subscribe + event delivery + auth gating | TV-RT-* |
| 12 | Import/export | dataset export/import deterministic artifact | TV-IMP-* |
| 13 | Hardening | limits enforcement, auth integration everywhere, structured logs, status endpoint policy | TV-LIMIT-*, TV-AUTH-*, TV-OBS-*, TV-STATUS-* |
| 14 | CLI | schema validate/upsert + dataset export/import + basic doc ops | TV-CLI-* |
| 15 | Search integration | `match` operator behavior + `searchfn` integration path | TV-QRY-MATCH-* |

## Definition of Done (global)

No phase is complete unless:
1. All deliverables for that phase exist at the specified paths.
2. All listed verification steps pass locally.
3. Previously completed phases’ verification steps still pass (no regressions).
4. The phase stop condition is met and documented in the phase report (if used by the execution process).


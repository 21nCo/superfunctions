# PHASE_01: Datasets + schema APIs

## Phase goal

Implement dataset lifecycle (create/list/delete) and schema upsert/get on the server with persistent storage and deterministic validation.

## In scope

- HTTP endpoints:
  - `POST /contentfn/datasets/create`
  - `POST /contentfn/datasets/list`
  - `POST /contentfn/datasets/delete`
  - `POST /contentfn/schema/upsert`
  - `POST /contentfn/schema/get`
- Server-side implementation using `@superfunctions/db` adapter:
  - dataset registry persistence
  - schema storage per dataset (version, schema json, schema hash)
- Deterministic schema hash computation (`schemaHash`)

## Out of scope

- Document CRUD
- Query engine
- Webhooks/realtime

## Deliverables

- `contentfn/server/src/index.ts` (export `createContentfnServer` or equivalent)
- `contentfn/server/src/http/router.ts` (or framework-agnostic handler)
- `contentfn/server/src/http/endpoints/datasets.ts`
- `contentfn/server/src/http/endpoints/schema.ts`
- `contentfn/server/src/storage/datasets.ts`
- `contentfn/server/src/storage/schema.ts` (read/write schema records)
- `contentfn/server/src/hash/schemaHash.ts`
- Unit/integration tests covering dataset and schema vectors:
  - dataset name validation
  - duplicate dataset error
  - schema invalid error
  - schema version conflict

## Requirements covered

- DS-001
- SCHEMA-001
- SCHEMA-002

## Implementation tasks

1. Implement dataset create/list/delete storage operations.
2. Enforce dataset name regex and return `VALIDATION_FAILED` on mismatch.
3. Enforce `DATASET_ALREADY_EXISTS` on duplicates.
4. Implement schema upsert:
   - validate schema via `@contentfn/core` validator
   - enforce monotonic versioning
   - compute deterministic `schemaHash` (canonical JSON stringify of normalized schema)
5. Implement schema get:
   - return `DATASET_NOT_FOUND` when dataset missing
6. Implement and run test vectors:
   - TV-DS-CREATE-001/002/003
   - TV-DS-DELETE-001
   - TV-SCHEMA-UPSERT-001/002
   - TV-SCHEMA-GET-001
   - TV-SCHEMA-VERSION-001/002

## Verification steps

- Run the dataset/schema integration tests and confirm envelopes/error codes match vectors.
- Confirm `schemaHash` changes only when schema content changes.

## Stop condition

- Dataset and schema endpoints are functional, persistent, deterministic, and pass the referenced test vectors.


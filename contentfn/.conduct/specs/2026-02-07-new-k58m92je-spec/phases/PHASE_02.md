# PHASE_02: Documents CRUD + perspectives baseline

## Phase goal

Implement document create/get/delete with schema validation, system fields, and baseline perspective behavior (published + draft).

## In scope

- HTTP endpoints:
  - `POST /contentfn/docs/create`
  - `POST /contentfn/docs/get`
  - `POST /contentfn/docs/delete`
- System fields behavior:
  - `_id`, `_type`, `_rev`, `_createdAt`, `_updatedAt`, optional `_publishedAt`
- Draft ID mapping and `asDraft` behavior:
  - `drafts.` prefix semantics
  - perspective `published` vs `draft`
- Required field validation against current dataset schema

## Out of scope

- Patch engine
- Publish/unpublish
- History/restore
- Query engine

## Deliverables

- `contentfn/server/src/http/endpoints/docs.ts` (create/get/delete)
- `contentfn/server/src/storage/docs.ts` (draft + published persistence)
- `contentfn/server/src/rev/rev.ts` (rev generation strategy)
- `contentfn/server/src/time/clock.ts` (server time helper)
- Tests implementing:
  - TV-DOC-CREATE-001/002
  - TV-DOC-GET-001/002
  - TV-DOC-DELETE-001
  - TV-DOC-DRAFT-ID-001
  - TV-DOC-PERSPECTIVE-001/002

## Requirements covered

- DOC-001
- DOC-002
- API-002 (envelope correctness in doc ops)

## Implementation tasks

1. Implement schema lookup per dataset on doc write; return `SCHEMA_NOT_FOUND` if missing.
2. Validate document shape against schema:
   - required fields present
   - field type compatibility
   - reference/asset canonical shapes where applicable
3. Implement create:
   - choose draft vs published target based on `asDraft`
   - enforce uniqueness of `_id` within the chosen perspective
   - set system fields deterministically
4. Implement get:
   - enforce perspective semantics and return `DOCUMENT_NOT_FOUND` when absent
5. Implement delete:
   - support `purge=true` to remove both perspectives
6. Add tests that assert:
   - draft IDs are prefixed
   - published docs are not returned from draft perspective and vice versa

## Verification steps

- Run the document integration tests covering all referenced TVs.
- Confirm system fields are present and timestamps are ISO strings.

## Stop condition

- docs.create/get/delete work across perspectives, validate against schema, and pass all referenced test vectors.


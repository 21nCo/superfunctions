# PHASE_01: Controls CRUD

## Phase goal

Implement compFn(config) returning API object with controls.* implemented: create, get, list (with optional category/tags filter), update, delete. Storage adapter used for persistence. All methods return CompfnEnvelope.

## In scope

- compFn(config) factory; store config and create API object
- controls.create(input) – validate required fields, generate id and timestamps, insert, return Control
- controls.get(id) – return CONTROL_NOT_FOUND or Control
- controls.list(filters?) – list all or filter by category, tags
- controls.update(id, input) – partial update, return CONTROL_NOT_FOUND or Control
- controls.delete(id) – remove control, return CONTROL_NOT_FOUND or void
- Validation: name, description, category required; tags optional array

## Out of scope

- Frameworks, evidence, checks, readiness, export; HTTP server

## Deliverables

- `src/compfn.ts` or `src/core/compfn.ts` – compFn(config) and API object
- `src/controls/service.ts` or inline – control CRUD using storage adapter
- `src/validation.ts` or inline – validate CreateControlInput, UpdateControlInput
- Unit tests for controls: TV-CTRL-CREATE-001, TV-CTRL-GET-001, TV-CTRL-GET-002, TV-CTRL-LIST-001, TV-CTRL-UPDATE-001, TV-CTRL-DELETE-001

## Requirements covered

- CTRL-001, API-001 (partial)

## Implementation tasks

1. Implement compFn(config): store database adapter and config; return object with controls namespace.
2. Implement controls.create: validate input (name, description, category); generate id (nanoid or uuid); set createdAt, updatedAt; insert; return { ok: true, result: Control }. On validation failure return { ok: false, error: { code: "VALIDATION_FAILED", message, details } }.
3. Implement controls.get(id): fetch by id; if not found return { ok: false, error: { code: "CONTROL_NOT_FOUND", details: { id } } }; else { ok: true, result }.
4. Implement controls.list(filters?): query controls; if category filter, filter by category; if tags filter, filter by tags (document AND/OR); return { ok: true, result: Control[] }.
5. Implement controls.update(id, input): get existing; if not found return CONTROL_NOT_FOUND; apply only provided fields; set updatedAt; save; return { ok: true, result }.
6. Implement controls.delete(id): delete by id; if not found return CONTROL_NOT_FOUND; return { ok: true, result: undefined }.
7. Write tests for all TV-CTRL-* vectors.

## Verification steps

- `npm test` or `npx vitest run` for control tests.
- All TV-CTRL-* pass. Build succeeds.

## Stop condition

- Controls CRUD complete; all test vectors pass; no regression (if Phase 00 had tests, they still pass).

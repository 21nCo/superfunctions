# PHASE_02: Frameworks CRUD and validation

## Phase goal

Implement frameworks.create, get, list, update, delete. Validate that every controlId in requirements[].controlIds exists in controls table. Reject with VALIDATION_FAILED if any controlId is unknown. Enforce max 1000 requirements per framework and 100 controlIds per requirement.

## In scope

- frameworks.create(input) – validate requirements; each controlId must exist; insert framework
- frameworks.get(id), list(), update(id, input), delete(id)
- FRAMEWORK_NOT_FOUND for get/update/delete when id missing
- VALIDATION_FAILED when requirement controlIds reference nonexistent control or limits exceeded

## Out of scope

- Evidence, checks, readiness, export

## Deliverables

- `src/frameworks/service.ts` or equivalent – framework CRUD
- Validation: requirements array; each requirementId and controlIds; controlIds exist; length limits
- Tests: TV-FW-CREATE-001, TV-FW-GET-001, TV-FW-GET-002, TV-FW-LIST-001, TV-FW-VALIDATE-CONTROLS-001, TV-FW-VALIDATE-CONTROLS-002

## Requirements covered

- FW-001, FW-002, LIMIT-001 (framework limits)

## Implementation tasks

1. Implement frameworks.create(input): validate name; validate requirements (array; each item has requirementId, controlIds array); for each controlId in every requirement, check controls table for existence; if any missing return VALIDATION_FAILED with details; if requirements.length > 1000 or any controlIds.length > 100 return VALIDATION_FAILED; generate id and timestamps; insert; return { ok: true, result: Framework }.
2. Implement frameworks.get(id), list(), update(id, input), delete(id). get/update/delete return FRAMEWORK_NOT_FOUND when id not found. update re-validates requirements (controlIds exist, limits).
3. Write tests for TV-FW-* vectors.

## Verification steps

- Run framework tests; all TV-FW-* pass.
- Create framework with nonexistent controlId → VALIDATION_FAILED.
- Create framework with 1001 requirements → VALIDATION_FAILED (or requirement with 101 controlIds).

## Stop condition

- Frameworks CRUD and validation complete; all test vectors pass.

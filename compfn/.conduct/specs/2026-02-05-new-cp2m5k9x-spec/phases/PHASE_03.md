# PHASE_03: Evidence create, get, list (immutability)

## Phase goal

Implement evidence.create, get, list. Evidence is immutable (no update/delete in API). Validate controlId exists; validate type is valid EvidenceType; enforce payload size ≤ evidencePayloadMaxBytes. Return PAYLOAD_TOO_LARGE when exceeded. Return VALIDATION_FAILED when controlId does not exist or type invalid.

## In scope

- evidence.create(input) – validate controlId exists, type in EvidenceType, payload size; generate id and createdAt; insert; return Evidence
- evidence.get(id) – EVIDENCE_NOT_FOUND or Evidence
- evidence.list(filters) – support controlId, type, since; optional frameworkId (filter by controls that belong to framework)
- No evidence.update or evidence.delete

## Out of scope

- Checks, readiness, export; adapters

## Deliverables

- `src/evidence/service.ts` – evidence create, get, list
- Payload size check (JSON.stringify(payload).length or similar) against config.evidencePayloadMaxBytes
- Tests: TV-EVID-CREATE-001, TV-EVID-CONTROL-LINK-001, TV-EVID-CONTROL-LINK-002, TV-EVID-TYPE-001, TV-EVID-TYPE-002, TV-EVID-SCOPING-001, TV-EVID-SCOPING-002, TV-EVID-PAYLOAD-SIZE-001, TV-EVID-PAYLOAD-SIZE-002, TV-EVID-IMMUTABLE-001, TV-EVID-GET-001, TV-EVID-GET-002, TV-EVID-LIST-001, TV-EVID-LIST-002

## Requirements covered

- EVID-001, EVID-002, EVID-003, CTRL-002, LIMIT-001 (payload)

## Implementation tasks

1. Implement evidence.create(input): validate controlId exists (controls.get(controlId)); validate type is in EvidenceType enum; validate payload size if payload present (≤ evidencePayloadMaxBytes); if type === "scoping_decision", validate outcome === "unknown" and payload.status is "applicable"|"not_applicable"; generate id; set timestamp (input.timestamp ?? Date.now()), actorId, outcome; insert; return { ok: true, result: Evidence }. On controlId not found or invalid type return VALIDATION_FAILED. On payload too large return PAYLOAD_TOO_LARGE.
2. Implement evidence.get(id): fetch; if not found return EVIDENCE_NOT_FOUND; return { ok: true, result: Evidence }.
3. Implement evidence.list(filters): build query for controlId, type, since (timestamp >= since). If frameworkId provided, resolve framework requirements to controlIds and filter evidence by those controlIds. Return { ok: true, result: Evidence[] }.
4. Ensure API object has evidence.create, evidence.get, evidence.list only (no update/delete).
5. Write all TV-EVID-* tests.

## Verification steps

- Run evidence tests; all TV-EVID-* pass.
- Create evidence with nonexistent controlId → VALIDATION_FAILED.
- Create evidence with payload > limit → PAYLOAD_TOO_LARGE.

## Stop condition

- Evidence create/get/list complete; immutability enforced; all test vectors pass.

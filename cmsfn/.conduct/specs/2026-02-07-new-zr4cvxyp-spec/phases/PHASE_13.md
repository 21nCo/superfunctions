# PHASE_13: Observability + limits hardening

## Phase goal

Enforce limits consistently and implement logging that is useful operationally without leaking sensitive content.

## In scope

- Upload size limits (client pre-check + server enforcement)
- Richtext max blocks enforcement
- Release size enforcement
- Structured logging for:
  - login/logout
  - role changes
  - release publish attempts
  - preview token minting (metadata only)
- Redaction guarantees:
  - no raw document bodies
  - no asset bytes
  - no auth secrets

## Out of scope

- External analytics (watchfn) integration (allowed but not required unless configured)

## Deliverables

- `cmsfn/server/src/logging/logger.ts`
- `cmsfn/server/src/limits/limits.ts`
- `cmsfn/studio/src/limits/precheck.ts`
- Tests implementing:
  - TV-OBS-001
  - TV-OBS-002
  - TV-LIMIT-UPLOAD-001
  - TV-LIMIT-RICHTEXT-001
  - TV-LIMIT-RELEASE-001

## Requirements covered

- OBS-001
- LIMIT-001

## Implementation tasks

1. Define limit constants and wire them into UI and server endpoints.
2. Implement richtext block counting deterministically.
3. Enforce release size at add-time and/or publish-time deterministically.
4. Implement structured logging and redaction.
5. Add tests that assert redaction and limit error codes.

## Verification steps

- Run limits/logging tests.
- Manual smoke: save a doc containing a "secret" field and verify logs do not contain it.

## Stop condition

- Limits and observability requirements are satisfied and tested.


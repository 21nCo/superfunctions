# PHASE 03

## Phase goal
Implement oauth-flow start/callback invariants (allowlist, PKCE, state consumption, replay/mismatch errors).

## In scope / Out of scope

- **In scope:** `start()` and `handleCallback()` orchestration logic.
- **Out of scope:** refresh/disconnect and consumer migrations.

## Deliverables

- oauth-flow service implementation for start/callback.
- Deterministic error mapping and tests for replay/mismatch/expiry cases.

## Requirements covered

- OAUTH-003
- OAUTH-004
- OAUTH-013

## Implementation tasks

1. Compose oauth-core state and service primitives into flow start/callback operations.
2. Validate redirect allowlist and provider IDs before state persistence.
3. Ensure callback consumes state atomically and maps failures to deterministic errors.
4. Emit structured flow events for start/callback success/failure.
5. Add tests for success, replay, mismatch, and expired state.

## Verification steps

1. Run:
```bash
npm -w @superfunctions/oauth-flow run test -- --runInBand
```
Expected: callback replay and mismatch tests pass deterministically.

2. Run:
```bash
rg -n "OAUTH_STATE_REPLAYED|OAUTH_CALLBACK_MISMATCH|OAUTH_STATE_INVALID" packages/oauth-flow/src packages/oauth-flow/src/__tests__
```
Expected: explicit error-code coverage in source/tests.

## Stop condition
start/callback invariants are fully covered by passing deterministic tests.

# PHASE 04

## Phase goal
Implement oauth-flow refresh/disconnect lifecycle with cleanup-on-revoke-fail semantics.

## In scope / Out of scope

- **In scope:** refresh token merge behavior, disconnect lifecycle, lifecycle event emission.
- **Out of scope:** db adapter bridge and consumer migrations.

## Deliverables

- `refresh()` and `disconnect()` implementations in oauth-flow.
- Tests for refresh token preservation and local cleanup on remote revoke failure.

## Requirements covered

- OAUTH-005
- OAUTH-006
- OAUTH-013

## Implementation tasks

1. Implement refresh path with refresh-token fallback when provider omits replacement.
2. Implement disconnect path using revoke + guaranteed local cleanup.
3. Add deterministic result flags for revoke attempted and local cleanup status.
4. Emit refresh/disconnect success/failure events.

## Verification steps

1. Run:
```bash
npm -w @superfunctions/oauth-flow run test
```
Expected: refresh/disconnect lifecycle tests pass.

2. Run:
```bash
rg -n "remoteRevokeAttempted|localTokenDeleted|connectionDeleted" packages/oauth-flow/src packages/oauth-flow/src/__tests__
```
Expected: result flags are surfaced and asserted.

## Stop condition
refresh/disconnect behavior is implemented and all lifecycle tests pass.

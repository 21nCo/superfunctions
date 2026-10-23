# PHASE_11

## Phase goal
Achieve TypeScript/Python SPV2 behavior parity.

## In scope / Out of scope
In scope:
- Python principal/scope sharing support.
- Python actor-filtered sync behavior.
- Python deny-by-default authz parity.

Out of scope:
- Documentation publishing.

## Deliverables
- `datafn/python/datafn/authz.py`
- `datafn/python/datafn/handlers/mutation.py`
- `datafn/python/datafn/handlers/sync.py`
- `datafn/python/datafn/handlers/transact.py`
- `datafn/python/tests/test_spv2_parity.py` (new)

## Requirements covered
- PY-001
- SEC-001

## Implementation tasks
1. Port principal-based share/unshare payload handling to Python.
2. Implement actor-visible sync filtering and revoke/backfill semantics.
3. Enforce deny-by-default authz behavior.
4. Add parity vectors shared with TS suite.

## Verification steps
1. `cd datafn/python && pytest -q`
Expected outcome: Python tests pass including SPV2 parity tests.
2. Compare parity report from TS and Python test outputs.
Expected outcome: no behavior mismatches.

## Stop condition
Python passes SPV2 parity vectors and no allow-by-default behavior remains.

# PHASE 16

## Phase goal
Reduce duplicated Python schema boilerplate via shared helper module.

## In scope / Out of scope

- **In scope:** shared schema typing helper + authfn/secfn Python adoption.
- **Out of scope:** Python runtime behavior changes to schema content.

## Deliverables

- Shared Python schema helper module (location to be finalized in implementation).
- Updated `authfn/python/authfn/schema.py` and `secfn/python/secfn/schema.py` imports.

## Requirements covered

- DUPL-005

## Implementation tasks

1. Create shared Python schema helper with reusable TypedDict/type primitives.
2. Replace duplicated local TypedDict declarations in authfn/secfn schemas.
3. Keep returned schema payloads unchanged.
4. Update Python tests/typecheck config if required.

## Verification steps

1. Run:
```bash
cd authfn/python && pytest
cd ../../secfn/python && pytest
```
Expected: tests pass.

2. Run:
```bash
npm run check:duplication
```
Expected: authfn/secfn schema duplication reduced below threshold.

## Stop condition
Python schema duplication is removed without changing functional schema outputs.

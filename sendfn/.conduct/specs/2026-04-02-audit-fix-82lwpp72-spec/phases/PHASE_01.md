# Phase goal

Align the public TypeScript and Python client surfaces, lifecycle behavior, and typed error model.

## In scope / Out of scope

- In scope:
  - public exports
  - `close()` lifecycle support
  - lazy optional imports
  - canonical typed error surface
- Out of scope:
  - template rendering internals
  - webhook verification internals
  - push batching performance

## Deliverables

- `sendfn/typescript/src/index.ts`
- `sendfn/typescript/src/sendfn.ts`
- `sendfn/typescript/src/errors.ts`
- `sendfn/typescript/src/types.ts`
- `sendfn/python/sendfn/__init__.py`
- `sendfn/python/sendfn/client.py`
- `sendfn/python/sendfn/errors.py`
- `sendfn/python/sendfn/http/__init__.py`
- `sendfn/python/sendfn/http/fastapi.py`
- `sendfn/typescript/tests/public_api.test.ts` (new)
- `sendfn/python/tests/test_public_api.py` (new)

## Requirements covered

- `API-001`
- `PKG-002`
- `PARITY-001`

## Implementation tasks

1. Add `close()` to both public clients and ensure it is idempotent.
2. Standardize custom error classes so they carry stable codes, retryability, and optional details.
3. Fix Python export/import ordering so `TemplateRegistry` and optional modules are not referenced before initialization.
4. Add explicit public client methods for device refresh/cleanup and suppression bulk-add/export with pass-through wiring to their service or manager layers.
5. Ensure public export lists contain only actually imported names.
6. Add parity tests for method presence and double-close behavior.

## Verification steps

1. Run `npm test --workspace sendfn/typescript -- --run public_api`.
   - Expected outcome: TS public-surface tests pass.
2. Run `python3 -m pytest sendfn/python/tests/test_public_api.py`.
   - Expected outcome: Python public-surface tests pass.
3. Run `python3 -m pytest sendfn/python/tests/test_imports.py`.
   - Expected outcome: optional imports remain lazy after client-surface changes.

## Stop condition

Stop after both SDKs expose the same supported lifecycle surface, including `close()`, and typed errors are available everywhere public callers can observe failures.

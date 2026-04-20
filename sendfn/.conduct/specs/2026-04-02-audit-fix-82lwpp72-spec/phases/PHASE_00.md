# Phase goal

Establish a clean-checkout release-gate baseline and align the public package/import identity for both SDKs.

## In scope / Out of scope

- In scope:
  - TypeScript package name and script viability
  - Python install/import baseline
  - README/install command alignment
  - test harness bootstrap for clean-checkout verification
- Out of scope:
  - template engine correctness
  - webhook verification/correlation
  - push batching/concurrency changes

## Deliverables

- `sendfn/typescript/package.json`
- `sendfn/typescript/tsconfig.json`
- `sendfn/typescript/vitest.config.ts`
- `sendfn/typescript/README.md`
- `sendfn/python/pyproject.toml`
- `sendfn/python/README.md`
- `sendfn/typescript/tests/basic.test.ts`
- `sendfn/typescript/tests/imports.test.ts` (new)
- `sendfn/python/tests/test_models.py`
- `sendfn/python/tests/test_imports.py` (new)

## Requirements covered

- `PKG-001`
- `PKG-002`
- `TEST-001`
- `DOC-001`

## Implementation tasks

1. Rename the TypeScript package manifest to `sendfn`.
2. Ensure TypeScript scripts use locally declared dev dependencies and run from repo root after `npm install`.
3. Remove eager optional-integration imports from the Python base package.
4. Update TypeScript and Python README install/import instructions to match the shipped package names and extras.
5. Add import baseline tests for both SDKs.
6. Update the repo-root verification instructions in docs to match the actual commands.

## Verification steps

1. Run `npm install`.
   - Expected outcome: workspace dependencies install successfully.
2. Run `npm run build --workspace sendfn/typescript`.
   - Expected outcome: TypeScript build completes without missing-tool errors.
3. Run `npm run lint --workspace sendfn/typescript`.
   - Expected outcome: TypeScript typecheck completes successfully.
4. Run `npm test --workspace sendfn/typescript -- --run`.
   - Expected outcome: import and baseline tests pass.
5. Run `python3 -m pip install -e ./packages/python-core`.
   - Expected outcome: shared Python core package installs from repo root.
6. Run `python3 -m pip install -e './sendfn/python[dev]'`.
   - Expected outcome: base Python package installs without optional web extras.
7. Run `python3 -m pytest sendfn/python/tests/test_imports.py`.
   - Expected outcome: `import sendfn` passes, optional integrations are not eagerly imported.

## Stop condition

Stop after both SDKs can be installed and imported from repo root with matching README/package metadata and the baseline verification commands pass.

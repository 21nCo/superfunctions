# BrowseFn Release Gate

Run these commands from the repository root before using `browsefn` in `nucleus`.

## Canonical Command List

1. `npm --prefix browsefn/typescript run build`
2. `npm --prefix browsefn/typescript run typecheck`
3. `npm --prefix browsefn/typescript run test -- --run`
4. `python3 -m compileall browsefn/python/browsefn browsefn/python/tests`
5. `python3 -m pytest browsefn/python/tests -q`
6. `npx --yes jscpd@5.4.1 browsefn/typescript/src browsefn/python/browsefn --min-lines 5 --min-tokens 50 --reporters console`
7. `node browsefn/scripts/verify-release.mjs`

## Pass Criteria

- All seven commands exit `0`.
- The duplication scan reports total duplicated lines `<= 5.0%`.
- `node browsefn/scripts/verify-release.mjs` ends with JSON containing:
  - `"ok": true`
  - `"readyForNucleus": true`

## External-Consumption Notes

- TypeScript package identity: `browsefn`
- Python package identity: `browsefn`
- TypeScript HTTP surface: `createBrowseFnRouter`
- Python HTTP surface: `create_browsefn_router`
- TypeScript provider-id source of truth: `browsefn/typescript/src/core/provider-registry.ts`
- Python provider-id source of truth: `browsefn/python/browsefn/core/provider_registry.py`

## Recommended Operator Flow

1. Run `node browsefn/scripts/verify-release.mjs`.
2. If it fails, fix the failing step and rerun the same command.
3. If it passes, BrowseFn is ready for external consumption in `nucleus`.

## Acceptance beyond the source gate

The script checks source compilation, tests and duplication; its historical readyForNucleus flag is not proof of published dependency availability, paid-provider entitlement, deployed router authorization or hosted CI. The 0.2 package/runtime and credential evidence is recorded in _conduct/browsefn-readiness.md and the migration/provider/credential notes in this directory. Run isolated tarball/wheel consumers and an appropriate native browser before releasing storage changes.

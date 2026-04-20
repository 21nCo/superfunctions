# Phase goal

Run the full BrowseFn production release gate and produce release-readiness evidence for external consumption in `nucleus`.

## In scope / Out of scope

- **In scope**:
  - final repo-root verification suite
  - release-gate script or doc
  - smoke validation for library and router surfaces
- **Out of scope**:
  - publishing packages
  - changing unrelated repository CI workflows

## Deliverables

- `browsefn/scripts/verify-release.mjs`
- `browsefn/.conduct/release-gate.md`
- `browsefn/typescript/tests/router-smoke.test.ts`
- `browsefn/python/tests/test_release_gate.py`

## Requirements covered

- QA-001
- DOC-001
- HTTP-001
- SHARED-001

## Implementation tasks

1. Add one documented release-gate script or checklist that invokes the full repo-root BrowseFn verification suite.
2. Add a TypeScript router smoke test and a Python release-gate smoke test.
3. Capture the final command set required before BrowseFn can be used in `nucleus`.
4. Ensure release-gate output clearly identifies pass/fail state.

## Verification steps

1. Run `npm --prefix browsefn/typescript run build`.
Expected: exits `0`.
2. Run `npm --prefix browsefn/typescript run typecheck`.
Expected: exits `0`.
3. Run `npm --prefix browsefn/typescript run test -- --run`.
Expected: exits `0`.
4. Run `python3 -m compileall browsefn/python/browsefn browsefn/python/tests`.
Expected: exits `0`.
5. Run `python3 -m pytest browsefn/python/tests -q`.
Expected: exits `0`.
6. Run `npx jscpd browsefn/typescript/src browsefn/python/browsefn --min-lines 5 --min-tokens 50 --reporters console`.
Expected: duplication is `<= 5.0%`.
7. Run `node browsefn/scripts/verify-release.mjs`.
Expected: exits `0` and reports BrowseFn ready for external consumption.

## Stop condition

Report the full passing command list and the final release-gate result before BrowseFn is declared ready for `nucleus`.

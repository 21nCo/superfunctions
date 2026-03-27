# PHASE_00

- Phase goal: Freeze the acceptance contract and add failing proof harnesses before renderer and site work starts.

## In scope

- release environment preflight contract
- docs contract checker skeleton
- failing parity proof routes/test inventory

## Out of scope

- renderer implementation changes
- package export changes
- dogfood site API/search alignment

## Deliverables

- Create `docsfn/scripts/release-preflight.mjs`
- Create `docsfn/scripts/docs-contract-check.mjs`
- Modify `docsfn/scripts/release-gate.mjs`
- Modify `docsfn/scripts/migration-check.mjs`
- Create proof-route inventory docs under `docsfn/examples/README.md`
- Create/modify test harness files for proof-route coverage

## Requirements covered

- `DOCS-001`
- `TEST-001`
- `GATE-001`
- `BUILD-001`

## Implementation tasks

1. Add an environment preflight that checks required binaries and workspace bootstrap before package builds start.
2. Add a docs contract checker that scans public docs for internal imports, unsupported subpaths, absolute machine paths, and inconsistent API model language.
3. Define the canonical proof-route list for docs/api/blog/embedded surfaces in both example apps.
4. Make `migration-check` assert that proof routes exist and are named deterministically, even before render parity passes.
5. Make release-gate failure modes explicit and deterministic.

## Verification steps

1. Run: `node docsfn/scripts/release-preflight.mjs`
   Expected outcome: reports either ready state or `DOCS_RELEASE_ENV_INVALID` with actionable missing prerequisites.
2. Run: `node docsfn/scripts/docs-contract-check.mjs`
   Expected outcome: current violations are reported deterministically.
3. Run: `node docsfn/scripts/release-gate.mjs`
   Expected outcome: preflight runs before package builds; gate fails deterministically on existing parity/docs violations rather than opaque missing-binary failures.

## Stop condition

- Report the canonical proof-route inventory.
- Report the docs contract violations and release-preflight checks that later phases must drive to zero.

# PHASE_07

- Phase goal: Harden the full release gate and clean-checkout bootstrap flow until production-readiness claims are locally provable.

## In scope

- release gate orchestration
- deterministic release summary
- full matrix execution
- clean-checkout bootstrap docs and verification

## Out of scope

- new product features beyond the audited gaps

## Deliverables

- Modify `docsfn/scripts/release-gate.mjs`
- Modify `docsfn/scripts/migration-check.mjs`
- Modify `docsfn/.conduct/release-checklist.md`
- Add any missing local test/e2e config needed by the gate
- Finalize bootstrap commands in public docs if still needed

## Requirements covered

- `GATE-001`
- `BUILD-001`
- `TEST-001`

## Implementation tasks

1. Run preflight before builds.
2. Integrate docs contract check, component parity tests, example proof checks, fixture builds, package builds, and any required `searchfn/client` verification for the shared search runtime path into one matrix.
3. Emit deterministic `DocsReleaseGateSummary`.
4. Ensure any failing matrix item exits non-zero with canonical error codes.
5. Verify that a clean checkout following documented bootstrap reaches a green gate.

## Verification steps

1. From a bootstrapped checkout, run: `node docsfn/scripts/release-gate.mjs`
   Expected outcome: summary artifact emitted; full matrix passes, including the canonical search runtime path shared between docsfn and current `@searchfn/*` packages.
2. From an intentionally unbootstrapped environment, run the same command.
   Expected outcome: immediate `DOCS_RELEASE_ENV_INVALID` with actionable guidance.

## Stop condition

- Report the final release-gate summary schema path and the canonical clean-checkout command sequence.

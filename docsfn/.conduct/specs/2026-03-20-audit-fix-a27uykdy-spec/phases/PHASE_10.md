# PHASE_10

- Phase goal: Finish production hardening with examples, documentation, release checks, and a full local release gate proving docsfn can replace the current repo docs sites.

## In scope

- Final example-site verification against canonical fixtures.
- Public documentation and migration guidance.
- Release gate scripts and local verification matrix.
- Final parity checks for the `datafn/docs` and `searchfn/docs` migration target.

## Out of scope

- Net-new feature scope beyond the approved spec.
- CI vendor-specific workflow authoring unless required to support the local release gate.
- Post-release roadmap planning.

## Deliverables

- Modify `docsfn/README.md`.
- Modify `docsfn/next/README.md`.
- Modify `docsfn/sveltekit/README.md`.
- Create `docsfn/examples/README.md`.
- Create `docsfn/scripts/release-gate.mjs`.
- Create `docsfn/scripts/migration-check.mjs`.
- Modify `docsfn/test-fixtures/README.md`.
- Create `docsfn/.conduct/release-checklist.md`.

## Requirements covered

- `MIG-001`
- `NEXT-001`
- `SVELTE-001`
- `PKG-001`
- `TEST-001`

## Implementation tasks

1. Update all public docs so package names, install commands, supported frameworks, compatibility preset usage, and migration steps reflect the final production contract.
2. Add an examples README that explains how to run the Next and SvelteKit reference sites against the canonical fixtures.
3. Add a release-gate script that runs the package build matrix, fixture tests, example site builds, and migration parity assertions in one local command.
4. Add a migration-check script that compares canonical route manifests from docsfn against expected route and navigation snapshots for `datafn/docs` and `searchfn/docs`.
5. Create a release checklist in `docsfn/.conduct` that operators can use before cutting a version, with explicit checks for package metadata, build artifacts, types, examples, and fixture parity.
6. Run the full local verification matrix and capture any residual warnings that are acceptable for release.
7. Do not declare production readiness until the release gate passes with zero error-severity diagnostics and no unresolved parity regressions on the canonical fixtures.

## Verification steps

1. Run: `node /Users/serro/Documents/dev/n/superfunctions/docsfn/scripts/release-gate.mjs`
   Expected outcome: all package builds, tests, and example-site builds pass in one run.
2. Run: `node /Users/serro/Documents/dev/n/superfunctions/docsfn/scripts/migration-check.mjs`
   Expected outcome: route, navigation, and compatibility parity checks pass for both canonical repo fixtures.
3. Manual check: review `docsfn/.conduct/release-checklist.md` against the generated artifacts.
   Expected outcome: every checklist item is satisfied and no blocked release item remains open.

## Stop condition

- Report the exact release-gate command that now passes locally.
- Report whether `datafn/docs` and `searchfn/docs` are both cleared for migration from Fumadocs to docsfn.
- Report any residual warnings that are acceptable for release and why they are non-blocking.

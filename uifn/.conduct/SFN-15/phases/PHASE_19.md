# PHASE_19: Production Release Gate

## Phase Goal

Replace the current release gate with the final SFN-15 production-readiness gate.

## In Scope

- Build/lint/typecheck/test.
- Core vectors.
- Adapter conformance.
- Component tests.
- Pattern tests.
- Superfunction mock tests.
- Storybook tests.
- A11y checks.
- Visual regression checks.
- SSR/hydration checks.
- Pack/export-map checks.
- Manifest/docs/token/Tailwind checks.
- Redaction and path-portability checks.

## Out of Scope

- Remote CI configuration unless needed for local gate parity.

## Deliverables

- `scripts/verify-uifn-release.mjs`
- `scripts/verify-uifn-adapter.mjs`
- `scripts/verify-uifn-catalog.mjs`
- `scripts/verify-uifn-stories.mjs`
- `scripts/verify-uifn-a11y.mjs`
- `scripts/verify-uifn-visual.mjs`
- `scripts/verify-uifn-secrets.mjs`
- release evidence schemas

## Requirements Covered

TEST-001, TEST-002, DOCS-001, SEC-001, VER-001

## Implementation Tasks

1. Define final release JSON output schema.
2. Wire all package checks into the gate.
3. Wire manifest/catalog/docs checks into the gate.
4. Wire Storybook, a11y, visual, and SSR checks into the gate.
5. Wire token contrast and Tailwind static-class checks into the gate.
6. Add no-absolute-path and no-secret checks.
7. Add dry-run output for release contract preview.

## Verification Steps

```bash
npm run verify:uifn-release -- --dry-run
npm run verify:uifn-release
```

Expected outcome: dry run reports full contract; full run passes only when all SFN-15 requirements are satisfied.

## Stop Condition

Report final release gate output and remaining blocked checks, if any.


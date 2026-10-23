# PHASE_06 - Patterns and Superfunction-backed Panels

## Phase Goal

Render and test controlled patterns and SF-backed panels in every Workbench app.

## In Scope

- 14 controlled patterns.
- 14 SF-backed panels.
- Fake clients.
- Nine-state SF matrix.
- Product-like routes.

## Out of Scope

- Live backend integration.

## Deliverables

- Pattern Workbench renderers for all frameworks.
- SF Workbench renderers for all frameworks.
- Fake client fixtures.
- Pattern browser QA.
- SF browser QA.

## Requirements Covered

- QA-009
- SEC-001
- WB-004

## Implementation Tasks

1. Add controlled pattern route generation.
2. Add SF panel route generation.
3. Add injected fake clients for authfn, plugfn, filefn, and billfn panels.
4. Add state routes for loading, empty, error, partial, permission-denied, optimistic, success, degraded-network, and unsupported-capability.
5. Add browser QA for state rendering, interactions, no backend imports, no global clients, and no live network calls.

## Verification Steps

```bash
npm run verify:uifn-browser -- --family pattern
npm run verify:uifn-browser -- --family sf
npm run verify:uifn-examples -- --scope offline
git diff --check
```

Expected outcome: all controlled patterns and SF panels render and pass state QA across all five frameworks.

## Stop Condition

Stop and report pattern count, SF panel count, state count, and fake-client validation.

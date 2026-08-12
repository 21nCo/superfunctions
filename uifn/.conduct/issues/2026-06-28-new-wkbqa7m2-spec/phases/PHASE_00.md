# PHASE_00 - Inventory and QA Contract Schema

## Phase Goal

Create the shared catalog and QA contract schema that all Workbench apps and browser tests use.

## In Scope

- Component inventory for all 45 registry components.
- Pattern inventory for all controlled patterns.
- SF panel inventory for all backed panels.
- QA contract schema and validation.
- Drift checks against registry manifests and story manifests.

## Out of Scope

- Framework app UI.
- Browser Playwright execution.

## Deliverables

- uifn/examples/shared/src/component-inventory.ts
- uifn/examples/shared/src/pattern-inventory.ts
- uifn/examples/shared/src/sf-inventory.ts
- uifn/examples/shared/src/qa-contract.ts
- uifn/examples/shared/src/routes.ts
- uifn/examples/shared/src/__tests__/qa-contract.test.ts
- scripts/verify-uifn-examples.mjs

## Requirements Covered

- WB-002
- QA-001
- SEC-001

## Implementation Tasks

1. Generate or author the component inventory from uifn/components/registry/components.
2. Assign QA profiles to all 45 components.
3. Add pattern and SF inventories from existing story manifests.
4. Define the QA contract TypeScript types and runtime validator.
5. Add route generation helpers.
6. Add tests for missing component, unknown slug, missing QA profile, and missing required route.
7. Add static verification for offline and secret-free examples.

## Verification Steps

```bash
npm --workspace @uifn/examples-shared run build
npm --workspace @uifn/examples-shared run test
node scripts/verify-uifn-examples.mjs --scope contracts
git diff --check
```

Expected outcome: all inventories validate and the component count is 45.

## Stop Condition

Stop and report the contract schema, inventory counts, and any intentionally unsupported framework capability before starting Phase 01.

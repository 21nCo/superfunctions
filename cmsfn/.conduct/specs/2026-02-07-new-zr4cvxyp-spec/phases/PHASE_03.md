# PHASE_03: Studio boot + desk navigation + dataset selector

## Phase goal

Implement the Studio web app shell, render the configured desk structure deterministically, and provide dataset selection that scopes all UI actions.

## In scope

- Studio route `/studio`
- Desk navigation tree rendering from config
- Dataset selector and propagation into panes

## Out of scope

- Document lists and editor behavior (next phases)

## Deliverables

- `cmsfn/studio/src/app.tsx` (or equivalent)
- `cmsfn/studio/src/desk/DeskTree.tsx`
- `cmsfn/studio/src/datasets/DatasetSelector.tsx`
- `cmsfn/studio/src/config/loadConfig.ts`
- UI tests (snapshot or DOM tests) implementing:
  - TV-STUDIO-BOOT-001
  - TV-DESK-STRUCT-001
  - TV-DATASET-SCOPE-001 (partial: ensures dataset value is used downstream)

## Requirements covered

- STUDIO-001
- STUDIO-002 (partial)

## Implementation tasks

1. Choose framework (React recommended) and create studio scaffolding.
2. Implement deterministic desk rendering:
   - stable keys from `@cmsfn/core` desk keys
3. Implement dataset selector:
   - initial dataset default deterministic (first config dataset)
4. Add tests verifying desk ordering stability.

## Verification steps

- Run studio build.
- Run UI tests for boot + desk determinism.

## Stop condition

- Studio boots, desk is deterministic, and dataset selection is functional.


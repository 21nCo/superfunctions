# PHASE_13: Data-rich Components

## Phase Goal

Implement the highest-risk data-rich components with deterministic behavior and extensive interaction coverage.

## In Scope

- Calendar
- Date Picker
- Command
- Data Table
- Resizable
- Sidebar

## Out of Scope

- Superfunction-backed data fetching.
- App-specific table schemas.

## Deliverables

- core controllers where needed
- component implementations across frameworks
- large-data fixtures
- keyboard and interaction stories
- registry items

## Requirements Covered

COMP-001, COMP-003, STORY-002, TEST-002

## Implementation Tasks

1. Define controller behavior for each data-rich component.
2. Add fixtures for large lists, disabled items, empty states, and errors.
3. Implement Data Table sort/filter/pagination/selection behavior.
4. Implement Calendar and Date Picker keyboard/date constraints.
5. Implement Command filtering/grouping/keyboard behavior.
6. Implement Sidebar responsive/collapsed behavior.
7. Implement Resizable pointer and keyboard behavior.

## Verification Steps

```bash
npm --workspace @uifn/components run test -- data-rich
npm run verify:uifn-stories -- --scope data-rich
npm run verify:uifn-visual -- --scope data-rich
```

Expected outcome: data-rich components pass interaction, large-data, a11y, and visual checks.

## Stop Condition

Report performance characteristics and any selected third-party engine decisions.

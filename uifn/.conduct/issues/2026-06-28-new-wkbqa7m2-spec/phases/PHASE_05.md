# PHASE_05 - Data-rich and Complex Layout QA

## Phase Goal

Add browser QA for data-rich and complex layout components.

## In Scope

- calendar
- command
- data-table
- date-picker
- resizable
- scroll-area
- sidebar

## Out of Scope

- Live backend data.
- Cross-browser testing beyond Chromium.

## Deliverables

- uifn/examples/browser-qa/src/assertions/data-table.ts
- uifn/examples/browser-qa/src/assertions/calendar.ts
- uifn/examples/browser-qa/src/assertions/command.ts
- uifn/examples/browser-qa/src/assertions/resizable.ts
- uifn/examples/browser-qa/src/assertions/sidebar.ts
- uifn/examples/browser-qa/src/specs/data-rich.spec.ts

## Requirements Covered

- QA-005
- QA-007
- QA-008
- QA-010

## Implementation Tasks

1. Add deterministic large, empty, loading, error, and success fixtures.
2. Add data-table sorting, filtering, pagination, selection, column visibility, and large-data tests.
3. Add calendar/date-picker min, max, disabled-date, keyboard, locale, and timezone tests.
4. Add command filtering, disabled item, empty, loading, and keyboard selection tests.
5. Add resizable pointer, keyboard, min/max, orientation, and nested panel tests.
6. Add sidebar responsive, nested navigation, focus, collapse, and persistence tests.

## Verification Steps

```bash
npm run verify:uifn-browser -- --profile data-rich
git diff --check
```

Expected outcome: all data-rich behavior passes across all five framework apps.

## Stop Condition

Stop and report data-rich behavior matrix and any fixture caps used for determinism.

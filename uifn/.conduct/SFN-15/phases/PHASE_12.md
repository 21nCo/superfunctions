# PHASE_12: Styled Components Batch B

## Phase Goal

Implement form, overlay, disclosure, and navigation components across supported frameworks.

## In Scope

- Accordion
- Alert Dialog
- Breadcrumb
- Checkbox
- Collapsible
- Context Menu
- Dialog
- Dropdown Menu
- Form
- Hover Card
- Input
- Input OTP
- Menubar
- Pagination
- Popover
- Radio Group
- Scroll Area
- Select
- Sheet
- Slider
- Switch
- Tabs
- Textarea
- Toggle
- Toggle Group
- Tooltip

## Out of Scope

- Data Table.
- Calendar/Date Picker.
- Sidebar.
- Resizable.
- Command.

## Deliverables

- component implementations for batch B
- recipes for batch B variants
- stories, fixtures, tests, registry items

## Requirements Covered

COMP-001, COMP-002, CORE-001, CORE-002, ADAPT-001, STORY-002

## Implementation Tasks

1. Build styled wrappers over framework adapters.
2. Add form integration behavior where applicable.
3. Add overlay portal and focus stories.
4. Add keyboard interaction stories.
5. Add invalid/disabled/loading states where applicable.
6. Add source-installable registry files.

## Verification Steps

```bash
npm --workspace @uifn/components run test -- batch-b
npm run verify:uifn-stories -- --scope batch-b
npm run verify:uifn-a11y -- --scope batch-b
```

Expected outcome: batch B passes conformance, a11y, stories, and registry checks.

## Stop Condition

Report any primitive/component behavior mismatches.


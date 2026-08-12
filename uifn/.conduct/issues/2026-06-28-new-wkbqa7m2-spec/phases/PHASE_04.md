# PHASE_04 - Overlay and Floating Geometry QA

## Phase Goal

Prove overlay and floating components position and behave correctly in real browser edge cases.

## In Scope

- alert-dialog
- context-menu
- dialog
- dropdown-menu
- hover-card
- menubar
- popover
- sheet
- tooltip
- select and combobox overlay portions

## Out of Scope

- Data-rich workflows.
- Non-overlay form controls already covered in Phase 03.

## Deliverables

- uifn/examples/browser-qa/src/assertions/geometry.ts
- uifn/examples/browser-qa/src/assertions/overlay.ts
- uifn/examples/browser-qa/src/specs/overlays.spec.ts
- scripts/verify-uifn-overlays.mjs

## Requirements Covered

- QA-003
- QA-007
- QA-008
- QA-010

## Implementation Tasks

1. Add default placement fixtures.
2. Add top-left, top-right, bottom-left, and bottom-right viewport edge fixtures.
3. Add scroll container, overflow clipping, transformed parent, mobile, long-content, nested overlay, and RTL fixtures.
4. Add bounding-box assertions for visibility, clipping, trigger association, and placement tolerance.
5. Add Escape, outside-click, hover, focus, tab, and focus-return assertions.
6. Add focused verify:uifn-overlays command.

## Verification Steps

```bash
npm run verify:uifn-overlays
npm run verify:uifn-browser -- --profile overlay
git diff --check
```

Expected outcome: overlay content remains visible, associated, and reachable across all required collision cases.

## Stop Condition

Stop and report collision matrix results by slug and framework.

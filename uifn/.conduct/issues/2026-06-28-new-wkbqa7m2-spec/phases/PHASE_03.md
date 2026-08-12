# PHASE_03 - Controls, Forms, Static, Feedback, Layout, and Typography QA

## Phase Goal

Add real browser QA for non-overlay component profiles.

## In Scope

- Static profile.
- Control profile.
- Form profile.
- Feedback profile.
- Layout profile.
- Typography profile.

## Out of Scope

- Overlay collision geometry.
- Data-rich large workflows.

## Deliverables

- uifn/examples/browser-qa/src/assertions/control.ts
- uifn/examples/browser-qa/src/assertions/form.ts
- uifn/examples/browser-qa/src/assertions/static.ts
- uifn/examples/browser-qa/src/assertions/layout.ts
- uifn/examples/browser-qa/src/specs/non-overlay.spec.ts

## Requirements Covered

- QA-004
- QA-006
- QA-007
- QA-008

## Implementation Tasks

1. Add click and keyboard assertions for button, checkbox, collapsible, pagination, radio-group, switch, tabs, toggle, and toggle-group.
2. Add form submission assertions for form, input, input-otp, select, slider, and textarea.
3. Add static rendering assertions for aspect-ratio, avatar, badge, card, label, progress, separator, skeleton, table, and typography.
4. Add feedback assertions for sonner, toast, progress, and skeleton.
5. Add layout assertions for aspect-ratio, card, resizable, scroll-area, separator, and sidebar.
6. Run the checks across all five framework apps.

## Verification Steps

```bash
npm run verify:uifn-browser -- --profile control
npm run verify:uifn-browser -- --profile form
npm run verify:uifn-browser -- --profile static
npm run verify:uifn-browser -- --profile feedback
npm run verify:uifn-browser -- --profile layout
git diff --check
```

Expected outcome: every non-overlay profile passes browser interaction, a11y, and visual smoke checks.

## Stop Condition

Stop and report pass counts by profile, framework, and component.

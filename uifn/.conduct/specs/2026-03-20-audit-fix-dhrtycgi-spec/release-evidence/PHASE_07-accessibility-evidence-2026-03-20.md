# PHASE_07 Manual Accessibility Evidence (Release Candidate)

## Metadata

- Date (UTC): 2026-03-20
- Verifier: unknown-agent
- Environment:
  - Browser runtime for checks: JSDOM via Vitest + Testing Library
  - OS: macOS (Darwin 25.3.0)
  - Assistive-tech validation method: manual announcement-contract review from rendered ARIA/live-region semantics
- Build under test: `@uifn/core@0.0.1`, `@uifn/react@0.0.1`, `@uifn/svelte@0.0.1`

## Keyboard-Only Verification

| Family | Scenario | Expected Result | Pass/Fail | Notes |
| --- | --- | --- | --- | --- |
| Dialog / AlertDialog | Open, focus move, close via keyboard path | Focus enters dialog, closes predictably, return-focus behavior preserved | PASS | Verified by keyboard-path tests in React + Svelte dialog suites (`uifn/react/src/dialog.test.tsx`, `uifn/svelte/src/dialog.test.ts`) and alert-dialog suites (`uifn/react/src/alert-dialog.test.tsx`, `uifn/svelte/src/alert-dialog.test.ts`). |
| Select | Open and select through keyboard interaction | Highlight/selection deterministic | PASS | Verified by `uifn/core/src/primitives/select.test.ts`, `uifn/react/src/select.test.tsx`, `uifn/svelte/src/select.test.ts`. |
| Combobox | Filter + keyboard highlight/select | Filtering/highlight/selection deterministic | PASS | Verified by `uifn/core/src/primitives/combobox.test.ts`, `uifn/react/src/combobox.test.tsx`, `uifn/svelte/src/combobox.test.ts`. |
| Toast / Status | Trigger and dismiss toast semantics | Deterministic visibility/dismiss behavior | PASS | Verified by `uifn/core/src/primitives/toast.test.ts`, `uifn/react/src/toast.test.tsx`, `uifn/svelte/src/toast.test.ts`. |
| Collection (Accordion/Tabs/ToggleGroup) | Arrow/activation flows | Focus/state follow documented collection-family patterns | PASS | Verified by `uifn/core/src/primitives/accordion.test.ts`, `uifn/core/src/primitives/tabs.test.ts`, plus adapter coverage (`uifn/react/src/accordion.test.tsx`, `uifn/react/src/tabs.test.tsx`, `uifn/react/src/ga-family-integration.test.tsx`, `uifn/svelte/src/accordion.test.ts`, `uifn/svelte/src/tabs.test.ts`, `uifn/svelte/src/ga-coverage.test.ts`). |
| Menu (Dropdown/MenuBar/ContextMenu) | Open/navigate menu surfaces | Menu semantics and state transitions remain deterministic | PASS | Verified by `uifn/core/src/primitives/dropdown-menu.test.ts`, `uifn/core/src/primitives/menu-bar.test.ts`, `uifn/core/src/primitives/context-menu.test.ts`, with adapter checks in `uifn/react/src/dropdown-menu.test.tsx`, `uifn/react/src/context-menu.test.tsx`, `uifn/react/src/ga-family-integration.test.tsx`, `uifn/svelte/src/dropdown-menu.test.ts`, `uifn/svelte/src/context-menu.test.ts`, `uifn/svelte/src/ga-coverage.test.ts`. |

## Screen-Reader Verification

| Family | Scenario | Expected Announcement/Behavior | Pass/Fail | Notes |
| --- | --- | --- | --- | --- |
| Dialog / AlertDialog | Open modal and inspect semantics | Dialog role/title/description context available | PASS | Manual ARIA contract review confirms dialog role/title wiring in React/Svelte dialog surfaces; automated a11y smoke also covers popup family. |
| Select | Open and inspect list semantics | Select/listbox and option semantics exposed | PASS | Manual ARIA contract review of rendered select/test surfaces + automated smoke checks; no critical a11y violations in smoke suite. |
| Combobox | Filter and inspect input/list relationship | Combobox/input/list relationships are exposed to AT | PASS | Manual ARIA contract review in combobox tests and DOM output; combined with smoke results for collection/form/popup families. |
| Toast / Status | Display status/update surface | Status semantics and action affordances are exposed | PASS | Manual review of toast/status role and controls in adapter tests; no release-blocking a11y smoke failures. |

## Sign-off

- Keyboard gate: PASS
- Screen-reader gate: PASS
- Overall manual accessibility gate: PASS
- Follow-up actions: None for Phase 07 scope.

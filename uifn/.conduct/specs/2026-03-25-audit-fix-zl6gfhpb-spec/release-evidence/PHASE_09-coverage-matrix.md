# PHASE_09 Coverage Matrix

## Scope

This matrix points every `P0`/`P1` requirement in the `2026-03-25-audit-fix-zl6gfhpb-spec` bundle at its current objective verification record.

`QA-002` remains blocked in this phase because no real human-run browser + assistive-technology sign-off was performed in this shell-only environment.

## Requirement Map

| Requirement | Priority | Primary evidence | Current status |
| --- | --- | --- | --- |
| `REL-001` | `P0` | `PHASE_00-2026-03-25-04qlb2ak-report.md`, `PHASE_08-2026-03-25-x6d9r2mv-report.md`, `uifn/README.md`, `uifn/SPEC.md` | `PASS` |
| `REL-002` | `P0` | `PHASE_00-2026-03-25-04qlb2ak-report.md`, `scripts/verify-uifn-release.mjs --dry-run` | `PASS` |
| `REL-003` | `P0` | `scripts/verify-uifn-release.mjs`, `uifn/.conduct/release-evidence/consumer-smoke.json`, `PHASE_09-consumer-smoke.md` | `PASS` after consumer smoke generation |
| `CORE-001` | `P0` | `PHASE_02-2026-03-25-5j1qvzwb-report.md`, `uifn/core/src/state/machine.ts`, core primitive tests | `PASS` |
| `CORE-002` | `P0` | `PHASE_01-2026-03-25-073815-report.md`, `PHASE_04-2026-03-25-083014-report.md`, `PHASE_06-2026-03-25-b7k4n2qd-report.md`, duplicate-ID tests in React/Svelte | `PASS` |
| `CORE-003` | `P0` | `PHASE_01-2026-03-25-073815-report.md`, `uifn/core/src/errors.ts`, adapter context-error tests | `PASS` |
| `CORE-004` | `P0` | React `src/accordion.a11y.test.tsx`, Svelte `src/accessibility.a11y.test.ts`, manual-a11y blocker artifact | `PARTIAL` pending `QA-002` sign-off |
| `DISC-001` | `P0` | `PHASE_02-2026-03-25-5j1qvzwb-report.md`, `uifn/core/src/primitives/accordion.test.ts`, `uifn/svelte/src/controlled-reactivity.test.ts` | `PASS` |
| `FORM-001` | `P0` | `PHASE_02-2026-03-25-5j1qvzwb-report.md`, checkbox/switch/radio tests in core, React, and Svelte | `PASS` |
| `DLG-001` | `P0` | `PHASE_03-2026-03-25-omyswvpq-report.md`, `PHASE_05-2026-03-25-k7p9m2qx-report.md`, `PHASE_07-2026-03-25-q4m8n1zr-report.md`, dialog/alert-dialog tests | `PASS` |
| `POP-001` | `P1` | `PHASE_03-2026-03-25-omyswvpq-report.md`, popover/hover-card tests in core, React, and Svelte | `PASS` |
| `MENU-001` | `P0` | `PHASE_03-2026-03-25-omyswvpq-report.md`, core `dropdown-menu.test.ts`, React `ga-family-integration.test.tsx`, Svelte `ga-coverage.test.ts` | `PASS` |
| `SEL-001` | `P0` | `PHASE_03-2026-03-25-omyswvpq-report.md`, `PHASE_05-2026-03-25-k7p9m2qx-report.md`, `PHASE_07-2026-03-25-q4m8n1zr-report.md`, select tests and a11y smoke | `PASS` |
| `CMB-001` | `P0` | `PHASE_03-2026-03-25-omyswvpq-report.md`, `PHASE_05-2026-03-25-k7p9m2qx-report.md`, `PHASE_07-2026-03-25-q4m8n1zr-report.md`, combobox tests and a11y smoke | `PASS` |
| `RANGE-001` | `P1` | `PHASE_03-2026-03-25-omyswvpq-report.md`, slider/progress tests in core, React, and Svelte | `PASS` |
| `SCROLL-001` | `P1` | `PHASE_03-2026-03-25-omyswvpq-report.md`, `PHASE_05-2026-03-25-k7p9m2qx-report.md`, `PHASE_07-2026-03-25-q4m8n1zr-report.md`, scroll-area tests | `PASS` |
| `SIMPLE-001` | `P1` | `PHASE_08-2026-03-25-x6d9r2mv-report.md`, `uifn/react/src/ga-helper-coverage.test.tsx`, `uifn/svelte/src/ga-coverage.test.ts` | `PASS` |
| `REACT-001` | `P0` | `PHASE_04-2026-03-25-083014-report.md`, `PHASE_05-2026-03-25-k7p9m2qx-report.md`, React family tests | `PASS` |
| `REACT-002` | `P0` | `PHASE_04-2026-03-25-083014-report.md`, `PHASE_05-2026-03-25-k7p9m2qx-report.md`, SSR + duplicate-ID coverage | `PASS` |
| `SVELTE-001` | `P0` | `PHASE_06-2026-03-25-b7k4n2qd-report.md`, `PHASE_07-2026-03-25-q4m8n1zr-report.md`, `uifn/svelte/src/controlled-reactivity.test.ts` | `PASS` |
| `SVELTE-002` | `P0` | `PHASE_06-2026-03-25-b7k4n2qd-report.md`, build/lint/typecheck without warning suppression | `PASS` |
| `DOCS-001` | `P0` | `PHASE_08-2026-03-25-x6d9r2mv-report.md`, `uifn/README.md`, `uifn/SPEC.md`, package READMEs | `PASS` |
| `FILES-001` | `P1` | `PHASE_08-2026-03-25-x6d9r2mv-report.md`, `uifn/files/README.md`, pack validation | `PASS` |
| `QA-001` | `P0` | React `src/accordion.a11y.test.tsx`, React `src/ga-family-integration.test.tsx`, Svelte `src/accessibility.a11y.test.ts`, Svelte `src/ga-coverage.test.ts`, prior family phase reports | `PASS` |
| `QA-002` | `P0` | `PHASE_09-manual-accessibility.md`, `uifn/.conduct/release-evidence/manual-a11y.json` | `BLOCKED` |
| `COMPAT-001` | `P0` | `PHASE_08-2026-03-25-x6d9r2mv-report.md`, `scripts/verify-uifn-release.mjs`, `uifn/.conduct/release-evidence/consumer-smoke.json`, `PHASE_09-consumer-smoke.md` | `PASS` |

## PHASE_09 Additions

- React a11y smoke now covers `Dialog`, `AlertDialog`, `Select`, `Combobox`, `Toast`, and a collection family in `uifn/react/src/accordion.a11y.test.tsx`.
- Svelte a11y smoke now covers `Dialog`, `AlertDialog`, `Select`, `Combobox`, `Toast`, and a collection family in `uifn/svelte/src/accessibility.a11y.test.ts`.
- Queue/scale closure now includes 25-toast coverage in `uifn/react/src/ga-family-integration.test.tsx` and `uifn/svelte/src/ga-coverage.test.ts`.
- Tarball-based consumer smoke is now produced by `scripts/verify-uifn-release.mjs` and recorded in `PHASE_09-consumer-smoke.md`.

## Blocker

- `QA-002` cannot move to `PASS` until a human verifier records actual browser + assistive-technology runs for React and Svelte using the required family matrix.

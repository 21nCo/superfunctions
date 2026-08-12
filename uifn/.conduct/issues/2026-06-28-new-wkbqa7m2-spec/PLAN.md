# Implementation Plan

## Architecture Sketch

```txt
uifn/examples/
  package.json
  shared/
    src/component-inventory.ts
    src/pattern-inventory.ts
    src/sf-inventory.ts
    src/qa-contract.ts
    src/routes.ts
    src/fixtures/
    src/reporting.ts
  react-workbench/
  svelte-workbench/
  vue-workbench/
  solid-workbench/
  angular-workbench/
  browser-qa/
    src/runner.ts
    src/assertions/
    src/specs/
    src/server.ts
scripts/
  verify-uifn-examples.mjs
  verify-uifn-browser.mjs
  verify-uifn-overlays.mjs
```

The shared package owns inventory, QA contracts, route generation, fixtures, fake clients, and report schemas. Framework apps own only framework-native rendering adapters. Browser QA drives real URLs and shared assertions.

## Dependency Graph

1. Registry inventory and QA contracts.
2. Shared routes, fixtures, and fake clients.
3. Framework Workbench app shells.
4. Component route renderers for all 45 components.
5. Pattern and SF panel route renderers.
6. Browser QA runner and assertions.
7. Visual, a11y, geometry, and interaction matrices.
8. Release gate integration and docs.

## Phases Overview

| Phase | Goal | Delivered Capability | Verification |
| --- | --- | --- | --- |
| 00 | Inventory and contract schema | Shared source of truth for all components, patterns, SF panels, routes, and QA profiles | schema tests and inventory drift check |
| 01 | Workbench package family | Five private framework apps and hub commands | workspace/build verification |
| 02 | Render all components | Every app renders every component route | route parity and smoke browser checks |
| 03 | Controls, forms, static, feedback, layout QA | Interactive QA for non-overlay components | Playwright control/form/static tests |
| 04 | Overlay and floating QA | Geometry/collision QA for overlay components | Playwright bounding-box and edge-case tests |
| 05 | Data-rich QA | Calendar, command, data-table, date-picker, resizable, scroll-area, sidebar behavior | Playwright data-rich tests |
| 06 | Patterns and SF panels | Controlled patterns and SF panels in every app | fake-client and state matrix tests |
| 07 | Visual, a11y, reporting, sharding | Full matrices and structured evidence | JSON schema, axe, screenshots |
| 08 | Docs and release gate | Workbench QA integrated into release | verify:uifn-release includes browser gates |

## Definition of Done

No phase is complete unless its verification steps pass. A phase MUST NOT be marked complete if any required component, framework, pattern, SF panel, route, state, assertion, or evidence field is missing.

## Global Verification Commands

```bash
npm run verify:uifn-examples
npm run verify:uifn-browser
npm run verify:uifn-overlays
npm run verify:uifn-workbench
node scripts/verify-uifn-release.mjs
git diff --check
```

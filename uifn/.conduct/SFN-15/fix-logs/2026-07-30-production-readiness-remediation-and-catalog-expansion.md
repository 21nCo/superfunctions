# Production-readiness remediation and catalog expansion

Date: 2026-07-30

## Scope

This run repaired the production-readiness defects identified in the current
uifn core, adapters, generated delivery artifacts, styled component packages,
API documentation, and catalogs. It also added Card, Table, Skeleton, Badge,
Breadcrumb, Command, InputGroup, and Textarea across React, Svelte, and Solid,
then exercised every public component route through the extension-backed Chrome
profile and the repository's automated cross-browser gates.

The resulting supported inventory is 69 primitives/components with 465 anatomy
parts across React, Svelte, and Solid. No unsupported Vue or Angular surface was
reintroduced.

## Core identity and ownership fixes

- Replaced deterministic per-primitive default IDs with a per-controller
  allocation path, so two default controller instances no longer emit duplicate
  DOM IDs.
- Kept explicit consumer IDs stable and deterministic.
- Removed focus management, outside-click, portal, positioning, and other
  browser-owned utilities from the `@uifn/core` public surface.
- Kept `@uifn/core` importable and executable in an ES2020 Node environment
  without browser globals.
- Consolidated DOM and platform behavior under `@uifn/dom`.
- Moved semantic default-content resolution into core part metadata instead of
  making framework adapters invent content.
- Reduced the adapter runtime to the six declared files and retained
  framework-specific rendering only at adapter boundaries.

## Public framework API fixes

- Removed the broad React hooks barrel from the package root.
- Exposed the supported `useMediaQuery` and `useCopyToClipboard` hooks through
  explicit subpaths only.
- Rebuilt React 18 and React 19 consumer coverage, Svelte consumer coverage,
  Solid consumer coverage, SSR, hydration, source-install, package-install,
  tree-shaking, and tarball checks.
- Corrected generated Solid property/event binding and strengthened the
  verifier so framework-invalid bindings cannot be accepted as parity.

## Component expansion

Added styled, precomposed, documented, and cataloged implementations for:

- Badge
- Breadcrumb
- Card
- Command
- InputGroup
- Skeleton
- Table
- Textarea

The components are present in all three supported framework packages, generated
exports, source-install templates, package-install tests, public documentation,
Storybook workbenches, and catalog routes.

Command now owns real query filtering, active-option movement, keyboard
selection, form serialization, empty/loading presentation, and focus behavior.
Table catalog examples now use valid native table structure with caption,
header, body, rows, cells, and footer instead of placing generic anatomy into
invalid table descendants. Card examples no longer synthesize invalid
`aria-labelledby` or `aria-describedby` relationships.

## Catalog API documentation

Replaced generic API prose with canonical source-derived contracts covering:

- complete event names, payloads, and signatures;
- primitive inputs, outputs, controlled and uncontrolled models;
- per-part properties and native element semantics;
- context and controller APIs;
- states and accurate defaults;
- data attributes and CSS variables;
- focus, keyboard, form, and DOM-service behavior;
- exceptions and documented limitations;
- framework package and owned-source examples.

The documentation gate now reports 69 primitives, 897 required sections,
13,127 mapped fields, 414 samples, and six package/source consumers with no
missing mappings.

## Styled delivery and presentation fixes

- Regenerated canonical catalog, public types, framework packages, owned-source
  templates, accessibility ledgers, registry data, and cross-framework traces
  from the same inventory.
- Replaced repeated generated API literals with a normalized seed plus
  deterministic runtime hydration. The public `STYLED_COMPONENT_CATALOG` shape
  and all API details remain intact, while its generated source fell from about
  1.30 MB to 396 KB.
- Aligned generated artifact provenance and verifier expectations so stale
  hard-coded trace roots cannot silently validate a different source state.
- Upgraded the public-types delivery generator to the current 16.3 contract and
  kept generated artifacts drift-checked.
- Kept registry delivery signed and verified after regeneration.
- Removed disabled-state opacity that made text contrast depend on blending.
- Corrected accent foreground fallbacks and part-specific accent contrast.
- Kept the public stylesheet copies byte-identical.
- Fixed collection workbench composition to render three distinct options and
  propagate values only for collection primitives.
- Narrowed that propagation after it exposed a Pagination ellipsis regression;
  Pagination retains three real page values and correct terminal bounds.
- Ensured Command empty, loading, and separator surfaces are not invalid
  descendants of its listbox.

The first fresh production catalog build correctly failed the unchanged payload
budget after the richer 69-component API metadata made every application bundle
carry repeated part-prop, ownership, data-attribute, CSS-variable, and
limitation strings. The generator normalization repaired the payload instead of
raising the gate:

- React: 1,488,216 decoded JS/CSS bytes; 273,242 Brotli-equivalent bytes;
  largest Brotli asset 54,741 bytes.
- Svelte: 1,094,216 decoded JS/CSS bytes; 181,821 Brotli-equivalent bytes;
  largest Brotli asset 114,117 bytes.
- Solid: 1,038,481 decoded JS/CSS bytes; 154,424 Brotli-equivalent bytes;
  largest Brotli asset 114,007 bytes.

All remain below the original 1,500,000 decoded-byte, 350,000
Brotli-equivalent-byte, and 120,000 single-asset limits.

## Accessibility and verifier improvements

- The complete Storybook gate visits 2,115 stories: 69 primitives, three
  frameworks, and the full generated variant/state matrix.
- The final run passes all 2,115 stories with zero serious or critical Axe
  findings and no contract failures.
- Reduced default Storybook browser concurrency to six because twelve workers
  intermittently exhausted iframe startup resources without representing a
  product failure.
- Made the Phase 17 aggregate result derive requirement status from child checks
  even when no aggregate evidence destination is supplied.
- Made Phase 18 rebuild the actual framework workbenches before browser checks.
- Made Phase 18 discover the newest complete six-trace Phase 14 input rather
  than using an obsolete hard-coded directory.
- Serialized WebKit browser execution after a four-page run reproduced a
  macOS WebContent deadlock; Chromium and Firefox retain wider parallelism.
- Made Phase 18 select the complete Phase 17 evidence set by required-artifact
  modification time instead of lexicographic directory naming. This prevents
  older compact timestamps from shadowing newer evidence directories.
- Reviewed every one of the 1,016 Axe incomplete results in the three-engine
  matrix instead of treating incompletes as implicit passes.
- The stable umbrella exposed a packaged Tabs focus regression that source-only
  controller assertions did not reveal: RTL ArrowLeft selected the correct tab
  but omitted keyboard input modality, so the DOM-owned roving-focus executor
  correctly declined to move focus. Tabs now emits keyboard metadata for the
  focus transition, a source regression test covers the contract, and the
  packaged browser vector passes in Chromium, Firefox, WebKit, mobile Chromium,
  and mobile WebKit.
- Added explicit ownership for the catalog snippet and performance release
  gates. Governance now passes 10/10 checks with 98 owned surfaces.

## Extension-backed Chrome validation

The extension-backed Chrome profile was used to inspect the delivered catalogs,
not a synthetic replacement DOM. The final sweep covered:

- 69 components;
- React, Svelte, and Solid;
- 276 component routes;
- 32 retained screenshots;
- light and dark presentation;
- responsive/catalog layout and component geometry;
- duplicate-ID inspection;
- Textarea and InputGroup input behavior;
- Tabs selection and visible-panel behavior;
- Command filtering, Arrow-key movement, Enter selection, and form value;
- Pagination terminal state and disabled next control;
- Dialog open state, focus entry, Escape dismissal, and trigger focus return.

Result: 276 routes passed with zero failures. The browser receipt and screenshots
are immutable under:

`uifn/.conduct/evidence/browser/2026-07-30-uifn-catalog-production-readiness/`

## Automated release evidence

- Phase 11 React compatibility: passed for React 18 and 19, all 69 components,
  all three browser engines, package/source delivery, and the complete pack.
- Phase 13 Solid compatibility: passed for Solid 1.9.13, all 69 components,
  Chromium/Firefox/WebKit, SSR, hydration, consumers, package/source delivery,
  tree-shaking, and complete pack.
- Phase 15 styling: passed for 69 primitives and 465 parts, including mutation
  coverage and clean consumers.
- Phase 16 registry: passed for 69 primitives, 465 parts, and 672 source
  templates with a valid signature.
- Phase 17 Storybook: 2,115/2,115 stories passed.
- Phase 17 documentation: 69 primitives, 897 sections, 13,127 mapped fields,
  414 samples, and six consumers passed.
- Phase 18 browser matrix: nine cells and 897/897 assertions passed across
  React/Svelte/Solid and Chromium/Firefox/WebKit, with zero failed assertions,
  zero serious/critical Axe findings, and 1,016/1,016 Axe incompletes reviewed.
- Phase 18 aggregate ledger: 1,806/1,806 requirements passed with zero defects.
- Phase 19 internal evidence contracts: 17/17 tests passed. The generated manual
  matrix is current at 69 primitives and 276 rows.
- Production catalog delivery: 207/207 framework snippets passed; 999 routes
  per framework and 2,997 statically addressable routes were staged; all three
  framework payload budgets passed.
- The complete stable umbrella passes, including package graph and hygiene,
  governance, catalog determinism, core/dom builds and tests, 171 core tests,
  44 DOM browser tests, React/Svelte/Solid typechecks, Node 20/22/24, runtime
  architecture, consumers, registry stable tests, and package dry-runs.

Primary evidence:

- `uifn/.conduct/evidence/phase-17/2026-07-30-production-readiness/`
- `uifn/.conduct/evidence/phase-18/2026-07-30-production-readiness-final/`
- `uifn/.conduct/evidence/phase-14/2026-07-30T21-38-00-000Z-PHASE-14-69-production-readiness/`

## Honest external certification boundaries

The implementation and repository-owned automation are green. Two gates cannot
be completed solely from this checkout and are not claimed as passed:

1. Phase 14 still requires the externally signed 35-cell Safari, iOS, Android,
   and render compatibility matrix. Its implementation checks pass and its
   aggregate status is `BLOCKED_EXTERNAL_MATRIX`.
2. Phase 19 requires qualified human VoiceOver, NVDA, JAWS, and TalkBack
   observations, an externally trust-root-signed participant registry, and a
   separately signed independent review. The signing and rejection machinery is
   tested, but no human evidence was fabricated.

These are release-certification dependencies, not unresolved implementation
defects in the repaired core, adapters, components, documentation, or catalogs.

## Deployment and source-control boundary

This run did not deploy, commit, push, or publish. It repaired and verified the
shared checkout and retained the evidence locally for review.

# Requirement Table Of Contents

- `REL-001` Public package identity and support-claim consistency
- `REL-002` Release artifact hygiene and declaration coverage
- `REL-003` Local release-gate command suite
- `CORE-001` Core semantic ownership
- `CORE-002` Deterministic IDs and shared utilities
- `CORE-003` Canonical runtime errors and observability rules
- `CORE-004` Cross-cutting accessibility contract
- `DISC-001` Disclosure and collection-family state semantics
- `FORM-001` Form-control semantics
- `DLG-001` Dialog and alert-dialog modal semantics
- `POP-001` Popover, tooltip, and hover-card semantics
- `MENU-001` Menu-family semantics
- `SEL-001` Select semantics
- `CMB-001` Combobox semantics
- `RANGE-001` Slider and progress semantics
- `SCROLL-001` Scroll-area semantics
- `SIMPLE-001` Display-helper public contract
- `REACT-001` React public API parity and polymorphism
- `REACT-002` React SSR/hydration and package verification
- `SVELTE-001` Svelte public typing and reactivity correctness
- `SVELTE-002` Svelte toolchain and pack correctness
- `DOCS-001` Docs, support matrix, and license parity
- `FILES-001` `@uifn/files` boundary definition
- `QA-001` Core, React, and Svelte automated coverage
- `QA-002` Accessibility and manual verification gate
- `COMPAT-001` Supported environment enforcement

## REL-001

- ID: `REL-001`
- Priority: `P0`
- Statement: The `uifn` package family MUST expose one canonical public surface centered on `@uifn/core`, `@uifn/react`, and `@uifn/svelte`, and MUST NOT advertise unsupported adapters or import paths.
- Rationale: Broken package identity and unsupported support claims are current release blockers.
- Acceptance criteria:
  - All README install commands, package names, and export-map examples reference the same canonical package names.
  - `@uifn/core/aria/*`, `@uifn/core/state/*`, `@uifn/core/utils/*`, and `@uifn/core/primitives/*` resolve in a fresh consumer smoke workspace.
  - Unsupported adapters such as Solid or web-components are absent from GA claims unless implemented and tested.
- Test vectors: `TV-REL-001`
- Notes: A deprecated `uifn` alias MAY exist only if documented as deprecated and covered by compatibility smoke tests.

## REL-002

- ID: `REL-002`
- Priority: `P0`
- Statement: Every public `uifn` package MUST ship clean tarball contents with declarations, README, consistent license metadata, and no leaked tests or internal-only files.
- Rationale: Missing declarations and leaked tests make public packages non-installable or misleading.
- Acceptance criteria:
  - `npm pack --dry-run` for each public package reports declaration files for every documented root entry point.
  - Tarballs exclude local tests, temporary fixtures, raw internal-only sources, and debug artifacts unless intentionally public.
  - README license text and package manifest license fields match.
- Test vectors: `TV-REL-002`
- Notes: Svelte source files MAY remain in the package only if intentionally part of the documented public API and accompanied by matching type output.

## REL-003

- ID: `REL-003`
- Priority: `P0`
- Statement: `uifn` MUST provide a deterministic local release-gate command suite that exercises build, lint, test, type, and pack verification for all public packages.
- Rationale: Production readiness requires one repeatable local gate rather than ad hoc package-by-package checks.
- Acceptance criteria:
  - The release-gate suite runs from the monorepo without manual file editing or workspace alias hacks.
  - The suite includes `core`, `react`, `svelte`, and any other still-public `uifn` packages.
  - The suite exits non-zero on build, lint, test, type, export-map, or pack failures.
- Test vectors: `TV-REL-003`
- Notes: The exact command name is implementation-defined, but it MUST be documented and stable.

## CORE-001

- ID: `CORE-001`
- Priority: `P0`
- Statement: `@uifn/core` MUST own the authoritative state and interaction semantics for every GA primitive family, and adapters MUST only bind framework events/rendering to that shared behavior.
- Rationale: Fragmented adapter-specific semantics are the main cause of spec drift and inconsistent behavior.
- Acceptance criteria:
  - All GA primitive families have a documented core factory or explicit adapter-only exemption.
  - Keyboard navigation, controlled/uncontrolled rules, and dismissal semantics are implemented once in core for shared families.
  - React and Svelte adapter tests assert the same cross-framework golden behaviors for the same families.
- Test vectors: `TV-CORE-001`
- Notes: Adapter-only helpers such as `Badge` are allowed only when explicitly documented as adapter-level surfaces.

## CORE-002

- ID: `CORE-002`
- Priority: `P0`
- Statement: `@uifn/core` MUST provide deterministic IDs, roving focus, focus trap, outside-click, presence, portal, and positioning utilities through stable public exports.
- Rationale: Current missing or unstable utility exports directly break adapters and hydration safety.
- Acceptance criteria:
  - No GA utility uses uncontrolled randomness for public IDs.
  - Public imports for `aria`, `state`, and `utils` resolve from clean consumer installs.
  - Shared utilities are reused by React and Svelte instead of duplicated with divergent semantics.
- Test vectors: `TV-CORE-002`
- Notes: Utility internals MAY differ by environment, but public contracts and deterministic outcomes MUST remain stable.

## CORE-003

- ID: `CORE-003`
- Priority: `P0`
- Statement: `uifn` runtime and build failures MUST use canonical `UIFnError` codes and MUST NOT emit ad hoc production console logging.
- Rationale: Consumers need predictable failure modes, and debug output in production libraries is unacceptable.
- Acceptance criteria:
  - Missing context/provider usage throws a typed `UIFnError`.
  - Disabled interactions no-op without throwing.
  - Production bundles contain no unconditional `console.log` or equivalent debug traces.
- Test vectors: `TV-CORE-003`
- Notes: Development warnings MAY exist, but they MUST be environment-gated and documented.

## CORE-004

- ID: `CORE-004`
- Priority: `P0`
- Statement: Every GA primitive family MUST satisfy the cross-cutting accessibility contract for ARIA, keyboard input, focus management, and reduced-motion behavior.
- Rationale: Accessibility is an explicit core principle and cannot be adapter-specific best effort.
- Acceptance criteria:
  - Each GA family documents its role/ARIA expectations and keyboard contract.
  - Reduced-motion preference does not change correctness or cleanup behavior.
  - Focus return/trap/roving rules are verifiable by automated and manual tests for applicable families.
- Test vectors: `TV-CORE-004`
- Notes: This requirement defines the baseline; family-specific requirements refine it.

## DISC-001

- ID: `DISC-001`
- Priority: `P0`
- Statement: `Accordion`, `Collapsible`, `Tabs`, and `ToggleGroup` MUST implement deterministic controlled/uncontrolled state, orientation semantics, and keyboard navigation via shared collection logic.
- Rationale: These families are currently partially implemented with adapter drift and broken keyboard verification.
- Acceptance criteria:
  - `Accordion` supports single/multiple modes and collapsibility without state drift.
  - `Tabs` supports manual/automatic activation and horizontal/vertical navigation.
  - `ToggleGroup` honors single/multiple selection semantics and disabled items.
  - React and Svelte adapters render consistent state/data attributes for the same scenarios.
- Test vectors: `TV-DISC-001`
- Notes: Invalid external values MUST be handled deterministically, not by arbitrary fallback selection.

## FORM-001

- ID: `FORM-001`
- Priority: `P0`
- Statement: `Checkbox`, `Switch`, `Toggle`, and `RadioGroup` MUST implement correct ARIA, keyboard behavior, hidden input serialization, and disabled/required semantics.
- Rationale: These are the highest-frequency form controls and must be reliable across frameworks.
- Acceptance criteria:
  - Checkbox supports `checked`, `unchecked`, and `indeterminate` states with correct ARIA.
  - Switch and Toggle expose correct pressed/checked state and keyboard handling.
  - RadioGroup enforces single selection and roving focus without silent drift.
  - Hidden form inputs serialize only intended values when form participation is enabled.
- Test vectors: `TV-FORM-001`
- Notes: Enter-key behavior MUST follow the semantic role rather than current ad hoc button behavior.

## DLG-001

- ID: `DLG-001`
- Priority: `P0`
- Statement: `Dialog` and `AlertDialog` MUST implement modal semantics, focus trap/return, escape handling, outside-interaction policy, and scroll lock through shared core behavior.
- Rationale: Modal correctness is a top-tier accessibility and UX requirement.
- Acceptance criteria:
  - Opening a dialog moves focus into content and closing returns focus appropriately.
  - Escape and outside-click behavior follow family-specific policy and emit stable semantic reasons.
  - Body scroll locking is applied only when required and always cleaned up.
  - React and Svelte adapters pass the same modal behavior vectors.
- Test vectors: `TV-DLG-001`
- Notes: `AlertDialog` MAY disallow outside click entirely; the chosen policy MUST be documented and tested.

## POP-001

- ID: `POP-001`
- Priority: `P1`
- Statement: `Popover`, `Tooltip`, and `HoverCard` MUST implement shared collision-aware positioning, delay semantics, dismissal, and reduced-motion-safe cleanup.
- Rationale: Popup-family correctness currently depends on partially duplicated adapter code.
- Acceptance criteria:
  - Popup position updates are derived from a shared positioning utility.
  - Tooltip and HoverCard delay/open/close semantics are deterministic and testable.
  - Popover dismissal honors escape and outside-click rules without leaking listeners or timers.
- Test vectors: `TV-POP-001`
- Notes: Pointer hoverability MAY vary by family, but documented rules MUST be consistent across adapters.

## MENU-001

- ID: `MENU-001`
- Priority: `P0`
- Statement: `DropdownMenu`, `ContextMenu`, `MenuBar`, and `Toolbar` MUST implement deterministic navigation, submenu/group behavior, disabled-item handling, and collision-safe positioning.
- Rationale: Menu families currently underdeliver on spec-promised submenu and navigation behavior.
- Acceptance criteria:
  - Menu items navigate correctly with arrow keys, Home/End, and escape semantics.
  - Nested submenus open and close predictably and restore focus correctly.
  - Context menu placement respects invocation coordinates and viewport boundaries.
  - Toolbar orientation and grouping semantics are documented and tested.
- Test vectors: `TV-MENU-001`
- Notes: If `MenuBar` remains public, it is GA-scoped and MUST not remain an undocumented extra.

## SEL-001

- ID: `SEL-001`
- Priority: `P0`
- Statement: `Select` MUST implement grouped option rendering, deterministic open/value control, keyboard navigation, typeahead, and form integration.
- Rationale: Current select behavior is too thin in core relative to the published contract.
- Acceptance criteria:
  - `Select` supports controlled and uncontrolled `value` and `open` props without drift.
  - Group labels, separators, and selected item indicators behave consistently in React and Svelte.
  - Keyboard and typeahead navigation produce predictable highlighted and selected item states.
  - Hidden input serialization is correct when `name` is supplied.
- Test vectors: `TV-SEL-001`
- Notes: The contract MAY use `aria-activedescendant` or roving tabIndex, but the choice MUST be consistent and documented.

## CMB-001

- ID: `CMB-001`
- Priority: `P0`
- Statement: `Combobox` MUST implement filtering, highlight state, selection, empty state, controlled `inputValue`/`value`/`open`, and optional virtualization for large collections.
- Rationale: Combobox is currently the most underimplemented core primitive relative to the published spec.
- Acceptance criteria:
  - Filtering logic is applied through a documented contract and does not silently ignore supplied filters.
  - Highlight state is explicit and keyboard-driven.
  - Single selection is mandatory for GA; multiple selection MAY be supported only if fully specified and tested.
  - Large-list support is documented and verified through virtualization integration where enabled.
- Test vectors: `TV-CMB-001`
- Notes: If multiple selection is not shipped in this bundle, public docs/spec MUST stop claiming it.

## RANGE-001

- ID: `RANGE-001`
- Priority: `P1`
- Statement: `Slider` and `Progress` MUST implement the full published range/value contract, including multi-thumb slider semantics, clamping, step alignment, and indeterminate progress.
- Rationale: Current range/status behavior is only partially aligned with the published contract.
- Acceptance criteria:
  - Slider supports one or more thumbs with deterministic ordering and clamping.
  - Keyboard interactions respect orientation, Home/End, step, and bounds.
  - Progress supports determinate and indeterminate states with correct ARIA.
- Test vectors: `TV-RANGE-001`
- Notes: Slider pointer/touch math MAY differ internally by adapter, but externally observable value semantics MUST match.

## SCROLL-001

- ID: `SCROLL-001`
- Priority: `P1`
- Statement: `ScrollArea` MUST synchronize viewport, scrollbar, thumb, and corner state with no broken feedback loops or stale geometry.
- Rationale: The current core implementation is only a placeholder and does not satisfy the published feature set.
- Acceptance criteria:
  - Horizontal and vertical scrollbars track viewport position deterministically.
  - Thumb drag updates viewport scroll and vice versa.
  - Corner visibility is correct when both axes overflow.
- Test vectors: `TV-SCROLL-001`
- Notes: Native scrolling MAY remain the motion substrate, but custom state synchronization MUST be correct.

## SIMPLE-001

- ID: `SIMPLE-001`
- Priority: `P1`
- Statement: `Label`, `Separator`, `Avatar`, `Badge`, and `VirtualizedList` MUST each have a truthful documented public contract, deterministic behavior, and release-gate coverage if they remain public.
- Rationale: Several public surfaces are currently outside the formal spec or lack clear GA status.
- Acceptance criteria:
  - Each of these surfaces is either documented as GA or explicitly labeled non-GA.
  - `Avatar` fallback timing and image error behavior are deterministic.
  - `VirtualizedList` documents adapter-only status, overscan behavior, and expected item rendering contract.
- Test vectors: `TV-SIMPLE-001`
- Notes: `Badge` MAY remain stylistically neutral, but its presence as a public component still requires truth in docs and tests.

## REACT-001

- ID: `REACT-001`
- Priority: `P0`
- Statement: `@uifn/react` MUST expose a complete, typed, ref-safe public API matching the documented component catalog and MUST support `asChild` for polymorphic host components where claimed.
- Rationale: React is a requested GA adapter and currently has incomplete polymorphism and import stability.
- Acceptance criteria:
  - All documented React exports resolve with types in a clean consumer workspace.
  - Host-rendering primitives that claim polymorphism accept `asChild` and preserve behavior.
  - Refs point to the correct interactive or focus-target DOM node.
- Test vectors: `TV-REACT-001`
- Notes: If any component is intentionally non-polymorphic, docs MUST state that explicitly.

## REACT-002

- ID: `REACT-002`
- Priority: `P0`
- Statement: `@uifn/react` MUST be SSR-safe, hydration-safe, and green on build, test, lint, accessibility smoke, and pack verification.
- Rationale: React’s current broken tests and unstable imports block GA readiness.
- Acceptance criteria:
  - Package-local tests pass without workspace-only import hacks.
  - SSR render + hydrate smoke tests complete without ID or effect-order mismatches.
  - `npm pack --dry-run` reports a clean artifact with types.
  - Accessibility smoke tests execute rather than being skipped or broken.
- Test vectors: `TV-REACT-002`
- Notes: No GA release is allowed while any React a11y or import-path smoke test is broken or skipped without explicit justification.

## SVELTE-001

- ID: `SVELTE-001`
- Priority: `P0`
- Statement: `@uifn/svelte` MUST expose typed public components with correct controlled/uncontrolled reactivity and MUST build without `state_referenced_locally` warnings in GA surfaces.
- Rationale: Svelte currently snapshots props in ways that break controlled semantics and emits widespread reactivity warnings.
- Acceptance criteria:
  - Controlled prop changes after mount are reflected in rendered state and callbacks.
  - Public declarations exist for the root entry point and any documented subpaths.
  - No GA component emits `state_referenced_locally` build warnings.
- Test vectors: `TV-SVELTE-001`
- Notes: A component MAY keep internal derived state, but it MUST re-derive from controlled props when applicable.

## SVELTE-002

- ID: `SVELTE-002`
- Priority: `P0`
- Statement: `@uifn/svelte` MUST use a supported Vite/Svelte/Vitest toolchain matrix and MUST pass build, test, lint, and pack verification without leaking tests as release artifacts.
- Rationale: Svelte currently fails before tests start and packs raw source/tests without type output.
- Acceptance criteria:
  - `npm test -- --run` starts and passes in the package workspace.
  - `npm run build` emits the declared types and the documented runtime entries.
  - `npm pack --dry-run` excludes tests unless they are intentionally public and documented.
- Test vectors: `TV-SVELTE-002`
- Notes: Shipping raw `.svelte` sources is allowed only if it is a deliberate part of the support strategy and types remain complete.

## DOCS-001

- ID: `DOCS-001`
- Priority: `P0`
- Statement: `uifn` root docs, package READMEs, support matrix, examples, and license metadata MUST agree on package names, GA status, adapter support, component catalog, and installation instructions.
- Rationale: Current docs and manifests contradict one another in ways that break consumer trust.
- Acceptance criteria:
  - Vue docs no longer describe non-existent composable APIs unless those APIs are actually shipped.
  - README component lists match exported public surfaces.
  - License text is consistent across package manifests and READMEs.
  - Unsupported adapters/components are removed from claims or labeled experimental.
- Test vectors: `TV-DOCS-001`
- Notes: Documentation truthfulness is release-blocking even when runtime code is otherwise functional.

## FILES-001

- ID: `FILES-001`
- Priority: `P1`
- Statement: `@uifn/files` MUST either be documented, typed, pack-clean, and support-matrix-labeled as part of `uifn`, or be moved out of the `uifn` product boundary before release.
- Rationale: The package is currently public but unspecced and leaks compiled tests into its tarball.
- Acceptance criteria:
  - A documented decision exists: keep in-scope or move out.
  - If kept, the package has README/support-matrix coverage and a clean tarball.
  - If moved out, `uifn` docs/spec no longer claim it.
- Test vectors: `TV-FILES-001`
- Notes: This requirement is about product-boundary truthfulness, not about adding new file-upload features.

## QA-001

- ID: `QA-001`
- Priority: `P0`
- Statement: Every GA primitive family MUST have deterministic automated coverage in `@uifn/core`, `@uifn/react`, and `@uifn/svelte` appropriate to the behavior owned at each layer.
- Rationale: Current coverage is sparse, broken, or missing in the exact places the audit found drift.
- Acceptance criteria:
  - Core has unit tests for shared state and semantics.
  - React and Svelte each have integration tests for every GA family they expose.
  - Golden keyboard/selection/dismissal vectors are shared across adapters where behavior is expected to match.
- Test vectors: `TV-QA-001`
- Notes: Adapter-only helpers MAY have lighter coverage, but if they are GA they still require at least one positive and one negative automated test.

## QA-002

- ID: `QA-002`
- Priority: `P0`
- Statement: A release candidate MUST pass automated accessibility checks plus documented manual keyboard and screen-reader verification for representative GA primitive families.
- Rationale: Automated tests alone are insufficient for headless UI accessibility claims.
- Acceptance criteria:
  - Automated a11y smoke tests execute for representative popup, form, collection, and menu families.
  - Manual keyboard-only verification is documented for each representative family.
  - Manual screen-reader verification is documented for at least dialog/alert, select/combobox, and toast/status families.
- Test vectors: `TV-QA-002`
- Notes: Manual verification records MAY live in phase reports or release notes, but they MUST exist before GA release.

## COMPAT-001

- ID: `COMPAT-001`
- Priority: `P0`
- Statement: `uifn` MUST explicitly enforce and document its supported Node, browser, framework, and peer dependency ranges, and MUST fail verification when the toolchain matrix is invalid.
- Rationale: Current Svelte toolchain incompatibility demonstrates that implied support is not enough.
- Acceptance criteria:
  - Package manifests and docs match the supported environment matrix in `SPEC.md`.
  - Invalid dependency graphs fail local verification with a clear error.
  - React and Svelte smoke installs succeed on the supported matrix.
- Test vectors: `TV-COMPAT-001`
- Notes: Experimental packages MAY advertise narrower support ranges, but they MUST do so truthfully.

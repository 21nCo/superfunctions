# Requirement Table Of Contents

- `REL-001` Canonical package identity and public-surface truth
- `REL-002` Pack hygiene and declaration completeness
- `REL-003` Release gate, release manifest, and consumer smoke verification
- `CORE-001` Core ownership of shared GA semantics
- `CORE-002` Deterministic and collision-free public IDs
- `CORE-003` Canonical runtime error envelope
- `CORE-004` Accessibility and reduced-motion baseline
- `DISC-001` Disclosure and collection semantics
- `FORM-001` Form-control semantics
- `DLG-001` Modal dialog and alert-dialog semantics
- `POP-001` Popup positioning and cleanup semantics
- `MENU-001` Menu-family navigation semantics
- `SEL-001` Select semantics
- `CMB-001` Combobox semantics
- `RANGE-001` Slider and progress semantics
- `SCROLL-001` Scroll-area synchronization semantics
- `SIMPLE-001` Display-helper and virtualization contract
- `REACT-001` React adapter API parity and core binding
- `REACT-002` React SSR, hydration, and multi-instance safety
- `SVELTE-001` Svelte deterministic IDs and controlled reactivity
- `SVELTE-002` Svelte warning-free build and modal/keyboard parity
- `DOCS-001` Root and package documentation truthfulness
- `FILES-001` Files package boundary truthfulness
- `QA-001` Automated coverage matrix closure
- `QA-002` Manual accessibility evidence closure
- `COMPAT-001` Supported environment enforcement

## REL-001

- ID: `REL-001`
- Priority: `P0`
- Statement: The `uifn` package family MUST expose one canonical public surface centered on `@uifn/core`, `@uifn/react`, and `@uifn/svelte`, and MUST NOT advertise unsupported packages, adapters, or symbols.
- Rationale: Release readiness fails if consumers cannot trust package names, status labels, and exported symbols.
- Acceptance criteria:
  - Root docs, package READMEs, manifests, and export maps reference the same canonical package names and status labels.
  - Symbols not actually exported are absent from public claims.
  - Vue and files remain explicitly Experimental in all public docs unless intentionally promoted.
- Test vectors: `TV-REL-001`
- Notes: This requirement includes legacy-root-spec cleanup, not only README cleanup.

## REL-002

- ID: `REL-002`
- Priority: `P0`
- Statement: Every public `uifn` package MUST ship clean tarball contents with declarations, README, and no leaked tests or internal-only artifacts.
- Rationale: Pack output is part of the shipped product boundary.
- Acceptance criteria:
  - `npm pack --dry-run` for every public package contains declared entry points and type files.
  - Tarballs exclude tests, fixtures, and local build artifacts unless intentionally public and documented.
  - README license text and manifest license fields agree.
- Test vectors: `TV-REL-002`
- Notes: Svelte source files MAY remain public only if they are intentional entry-point artifacts.

## REL-003

- ID: `REL-003`
- Priority: `P0`
- Statement: `uifn` MUST provide a deterministic local release gate that validates build, lint, test, typecheck, export maps, pack output, and consumer smoke verification for all public packages.
- Rationale: The current gate passes while missing real release blockers.
- Acceptance criteria:
  - The gate runs from the monorepo root without manual edits.
  - The gate emits a machine-readable release manifest.
  - GA packages fail the gate when consumer smoke, warning policy, or evidence policy is broken.
- Test vectors: `TV-REL-003`
- Notes: Experimental packages MAY stay in the gate, but React and Svelte are release-blocking.

## CORE-001

- ID: `CORE-001`
- Priority: `P0`
- Statement: `@uifn/core` MUST own the authoritative state and interaction semantics for every shared GA primitive family, and adapters MUST bind to those semantics instead of redefining them.
- Rationale: Adapter-local behavior drift is the main source of production inconsistency.
- Acceptance criteria:
  - Every shared GA family has a documented core-owned semantic source.
  - Adapter behavior for keyboard, controlled/uncontrolled state, and dismissal matches the core contract.
  - Adapter-only helpers are explicitly documented as adapter-only.
- Test vectors: `TV-CORE-001`
- Notes: Pure presentation helpers do not need a core factory if their contract stays adapter-owned.

## CORE-002

- ID: `CORE-002`
- Priority: `P0`
- Statement: All GA `uifn` surfaces MUST use deterministic, collision-free public IDs and ARIA relationships across SSR, hydration, and multi-instance rendering.
- Rationale: The current audit found both random IDs and fixed shared IDs in public GA paths.
- Acceptance criteria:
  - No GA component uses `Math.random()` for public IDs.
  - No instance-scoped GA surface uses fixed public IDs such as `dialog-content` or `select-content`.
  - Multi-instance tests verify unique public IDs and intact ARIA relationships.
- Test vectors: `TV-CORE-002`
- Notes: Instance-stable IDs MAY derive from framework-safe hooks plus core utilities.

## CORE-003

- ID: `CORE-003`
- Priority: `P0`
- Statement: GA runtime misuse and invariant failures MUST throw canonical `UIFnError` payloads, and production bundles MUST NOT emit ad hoc debug logging.
- Rationale: Consumers need stable failure modes and production-safe runtime behavior.
- Acceptance criteria:
  - Missing provider/context usage throws `UIFnError` with `UIFN_ERR_CONTEXT_MISSING`.
  - Invalid public values throw `UIFnError` with stable codes.
  - Production builds contain no unconditional debug logging.
- Test vectors: `TV-CORE-003`
- Notes: Disabled user input remains a no-op, not a thrown error.

## CORE-004

- ID: `CORE-004`
- Priority: `P0`
- Statement: Every GA primitive family MUST satisfy the cross-cutting accessibility contract for roles, keyboard input, focus management, and reduced-motion-safe cleanup.
- Rationale: Accessibility claims are part of the public product contract.
- Acceptance criteria:
  - Representative popup, collection, and form families pass automated accessibility smoke.
  - Keyboard contracts are explicitly covered by tests for applicable families.
  - Reduced-motion handling does not change correctness or cleanup behavior.
- Test vectors: `TV-CORE-004`
- Notes: Family-specific requirements refine this baseline.

## DISC-001

- ID: `DISC-001`
- Priority: `P0`
- Statement: `Accordion`, `Tabs`, `ToggleGroup`, `Toolbar`, and `MenuBar` MUST implement deterministic controlled/uncontrolled state, orientation, and keyboard navigation semantics.
- Rationale: The current Svelte Tabs implementation does not meet the published contract.
- Acceptance criteria:
  - `Tabs` supports Arrow/Home/End navigation and manual/automatic activation.
  - `Accordion` and `ToggleGroup` remain deterministic for controlled and uncontrolled values.
  - MenuBar/Toolbar roving-focus behavior follows documented orientation rules.
- Test vectors: `TV-DISC-001`
- Notes: Invalid external values MUST not silently select arbitrary fallbacks.

## FORM-001

- ID: `FORM-001`
- Priority: `P0`
- Statement: `Checkbox`, `Switch`, `Toggle`, and `RadioGroup` MUST expose correct ARIA, hidden-input serialization, and disabled/required semantics across adapters.
- Rationale: These controls are frequent, user-facing state inputs.
- Acceptance criteria:
  - Checkbox supports checked, unchecked, and indeterminate states.
  - Switch and Toggle expose stable pressed/checked state.
  - RadioGroup enforces single selection and correct hidden input serialization.
- Test vectors: `TV-FORM-001`
- Notes: Native-role semantics take precedence over ad hoc keyboard behavior.

## DLG-001

- ID: `DLG-001`
- Priority: `P0`
- Statement: `Dialog` and `AlertDialog` MUST implement modal semantics including focus trap, focus return, body-scroll lock, escape handling, and family-specific outside-interaction policy.
- Rationale: The audit found Svelte modal behavior still incomplete.
- Acceptance criteria:
  - Opening a modal moves focus into content and closing returns focus appropriately.
  - Body-scroll lock is applied only while modal content is open and is always cleaned up.
  - `AlertDialog` outside interaction remains disallowed unless the contract changes everywhere together.
- Test vectors: `TV-DLG-001`
- Notes: Close reasons MUST remain deterministic.

## POP-001

- ID: `POP-001`
- Priority: `P1`
- Statement: `Popover`, `Tooltip`, and `HoverCard` MUST implement shared collision-aware positioning, delay semantics, and listener/timer cleanup.
- Rationale: Popup-family correctness still depends on fragmented adapter code.
- Acceptance criteria:
  - Positioning derives from shared utilities.
  - Delay and dismissal behavior is deterministic and covered by tests.
  - Cleanup leaves no stale timers or listeners.
- Test vectors: `TV-POP-001`
- Notes: Reduced-motion-safe cleanup is part of this contract.

## MENU-001

- ID: `MENU-001`
- Priority: `P0`
- Statement: `DropdownMenu`, `ContextMenu`, and `MenuBar` MUST implement deterministic keyboard navigation, submenu handling, disabled-item behavior, and viewport-safe positioning.
- Rationale: Public menu claims are broader than the currently proven behavior.
- Acceptance criteria:
  - Arrow/Home/End/Escape behavior is stable across menu families.
  - Nested submenu flows are covered through at least three levels.
  - Disabled items are skipped and never activated.
- Test vectors: `TV-MENU-001`
- Notes: Public claims MUST match whatever submenu surface actually ships.

## SEL-001

- ID: `SEL-001`
- Priority: `P0`
- Statement: `Select` MUST implement deterministic open/value control, grouped options, keyboard navigation, typeahead, form integration, and unique ARIA relationships.
- Rationale: Fixed IDs currently weaken multi-instance correctness.
- Acceptance criteria:
  - Controlled and uncontrolled `open` and `value` work without drift.
  - Group labels, separators, and item indicators behave consistently.
  - Multi-instance renders do not share IDs or ARIA targets.
- Test vectors: `TV-SEL-001`
- Notes: The implementation MAY use roving tabIndex or `aria-activedescendant`, but the chosen pattern MUST be consistent.

## CMB-001

- ID: `CMB-001`
- Priority: `P0`
- Statement: `Combobox` MUST implement deterministic filtering, highlight state, selection, empty-result handling, controlled `value`/`inputValue`/`open`, and unique ARIA relationships.
- Rationale: The root spec still overclaims multiple-selection and extra parts not currently shipped.
- Acceptance criteria:
  - Filtering uses a documented contract and does not ignore supplied input.
  - Highlight and selection remain constrained to the filtered result set.
  - Multiple-selection claims are removed unless fully shipped and tested.
- Test vectors: `TV-CMB-001`
- Notes: GA scope is single-selection only in this bundle.

## RANGE-001

- ID: `RANGE-001`
- Priority: `P1`
- Statement: `Slider` and `Progress` MUST implement the published range/value contract, including multi-thumb ordering, clamping, step alignment, and indeterminate progress.
- Rationale: Current coverage proves basics but not the full contract.
- Acceptance criteria:
  - Slider values clamp to min/max and preserve thumb ordering.
  - Keyboard behavior respects orientation, step, Home, and End.
  - Progress supports determinate and indeterminate ARIA semantics.
- Test vectors: `TV-RANGE-001`
- Notes: Pointer math MAY differ internally by adapter.

## SCROLL-001

- ID: `SCROLL-001`
- Priority: `P1`
- Statement: `ScrollArea` MUST synchronize viewport, scrollbar, thumb, and corner state without stale geometry or feedback loops.
- Rationale: Basic tests exist, but the full published behavior still lacks strong evidence.
- Acceptance criteria:
  - Viewport scroll and thumb position stay synchronized.
  - Both axes and corner visibility behave deterministically.
  - Drag and programmatic scroll paths stay consistent.
- Test vectors: `TV-SCROLL-001`
- Notes: Native scrolling MAY remain the movement substrate.

## SIMPLE-001

- ID: `SIMPLE-001`
- Priority: `P1`
- Statement: `Avatar`, `Badge`, `Label`, `Separator`, and `VirtualizedList` MUST keep a truthful, deterministic, and performance-bounded public contract.
- Rationale: These surfaces are public and therefore require the same truthfulness discipline as more complex primitives.
- Acceptance criteria:
  - `AvatarFallback` timing is deterministic.
  - `VirtualizedList` default overscan remains `3` and scale behavior is explicitly tested.
  - Public docs accurately label adapter-only helpers and Experimental/GA status.
- Test vectors: `TV-SIMPLE-001`
- Notes: `Badge` and `Label` remain stylistically neutral surfaces.

## REACT-001

- ID: `REACT-001`
- Priority: `P0`
- Statement: `@uifn/react` MUST expose a complete typed public API that binds to core-owned semantics and preserves documented polymorphism/ref behavior.
- Rationale: React is close to GA but still duplicates core logic and plain-error handling.
- Acceptance criteria:
  - Public React exports resolve with types in a clean consumer workspace.
  - Documented `asChild` surfaces preserve behavior and ref targets.
  - React family semantics do not diverge from core-owned behavior.
- Test vectors: `TV-REACT-001`
- Notes: Components not intended to be polymorphic MUST not claim `asChild`.

## REACT-002

- ID: `REACT-002`
- Priority: `P0`
- Statement: `@uifn/react` MUST be safe for SSR, hydration, and multi-instance rendering and MUST remain green on build, lint, test, typecheck, and pack verification.
- Rationale: Fixed instance IDs still threaten correctness even though the package-local gate is green.
- Acceptance criteria:
  - SSR render and hydrate complete without mismatch warnings.
  - Multiple simultaneous popup/select instances expose unique IDs.
  - Package-local verification and consumer smoke both pass.
- Test vectors: `TV-REACT-002`
- Notes: This requirement covers React-specific deterministic-ID regressions.

## SVELTE-001

- ID: `SVELTE-001`
- Priority: `P0`
- Statement: `@uifn/svelte` MUST use deterministic public IDs and MUST react correctly to controlled prop changes after mount.
- Rationale: The current audit found random IDs and incomplete controlled behavior in GA Svelte surfaces.
- Acceptance criteria:
  - GA Svelte surfaces contain no `Math.random()`-based public IDs.
  - Controlled prop updates after mount are reflected in rendered state and callbacks.
  - Multi-instance Svelte renders maintain unique ARIA relationships.
- Test vectors: `TV-SVELTE-001`
- Notes: This requirement is release-blocking.

## SVELTE-002

- ID: `SVELTE-002`
- Priority: `P0`
- Statement: `@uifn/svelte` MUST build without suppressed GA compiler warnings and MUST satisfy modal, keyboard, and cleanup semantics equivalent to the shared contract.
- Rationale: The current build passes only by filtering warnings, and Svelte modal behavior is incomplete.
- Acceptance criteria:
  - The Svelte build completes with no warning suppression for GA surfaces.
  - Dialog/AlertDialog implement scroll lock and close semantics correctly.
  - Tabs and other collection families satisfy the documented keyboard contract.
- Test vectors: `TV-SVELTE-002`
- Notes: Warning suppression in the GA path is a release blocker, not a cosmetic issue.

## DOCS-001

- ID: `DOCS-001`
- Priority: `P0`
- Statement: `uifn` root docs, package READMEs, support matrix, examples, and root `uifn/.conduct/SPEC.md` MUST agree on package names, GA status, exported symbols, and verification obligations.
- Rationale: The current root spec still overclaims public API that is not shipped.
- Acceptance criteria:
  - Root `uifn/.conduct/SPEC.md` no longer claims unexported families or parts.
  - Package READMEs match actual package exports and status.
  - Manual accessibility requirements in docs align with the real release-evidence policy.
- Test vectors: `TV-DOCS-001`
- Notes: Documentation truthfulness is release-blocking.

## FILES-001

- ID: `FILES-001`
- Priority: `P1`
- Statement: `@uifn/files` MUST remain explicitly documented as Experimental with a narrow typed helper surface, or it MUST be removed from `uifn` public claims.
- Rationale: The files package is public and therefore still part of product-boundary truthfulness.
- Acceptance criteria:
  - The files package remains documented in the support matrix as Experimental.
  - Its README matches the shipped helper API.
  - Its tarball stays clean and typed.
- Test vectors: `TV-FILES-001`
- Notes: This requirement is about truthful boundary management, not new file-upload features.

## QA-001

- ID: `QA-001`
- Priority: `P0`
- Statement: Every GA family MUST have layer-appropriate automated coverage in core, React, and Svelte, including regressions for the failures identified in the `2026-03-25` audit.
- Rationale: The current suite is broad but still misses critical deterministic-ID and modal regressions.
- Acceptance criteria:
  - Core has tests for shared semantic ownership.
  - React and Svelte each have regression coverage for duplicate-instance IDs, controlled reactivity, and family-specific blockers.
  - Scale and submenu-depth claims are backed by automated tests.
- Test vectors: `TV-QA-001`
- Notes: Adapter-only helpers still require direct automated coverage if public.

## QA-002

- ID: `QA-002`
- Priority: `P0`
- Statement: A GA release candidate MUST include real manual keyboard and screen-reader verification evidence for representative React and Svelte families.
- Rationale: The current “manual” evidence is a jsdom artifact and does not satisfy the product claim.
- Acceptance criteria:
  - Evidence records identify verifier, browser, OS, assistive technology, and family results.
  - Evidence covers Dialog/AlertDialog, Select/Combobox, Toast/Status, and a collection family.
  - jsdom or static ARIA review alone does not satisfy this requirement.
- Test vectors: `TV-QA-002`
- Notes: This requirement is release-blocking.

## COMPAT-001

- ID: `COMPAT-001`
- Priority: `P0`
- Statement: `uifn` MUST explicitly enforce the supported Node, framework, browser, and peer-dependency ranges and MUST fail verification when the declared matrix is not what the packages actually support.
- Rationale: A passing build is insufficient if the declared support matrix is wrong.
- Acceptance criteria:
  - Manifests, peer ranges, root docs, and package READMEs agree on the supported matrix.
  - Consumer smoke verification resolves documented imports for GA packages.
  - Invalid toolchain or peer dependency combinations fail the local gate with a clear error.
- Test vectors: `TV-COMPAT-001`
- Notes: Experimental packages MAY advertise narrower support, but MUST do so truthfully.

# Metadata

- Timestamp: `2026-03-25T06:20:11Z`
- Agent name: `spec`
- Model: `unknown`
- Launcher: `Codex Desktop`
- Workspace/project absolute path: `/Users/serro/Documents/dev/n/superfunctions/uifn`
- OS + shell: `Darwin ArBook.local 25.3.0 arm64`, shell `/bin/zsh`
- Repo metadata: git repo detected at `/Users/serro/Documents/dev/n/superfunctions`; branch `next`; commit `b69090aaa83f0515924aa9b11df3b1fcd4de3a1a`; dirty worktree `yes`
- Spec folder name: `2026-03-25-audit-fix-zl6gfhpb-spec`
- Spec folder path: `/Users/serro/Documents/dev/n/superfunctions/uifn/.conduct/specs/2026-03-25-audit-fix-zl6gfhpb-spec`
- Spec type: `audit-fix`
- Spec id: `zl6gfhpb`
- Input paths read:
  - `/Users/serro/.codex/skills/spec/SKILL.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/README.md`
  - `uifn/.conduct/SPEC.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/core/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/react/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/svelte/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/vue/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/files/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/.conduct/audits/2026-03-25-ptnwmntx-full-audit.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/.conduct/specs/2026-03-20-audit-fix-dhrtycgi-spec/SPEC.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/.conduct/specs/2026-03-20-audit-fix-dhrtycgi-spec/REQUIREMENTS.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/.conduct/specs/2026-03-20-audit-fix-dhrtycgi-spec/TEST_VECTORS.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/.conduct/specs/2026-03-20-audit-fix-dhrtycgi-spec/PLAN.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/.conduct/specs/2026-03-20-audit-fix-dhrtycgi-spec/INTENT_AUDIT.md`
  - `/Users/serro/Documents/dev/n/superfunctions/scripts/verify-uifn-release.mjs`
- Audit reference:
  - Audit path: `/Users/serro/Documents/dev/n/superfunctions/uifn/.conduct/audits/2026-03-25-ptnwmntx-full-audit.md`
  - Related prior spec bundle: `/Users/serro/Documents/dev/n/superfunctions/uifn/.conduct/specs/2026-03-20-audit-fix-dhrtycgi-spec`

# Overview

Project name: `uifn`

One-sentence goal: Define the remaining work required to make `uifn` genuinely production-ready for the GA React and Svelte adapters, with deterministic runtime behavior, canonical failure handling, truthful public documentation, and release evidence that closes the gaps identified by the `2026-03-25` audit.

Target users:

- Frontend engineers consuming `@uifn/core`, `@uifn/react`, and `@uifn/svelte` in production applications and design systems
- Monorepo maintainers publishing `uifn` packages from the Superfunctions workspace
- QA and release engineers validating accessibility, SSR/hydration safety, and release artifact hygiene

Target environments:

- Build and test runtime: Node.js `18.x`, `20.x`, `22.x`
- Browser runtime: current evergreen Chrome, Edge, Firefox, Safari
- Rendering modes: client rendering, SSR, hydration, jsdom-based unit/integration tests, and real-browser manual accessibility verification
- Framework runtimes:
  - React `18.2+`
  - Svelte `5.x`
  - Vue `3.5+` only as Experimental

Languages/packages required:

- TypeScript for `uifn/core`, `uifn/react`, `uifn/vue`, `uifn/files`
- Svelte component sources for `uifn/svelte`
- npm workspaces, Turbo, tsup, Vitest, and the existing `verify:uifn-release` script family

Existing systems it MUST integrate with:

- The Superfunctions monorepo workspace model
- Existing `uifn` package structure: `core`, `react`, `svelte`, `vue`, `files`
- Existing package scripts, export maps, changelogs, and README surfaces
- Existing release script: `scripts/verify-uifn-release.mjs`

Data model summary:

- N/A for persistent application data
- Runtime entities are primitive stores, context payloads, focus/position state, release manifests, consumer smoke records, and manual accessibility evidence records

Security model:

- No authentication or authorization layer is in scope
- Primary security boundaries are safe DOM behavior, invariant enforcement, no raw HTML/script injection, no production debug leakage, and canonical handling of programmer misuse

Performance constraints:

- `VirtualizedList` MUST support at least 10,000 logical items while mounting fewer than 200 item wrappers under default overscan
- `Select` and `Combobox` MUST maintain keyboard and highlighted-state integrity at 500 logical items
- Toast providers MUST preserve state for at least 25 queued items
- Menu families MUST support at least 3 submenu levels
- Deterministic IDs MUST remain stable across SSR, hydration, and repeat test runs

Non-goals / out of scope:

- Making `@uifn/vue` GA
- Shipping new Solid or web-component adapters
- Adding styled components or a design-token system
- Adding backend APIs or persistence

Hard constraints:

- GA React and Svelte surfaces MUST be deterministic and SSR/hydration-safe
- No public GA build MAY suppress framework/compiler warnings that are part of the required quality bar
- Public package docs, manifests, export maps, and shipped API MUST agree
- Release readiness MUST be verifiable locally without CI-only steps

Assumptions:

- This bundle supersedes the `2026-03-20-audit-fix-dhrtycgi-spec` bundle for unresolved production-readiness work.
- React and Svelte remain the only GA adapters in this bundle.
- `@uifn/files` remains public but Experimental and MUST stay explicitly outside the GA adapter bar.

Questions:

- None block spec generation. Vue GA remains out of scope unless maintainers explicitly change product scope in a later bundle.

# Glossary

- GA: General Availability. A GA package is release-blocking and MUST satisfy every release requirement in this bundle.
- Experimental: A public package that MAY ship, but MUST remain explicitly non-GA in docs and release policy.
- Core-owned semantics: Behavior implemented once in `@uifn/core` and reused by adapters without divergence.
- Adapter-owned helper: A public surface intentionally not exported by `@uifn/core`, such as `Badge`, `Label`, `VirtualizedList`, `Portal`, `Presence`, or `Slot`.
- Duplicate-instance ID collision: Any case where two simultaneously mounted instances expose the same public DOM ID or ARIA relationship target.
- Consumer smoke workspace: A clean temporary workspace that installs the packed `uifn` artifacts and verifies documented imports/type resolution.
- Manual accessibility evidence: A release artifact recorded from real browser and assistive-technology use, not jsdom or static ARIA review.
- Canonical runtime error: A `UIFnError` payload with a stable code, package, and message contract.
- Release manifest: The machine-readable summary emitted by the release gate for package checks and supporting evidence.
- Public surface drift: Any mismatch between shipped exports, docs, manifests, or root spec claims.

# Goals / Non-goals

Goals:

- Make `@uifn/core`, `@uifn/react`, and `@uifn/svelte` truthfully releasable as GA packages.
- Remove nondeterministic IDs, fixed instance-scoped content IDs, and compiler-warning suppression from GA release paths.
- Standardize canonical `UIFnError` handling across core and adapters.
- Complete missing modal, keyboard, and controlled-state semantics identified by the `2026-03-25` audit.
- Add consumer smoke verification, real manual accessibility evidence, and release evidence that covers what the existing gate misses.
- Bring root/package docs and the legacy `uifn/.conduct/SPEC.md` back into alignment with the shipped public API.

Non-goals:

- This bundle does NOT require Vue to become GA.
- This bundle does NOT require new primitive families beyond the current documented and shipped package boundary.
- This bundle does NOT require visual styling or design-token features.
- This bundle does NOT require new unsupported adapters.

# Public API

## Package entry points

| Package | Status | Required public contract |
| --- | --- | --- |
| `@uifn/core` | GA | MUST export stable `./aria/*`, `./state/*`, `./utils/*`, and `./primitives/*` subpaths plus canonical errors |
| `@uifn/react` | GA | MUST export the documented GA family catalog plus `Portal`, `Presence`, and `Slot` helper surfaces |
| `@uifn/svelte` | GA | MUST export the documented GA family catalog and typed Svelte entry point |
| `@uifn/vue` | Experimental | MUST remain explicitly Experimental and MUST NOT claim unshipped composable APIs |
| `@uifn/files` | Experimental | MUST remain explicitly Experimental with a narrow typed helper surface |

## Core runtime types

```ts
export type UIFnPackageName =
  | "@uifn/core"
  | "@uifn/react"
  | "@uifn/svelte"
  | "@uifn/vue"
  | "@uifn/files";

export type UIFnErrorCode =
  | "UIFN_ERR_A11Y_GATE_FAILURE"
  | "UIFN_ERR_CONTEXT_MISSING"
  | "UIFN_ERR_CONTROLLED_STATE_DIVERGENCE"
  | "UIFN_ERR_DETERMINISTIC_ID_MISMATCH"
  | "UIFN_ERR_DOCS_DRIFT"
  | "UIFN_ERR_DUPLICATE_PUBLIC_ID"
  | "UIFN_ERR_EXPORT_SURFACE_MISMATCH"
  | "UIFN_ERR_FILES_SCOPE_DRIFT"
  | "UIFN_ERR_HYDRATION_MISMATCH"
  | "UIFN_ERR_INVALID_VALUE"
  | "UIFN_ERR_MANUAL_EVIDENCE_INVALID"
  | "UIFN_ERR_MENU_NAVIGATION"
  | "UIFN_ERR_PACK_ARTIFACT_LEAK"
  | "UIFN_ERR_POSITIONING_OVERFLOW"
  | "UIFN_ERR_PUBLIC_SURFACE_DRIFT"
  | "UIFN_ERR_RANGE_OUT_OF_BOUNDS"
  | "UIFN_ERR_SCROLL_SYNC"
  | "UIFN_ERR_TEST_MATRIX_GAP"
  | "UIFN_ERR_TOOLCHAIN_MISCONFIG"
  | "UIFN_ERR_UNSUPPORTED_ENVIRONMENT"
  | "UIFN_ERR_UNSUPPORTED_PUBLIC_CLAIM"
  | "UIFN_ERR_WARNING_SUPPRESSED"
  | "UIFN_ERR_CONSUMER_SMOKE_FAILURE"
  | "UIFN_ERR_DIALOG_MODAL_INCOMPLETE";

export interface UIFnErrorPayload {
  name: "UIFnError";
  code: UIFnErrorCode;
  package: UIFnPackageName;
  component?: string;
  message: string;
  recoverable: boolean;
  details?: Record<string, unknown>;
}
```

## Release evidence envelopes

```ts
export interface UIFnReleaseManifest {
  generatedAt: string;
  gitCommit: string;
  packages: Record<
    UIFnPackageName,
    {
      status: "ga" | "experimental";
      build: "pass" | "fail";
      lint: "pass" | "fail";
      test: "pass" | "fail";
      typecheck: "pass" | "fail";
      pack: "pass" | "fail";
      exportMap: "pass" | "fail";
      consumerSmoke?: "pass" | "fail";
      manualA11yEvidence?: "present" | "missing";
    }
  >;
}

export interface UIFnConsumerSmokeRecord {
  generatedAt: string;
  packages: UIFnPackageName[];
  install: "pass" | "fail";
  typecheck: "pass" | "fail";
  bundle: "pass" | "fail";
  resolvedImports: string[];
}

export interface UIFnManualA11yRecord {
  generatedAt: string;
  verifier: string;
  environments: Array<{
    framework: "react" | "svelte";
    browser: string;
    os: string;
    assistiveTech: string;
  }>;
  families: Array<{
    family: string;
    keyboard: "pass" | "fail";
    screenReader: "pass" | "fail";
    notes?: string;
  }>;
}
```

## Required family catalog

`@uifn/core` MUST expose factory/state surfaces for:

- `createAccordion`
- `createAlertDialog`
- `createAvatar`
- `createCheckbox`
- `createCollapsible`
- `createCombobox`
- `createContextMenu`
- `createDialog`
- `createDropdownMenu`
- `createHoverCard`
- `createMenuBar`
- `createPopover`
- `createProgress`
- `createRadioGroup`
- `createScrollArea`
- `createSelect`
- `createSeparator`
- `createSlider`
- `createSwitch`
- `createTabs`
- `createToast`
- `createToggle`
- `createToggleGroup`
- `createToolbar`
- `createTooltip`

The required GA adapter family catalog for both React and Svelte is:

- Accordion
- AlertDialog
- Avatar
- Badge
- Checkbox
- Collapsible
- Combobox
- ContextMenu
- Dialog
- DropdownMenu
- HoverCard
- Label
- MenuBar
- Popover
- Progress
- RadioGroup
- ScrollArea
- Select
- Separator
- Slider
- Switch
- Tabs
- Toast
- Toggle
- ToggleGroup
- Toolbar
- Tooltip
- VirtualizedList

React-only helper exports that MAY remain adapter-owned:

- `Portal`
- `Presence`
- `Slot`

The following legacy root-spec claims are NOT public API unless implementation is added and docs are updated together:

- `TooltipProvider`
- `TooltipArrow`
- `ComboboxEmpty`
- `ComboboxViewport`
- `ContextMenuCheckboxItem`
- `ContextMenuRadioGroup`
- `ContextMenuRadioItem`
- `ContextMenuSub`
- `ContextMenuSubTrigger`
- `ContextMenuSubContent`

# Data formats / protocol

There is no network protocol in scope. The canonical machine-readable I/O shapes are:

- `UIFnErrorPayload`
- `UIFnReleaseManifest`
- `UIFnConsumerSmokeRecord`
- `UIFnManualA11yRecord`

Failure behavior:

- Missing provider/context usage in public GA adapters MUST throw `UIFnError` with code `UIFN_ERR_CONTEXT_MISSING`.
- Duplicate or nondeterministic public IDs MUST fail tests or smoke verification with `UIFN_ERR_DETERMINISTIC_ID_MISMATCH` or `UIFN_ERR_DUPLICATE_PUBLIC_ID`.
- Suppressed or ignored GA compiler warnings MUST fail verification with `UIFN_ERR_WARNING_SUPPRESSED`.
- Invalid manual accessibility evidence MUST fail verification with `UIFN_ERR_MANUAL_EVIDENCE_INVALID`.

# Semantics

## Release surface semantics

- `uifn` MUST present one canonical public package family centered on `@uifn/core`, `@uifn/react`, and `@uifn/svelte`.
- Vue and files MUST remain public-but-Experimental unless a later bundle explicitly promotes them.
- Unsupported adapters such as Solid and web-components MUST NOT be claimed in GA docs or support matrices.
- The legacy root `uifn/.conduct/SPEC.md` MUST be updated or constrained until it no longer overclaims unshipped public parts.

## Core ownership semantics

- `@uifn/core` MUST own the authoritative state and interaction semantics for all shared GA primitive families.
- Adapters MAY provide framework rendering, refs, slots/snippets, or helper wiring, but MUST NOT diverge on keyboard, dismissal, controlled/uncontrolled, or ARIA-state rules.
- Adapter-owned helpers MUST remain explicitly documented as adapter-owned and MUST NOT imply core exports that do not exist.

## Deterministic identity semantics

- Public IDs and ARIA link targets MUST be unique per mounted instance.
- `Math.random()` and hardcoded instance-scoped IDs such as `dialog-content` or `select-content` MUST NOT be used for GA surfaces.
- The same server-rendered tree and hydrated client tree MUST produce the same logical IDs and relationships.
- Multiple simultaneous instances of the same primitive family MUST remain collision-free.

## Runtime error semantics

- Missing provider/context, invalid controlled values, and release-surface mismatches MUST throw canonical `UIFnError` payloads.
- Disabled interactions MUST no-op without throwing.
- Development warnings MAY exist, but MUST be environment-gated and MUST NOT be suppressed to make GA verification pass.
- Production bundles MUST NOT contain unconditional `console.log`, `console.debug`, or ad hoc tracing.

## Accessibility semantics

- GA families MUST satisfy WAI-ARIA role, keyboard, focus, and labelling contracts.
- Reduced-motion preference MUST NOT change correctness, cleanup, or close behavior.
- Manual accessibility evidence MUST come from real browsers and assistive technologies. jsdom, static ARIA review, and unit-test assertions are not substitutes.

## Family semantics

- Disclosure and collection families (`Accordion`, `Tabs`, `ToggleGroup`, `Toolbar`, `MenuBar`) MUST implement deterministic controlled/uncontrolled state and keyboard navigation.
- Dialog and popup families (`Dialog`, `AlertDialog`, `Popover`, `Tooltip`, `HoverCard`, `DropdownMenu`, `ContextMenu`) MUST implement deterministic close reasons, focus management, and cleanup.
- Modal families MUST implement body-scroll lock when modal content is open and MUST always clean it up.
- `AlertDialog` outside interaction MUST remain disallowed unless the contract changes everywhere together.
- `Select` and `Combobox` MUST support controlled/uncontrolled `value` and `open`, keyboard navigation, form participation, and stable ARIA relationships.
- `Slider`, `Progress`, and `ScrollArea` MUST implement the published range, sync, and geometry semantics without placeholder behavior.

## Adapter semantics

### React

- React components MUST forward refs to the correct DOM node.
- React host components that claim `asChild` MUST preserve behavior and refs.
- React GA components MUST use deterministic IDs and MUST be safe for SSR, hydration, and multi-instance rendering.

### Svelte

- Svelte GA components MUST react to controlled prop changes after mount.
- Svelte GA builds MUST complete without suppressed compiler warnings.
- Svelte GA components MUST implement the same keyboard and modal semantics as the shared contract, not a reduced local approximation.

## Evidence semantics

- Release gating MUST include package-local build, lint, test, typecheck, export-map, and pack checks.
- Release gating MUST also include consumer smoke verification for GA packages.
- Manual accessibility evidence MUST be recorded as a release artifact and MUST be present before GA release.

## Documentation and support-matrix semantics

- Root docs, package READMEs, export maps, manifests, and shipped public symbols MUST agree.
- Experimental packages MUST remain explicitly marked Experimental in all public docs.
- Any surface not exported MUST be removed from public claims or implemented with matching tests and docs.

# Invariants

- Public deterministic IDs MUST NOT depend on randomness.
- Public GA verification MUST NOT rely on suppressed warnings.
- Disabled interactive controls MUST ignore state-changing input.
- Duplicate-instance ARIA ID collisions are forbidden.
- All GA adapter context failures MUST throw canonical `UIFnError`.
- Public tarballs MUST be deterministic and pack-clean.
- No release candidate is valid without real manual accessibility evidence.
- No phase is complete unless its verification steps pass locally.

# Security

- Runtime code MUST NOT use `eval`, `new Function`, `dangerouslySetInnerHTML`, or Svelte `{@html}` in normal rendering paths.
- Runtime code MUST NOT emit end-user text, labels, or form values through production debugging output.
- Hidden form inputs MUST serialize only the documented primitive value contract.
- Error snapshots MUST omit stack traces and user data from stable machine-readable outputs.

# Limits/caps

- `VirtualizedList`: 10,000 logical items, fewer than 200 mounted wrappers with default overscan
- `Select` and `Combobox`: 500 items without focus/highlight corruption
- `Toast`: 25 queued items without state loss
- `Menu`/`ContextMenu`/`MenuBar`: 3 nested submenu levels
- Every GA package entry point MUST ship type declarations
- Multi-instance deterministic-ID tests MUST cover at least 3 simultaneous instances per affected family

# Observability

- Release scripts SHOULD emit parseable JSON or markdown evidence for package checks, consumer smoke, and manual accessibility sign-off.
- Development-only warnings MAY be emitted for misuse, but MUST be explicit and non-production.
- Runtime libraries MUST NOT emit ad hoc debug output.
- Manual accessibility evidence MUST name verifier, browser, OS, assistive technology, and families exercised.

# Compatibility / versioning strategy

- `uifn` MUST use semver.
- Supported environments for this bundle are:
  - Node.js `18.x`, `20.x`, `22.x`
  - React `18.2+`
  - Svelte `5.x`
  - Vue `3.5+` as Experimental only
  - Evergreen Chrome, Edge, Firefox, Safari
- Package manifests, peer ranges, package READMEs, and root docs MUST match the supported matrix.
- Breaking public API or package-identity changes MUST be documented in changelogs and release notes.

# Undefined / Explicitly user-deferred only

- Making `@uifn/vue` GA is undefined and NOT required by this bundle.
- Shipping Solid or web-component adapters is undefined and NOT required by this bundle.
- Adding visual styling, theming, or design-token layers is undefined and NOT required by this bundle.

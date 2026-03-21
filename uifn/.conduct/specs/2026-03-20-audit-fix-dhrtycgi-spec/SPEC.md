# Metadata

- Timestamp: `2026-03-20T10:57:27Z`
- Agent name: `spec`
- Model: `unknown`
- Launcher: `Codex Desktop`
- Workspace/project absolute path: `/Users/serro/Documents/dev/n/superfunctions/uifn`
- OS + shell: `Darwin Mac 25.3.0 arm64`, shell `/bin/zsh`
- Repo metadata: git repo detected at `/Users/serro/Documents/dev/n/superfunctions`; branch `next`; commit `6f9a47d6c5f8ac166932e0156efb910bf5e32652`; dirty worktree `yes`
- Spec folder name: `2026-03-20-audit-fix-dhrtycgi-spec`
- Spec folder path: `/Users/serro/Documents/dev/n/superfunctions/uifn/.conduct/specs/2026-03-20-audit-fix-dhrtycgi-spec`
- Spec type: `audit-fix`
- Spec id: `dhrtycgi`
- Input paths read:
  - `/Users/serro/Documents/dev/n/superfunctions/AGENTS.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/SPEC.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/core/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/react/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/vue/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/svelte/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/core/package.json`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/react/package.json`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/vue/package.json`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/svelte/package.json`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/files/package.json`
  - `/Users/serro/Documents/dev/n/superfunctions/uifn/.conduct/audits/2026-03-20-er70p4kq-full-audit.md`
- Audit reference:
  - Audit path: `/Users/serro/Documents/dev/n/superfunctions/uifn/.conduct/audits/2026-03-20-er70p4kq-full-audit.md`
  - Audited spec bundle reference: `N/A`; the audit was performed against legacy `uifn/SPEC.md` plus package docs, not an existing `uifn/.conduct/specs/*` bundle

# Overview

Project name: `uifn`

One-sentence goal: Define the complete implementation and release contract required to make `uifn` production-ready as a truthful, installable, accessible, deterministic, and locally verifiable package family, with React and Svelte treated as release-blocking GA adapters.

Target users:

- Frontend engineers building design systems and application UI on top of `uifn`
- Monorepo maintainers responsible for packaging, release, and support matrix accuracy
- QA engineers verifying accessibility, keyboard behavior, and SSR/hydration safety

Target environments:

- Package build/test environment: Node.js `18.x`, `20.x`, and `22.x`
- Browser runtime: current evergreen Chrome, Edge, Firefox, and Safari desktop/mobile releases
- Rendering modes: client-side rendering, SSR, hydration, and jsdom-based local tests
- Framework runtimes:
  - React `18.2+`
  - Svelte `5.x`
  - Vue `3.5+` only if kept public; otherwise it MUST be explicitly marked unsupported or experimental

Languages/packages required:

- TypeScript for `uifn/core`, `uifn/react`, `uifn/vue`, and `uifn/files`
- Svelte component sources plus generated declaration output for `uifn/svelte`
- npm workspaces and Turbo-based local orchestration

Existing systems it must integrate with:

- The Superfunctions monorepo workspace model defined in `/Users/serro/Documents/dev/n/superfunctions/AGENTS.md`
- Current `uifn` package set: `core`, `react`, `svelte`, `vue`, and `files`
- Existing local tools: `tsup`, `typescript`, `vitest`, `jsdom`, framework Vite plugins, `npm pack`

Data model summary:

- N/A for persistent application data
- Runtime state entities are UI primitive state stores, component context payloads, error envelopes, and verification reports

Security model:

- No authentication or authorization layer exists inside `uifn`
- Primary security concerns are safe DOM behavior, invariant enforcement, non-leakage of user content in logs, and resistance to state desynchronization or unsafe markup injection

Performance constraints:

- Core primitives MUST remain lightweight and framework-agnostic
- Keyboard/focus/selection updates for lists up to 500 interactive items MUST complete within a single animation frame on supported browsers
- Virtualized list rendering MUST support at least 10,000 logical items without mounting all items at once
- Popup positioning and collision updates MUST settle without visible flicker under normal viewport resize or scroll

Assumptions and questions:

- Assumption A1: The canonical public package names for a production-ready release are `@uifn/core`, `@uifn/react`, `@uifn/svelte`, `@uifn/vue`, and `@uifn/files`. A deprecated `uifn` alias MAY exist temporarily only if explicitly documented and covered by compatibility tests.
- Assumption A2: React and Svelte are the GA adapters for this bundle because the user explicitly requested that both be production-ready.
- Assumption A3: Unsupported adapters such as Solid or web-components MUST be removed from public support claims until implemented; shipping false support claims is not production-ready behavior.
- Assumption A4: MIT is the canonical package license because all audited package manifests already use `MIT`; docs MUST align unless maintainers intentionally change the legal decision in a separate tracked change.
- Question Q1: Do maintainers want `@uifn/vue` to remain public and experimental, or should it be held to the same GA bar in a follow-up bundle after React and Svelte are green?

# Glossary

- GA: General Availability. A GA package is release-blocking, documented as supported, and MUST pass the full local verification suite.
- Experimental: A public package that MAY exist in the repository, but MUST be explicitly labeled as unsupported for production use and MUST NOT be implied to be GA.
- Core primitive: A framework-agnostic state and semantics implementation in `@uifn/core`.
- Adapter: A framework-specific export surface that binds DOM/framework events and rendering to core primitive semantics.
- Controlled mode: A component mode where external props are the single source of truth and internal state mirrors them without divergence.
- Uncontrolled mode: A component mode where initial state is seeded from defaults and then owned internally.
- Release surface: The set of package names, export paths, README instructions, type declarations, and tarball contents visible to consumers.
- Deterministic ID: An ID that is stable for the same logical component tree across server render, client hydration, and repeat test runs.
- Popup family: `Dialog`, `AlertDialog`, `Popover`, `Tooltip`, `HoverCard`, `DropdownMenu`, `ContextMenu`, `MenuBar`.
- Collection family: `Accordion`, `Tabs`, `ToggleGroup`, `Toolbar`, `Select`, `Combobox`, `RadioGroup`.
- Canonical error envelope: The normalized runtime/build error object defined by this spec.

# Goals / Non-goals

Goals:

- Make the public `uifn` package family internally consistent, installable, typed, and pack-clean.
- Make `@uifn/core` the authoritative owner of shared primitive semantics instead of leaving critical behavior fragmented across adapters.
- Make `@uifn/react` a production-ready GA adapter with stable imports, `asChild` support where documented, and green local verification.
- Make `@uifn/svelte` a production-ready GA adapter with working toolchain compatibility, emitted types, reactive controlled/uncontrolled behavior, and green local verification.
- Define truthful support-matrix rules for Vue, files, and unsupported future adapters.
- Define canonical runtime errors, observability rules, accessibility obligations, determinism constraints, and release verification steps.
- Produce an implementation plan that can be executed in independently verifiable phases.

Non-goals:

- This bundle does not require a styled component library or visual design system on top of the primitives.
- This bundle does not require new server APIs, persistence layers, or backend functionality.
- This bundle does not require shipping new Solid or web-components adapters; it requires removing unsupported support claims until such adapters exist.
- This bundle does not require feature expansion beyond the current documented/public surface; it requires making that surface truthful and production-safe.

# Public API

## Package entry points

The production-ready release surface MUST include the following package entry points:

| Package | Required status | Required root contract |
| --- | --- | --- |
| `@uifn/core` | GA | MUST export core primitives, `aria/*`, `state/*`, and `utils/*` via stable public paths |
| `@uifn/react` | GA | MUST export typed React components and helper utilities documented in the GA support matrix |
| `@uifn/svelte` | GA | MUST export typed Svelte components and any intentional public helper modules |
| `@uifn/vue` | Experimental or GA | MUST be truthfully labeled; if public, its README/package metadata MUST match its actual API shape |
| `@uifn/files` | Experimental or moved out | MUST either be documented as part of `uifn` or be removed from the `uifn` product boundary |

## Shared core runtime types

```ts
export type UIFnPackageName =
  | "@uifn/core"
  | "@uifn/react"
  | "@uifn/svelte"
  | "@uifn/vue"
  | "@uifn/files";

export type UIFnErrorCode =
  | "UIFN_ERR_CONTEXT_MISSING"
  | "UIFN_ERR_INVALID_VALUE"
  | "UIFN_ERR_CONTROLLED_STATE_DIVERGENCE"
  | "UIFN_ERR_DETERMINISTIC_ID_MISMATCH"
  | "UIFN_ERR_EXPORT_SURFACE_MISMATCH"
  | "UIFN_ERR_PACK_ARTIFACT_LEAK"
  | "UIFN_ERR_TOOLCHAIN_MISCONFIG"
  | "UIFN_ERR_HYDRATION_MISMATCH"
  | "UIFN_ERR_A11Y_GATE_FAILURE"
  | "UIFN_ERR_UNSUPPORTED_ENVIRONMENT"
  | "UIFN_ERR_UNSUPPORTED_PUBLIC_CLAIM";

export interface UIFnError extends Error {
  name: "UIFnError";
  code: UIFnErrorCode;
  package: UIFnPackageName;
  component?: string;
  details?: Record<string, unknown>;
  recoverable: boolean;
}

export interface UIFnChangeMeta<TReason extends string = string> {
  source: "user" | "programmatic" | "controlled-sync";
  reason: TReason;
  previousValue: unknown;
  nextValue: unknown;
  inputModality?: "keyboard" | "pointer" | "touch" | "virtual";
}

export interface UIFnStore<TState, TActions> {
  getState(): Readonly<TState>;
  subscribe(
    listener: (state: Readonly<TState>, meta: UIFnChangeMeta) => void
  ): () => void;
  actions: Readonly<TActions>;
  destroy?(): void;
}
```

## Core factory surface

`@uifn/core` MUST expose stable factory functions for every GA primitive family, including:

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
- `createSlider`
- `createSwitch`
- `createTabs`
- `createToast`
- `createToggle`
- `createToggleGroup`
- `createToolbar`
- `createTooltip`

Every factory listed above MUST return a `UIFnStore`-compatible object plus any explicitly documented geometry or ref helpers required by adapters.

## Adapter family catalog

The production-ready adapter catalog MUST remain aligned with the following public family names and parts:

| Family | React exports | Svelte exports | Notes |
| --- | --- | --- | --- |
| Accordion | `Accordion`, `AccordionItem`, `AccordionTrigger`, `AccordionContent` | same family names | GA |
| Alert Dialog | `AlertDialog`, `AlertDialogTrigger`, `AlertDialogPortal`, `AlertDialogOverlay`, `AlertDialogContent`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogAction`, `AlertDialogCancel` | same family names | GA |
| Checkbox | `Checkbox`, `CheckboxIndicator` | same family names | GA |
| Collapsible | `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent` | same family names | GA |
| Combobox | `Combobox`, `ComboboxTrigger`, `ComboboxInput`, `ComboboxContent`, `ComboboxItem`, `ComboboxItemIndicator`, `ComboboxGroup`, `ComboboxLabel`, `ComboboxSeparator` | same family names | GA |
| Context Menu | `ContextMenu`, `ContextMenuTrigger`, `ContextMenuContent`, `ContextMenuItem` plus any documented submenu variants | same family names | GA |
| Dialog | `Dialog`, `DialogTrigger`, `DialogPortal`, `DialogOverlay`, `DialogContent`, `DialogTitle`, `DialogDescription`, `DialogClose` | same family names | GA |
| Dropdown Menu | `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuLabel`, `DropdownMenuSeparator` plus documented submenu variants | same family names | GA |
| Hover Card | `HoverCard`, `HoverCardTrigger`, `HoverCardContent` | same family names | GA |
| Menu Bar | `MenuBar`, `MenuBarMenu`, `MenuBarTrigger`, `MenuBarContent` | same family names | GA if kept public |
| Popover | `Popover`, `PopoverTrigger`, `PopoverContent` | same family names | GA |
| Progress | `Progress` | same family names | GA |
| Radio Group | `RadioGroup`, `RadioGroupItem`, `RadioGroupIndicator` | same family names | GA |
| Scroll Area | `ScrollArea`, `ScrollAreaViewport`, `ScrollAreaScrollbar`, `ScrollAreaThumb`, `ScrollAreaCorner` | same family names | GA |
| Select | `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectViewport`, `SelectItem`, `SelectItemIndicator`, `SelectGroup`, `SelectLabel`, `SelectSeparator` | same family names | GA |
| Separator | `Separator` | `Separator` | GA |
| Slider | `Slider`, `SliderTrack`, `SliderRange`, `SliderThumb` | same family names | GA |
| Switch | `Switch`, `SwitchThumb` | same family names | GA |
| Tabs | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | same family names | GA |
| Toast | `ToastProvider`, `Toast`, `ToastViewport`, `ToastTitle`, `ToastDescription`, `ToastAction`, `ToastClose` | same family names | GA |
| Toggle | `Toggle` | `Toggle` | GA |
| Toggle Group | `ToggleGroup`, `ToggleGroupItem` | same family names | GA |
| Toolbar | `Toolbar`, `ToolbarButton`, `ToolbarLink`, `ToolbarSeparator` | same family names | GA |
| Tooltip | `Tooltip`, `TooltipTrigger`, `TooltipContent` | same family names | GA |
| Display helpers | `Avatar`, `AvatarImage`, `AvatarFallback`, `Badge`, `Label`, `Portal`, `Presence`, `VirtualizedList` | `Avatar`, `AvatarImage`, `AvatarFallback`, `Badge`, `Label`, `VirtualizedList` | `Portal` and `Presence` are React-only helper utilities unless intentionally made cross-framework |

## `@uifn/files` public API

If `@uifn/files` remains within the `uifn` product boundary, it MUST keep a documented typed helper surface for:

- `FileDropzone`
- `UploadProgressList`
- `FileList`
- `QuotaUsageBar`
- `PricingPlans`
- `UsageAnalytics`

# Data formats / protocol

There is no network protocol in scope. The canonical envelopes defined here apply to runtime errors, state change notifications, and release verification output.

## Canonical runtime error envelope

```ts
interface UIFnErrorPayload {
  name: "UIFnError";
  code: UIFnErrorCode;
  package: UIFnPackageName;
  component?: string;
  message: string;
  recoverable: boolean;
  details?: Record<string, unknown>;
}
```

Rules:

- Runtime programmer errors such as missing provider context MUST throw a `UIFnError`.
- Recoverable user-driven conditions such as disabled interaction MUST NOT throw; they MUST no-op and MAY emit a development warning only in non-production builds.
- Build, lint, test, type, and pack failures MUST fail the command with a non-zero exit code and SHOULD surface a matching `UIFnErrorCode` in scripts or snapshots.

## Canonical state change meta envelope

```ts
interface UIFnChangeMetaPayload<TReason extends string = string> {
  source: "user" | "programmatic" | "controlled-sync";
  reason: TReason;
  previousValue: unknown;
  nextValue: unknown;
  inputModality?: "keyboard" | "pointer" | "touch" | "virtual";
}
```

Rules:

- All controlled/uncontrolled callbacks in GA adapters MUST be able to derive this metadata, even if a thin compatibility callback shape is preserved for public API stability.
- A disabled component MUST NOT emit change callbacks.

## Canonical release verification envelope

```ts
interface UIFnReleaseManifest {
  generatedAt: string;
  gitCommit: string;
  packages: Record<
    UIFnPackageName,
    {
      status: "ga" | "experimental" | "removed";
      build: "pass" | "fail";
      test: "pass" | "fail";
      lint: "pass" | "fail";
      pack: "pass" | "fail";
      types: "present" | "missing";
    }
  >;
}
```

# Semantics

## Release surface semantics

- The package family MUST present one internally consistent identity. Public docs, install commands, package manifests, export maps, and smoke tests MUST agree on canonical package names.
- React and Svelte MUST be treated as GA and release-blocking in this bundle.
- Vue MUST either:
  - meet the same release gates as a public package, or
  - be explicitly labeled experimental in README/support matrix/package docs.
- Solid and web-components MUST NOT be advertised as supported until their adapters exist and pass the same release gates.
- If a legacy `uifn` core alias is kept, it MUST be documented as deprecated, MUST resolve to the same behavior as `@uifn/core`, and MUST be covered by compatibility tests.

## Core ownership semantics

- `@uifn/core` MUST own the authoritative state, keyboard semantics, focus rules, and change contracts for every GA primitive family.
- Adapters MAY add framework ergonomics, refs, slot composition, or DOM rendering helpers, but they MUST NOT redefine behavioral semantics already owned by core.
- Adapter-only presentational surfaces such as `Badge` or `VirtualizedList` MAY exist without a core factory only if they are explicitly documented as adapter-level helpers and do not contradict core behavioral contracts.

## Controlled and uncontrolled semantics

- Every stateful GA primitive MUST support both controlled and uncontrolled modes.
- Controlled mode means the prop value is the source of truth. Internal state MUST only mirror it and MUST NOT drift.
- Uncontrolled mode means initial state is derived from a `default*` prop and subsequently maintained internally.
- Supplying both controlled and uncontrolled props for the same field MUST trigger a development-time warning and deterministic precedence rules, not undefined runtime drift.
- All change callbacks MUST include stable semantic reasons such as `toggle`, `select`, `close-escape`, `close-outside`, `typeahead`, or `sync-prop`.

## Accessibility semantics

- GA primitives MUST meet WCAG 2.1 AA obligations applicable to headless primitives: correct roles, keyboard navigation, focus visibility hooks, readable labels/descriptions, and screen-reader compatibility.
- Focus trap, focus return, roving focus, and activedescendant behavior MUST be owned by shared utilities rather than duplicated inconsistently per adapter.
- Reduced-motion preferences MUST be respected. Animations MAY exist, but their absence MUST NOT change behavior or prevent cleanup/unmount.
- Hidden form inputs MUST serialize only the intended form value and MUST remain inert to assistive tech.

## Disclosure and collection semantics

- `Accordion`, `Collapsible`, `Tabs`, and `ToggleGroup` MUST implement consistent orientation and roving focus rules driven by core.
- `RadioGroup`, `Toolbar`, `MenuBar`, `Select`, and `Combobox` MUST derive navigation order from DOM registration order unless explicitly documented otherwise.
- Invalid externally controlled values MUST produce deterministic behavior:
  - selection primitives MUST either preserve the invalid value and expose no active item, or
  - normalize to empty according to the component contract
  - they MUST NOT silently select an arbitrary fallback item

## Popup semantics

- `Dialog` and `AlertDialog` MUST enforce modal semantics, focus trap, focus return, escape handling, and explicit outside-click policy.
- `Popover`, `Tooltip`, and `HoverCard` MUST share collision-aware positioning and dismiss semantics.
- `DropdownMenu`, `ContextMenu`, and `MenuBar` MUST support nested content, disabled items, and arrow-key navigation with deterministic focus transfer.
- Popup position MAY vary according to viewport size, writing direction, preferred side, and collision fallback, but MUST be deterministic for the same geometry inputs.

## Selection semantics

- `Select` MUST support grouped options, separators, keyboard navigation, optional typeahead, and form integration.
- `Combobox` MUST support input-driven filtering, highlight state, empty state, controlled open/value/inputValue, and optional virtualization support for large datasets.
- `ScrollArea` MUST synchronize viewport scroll position, scrollbar visibility, thumb position, and corner rendering without layout loops.

## Range and status semantics

- `Slider` MUST support one or more thumbs, clamped values, step alignment, orientation, and keyboard/touch/pointer input.
- `Progress` MUST support determinate and indeterminate modes with correct `aria-valuenow`, `aria-valuemin`, and `aria-valuemax` behavior.

## Adapter semantics

### React

- Public React components that render a host element and are documented as polymorphic MUST support `asChild`.
- React components MUST forward refs to their actual interactive/focusable DOM element or documented equivalent.
- React helper hooks MUST be SSR-safe and MUST NOT rely on unstable import paths from missing export-map entries.

### Svelte

- Public Svelte components MUST emit declaration files and MUST expose stable prop/event/slot typing.
- Svelte components MUST react to controlled prop changes after mount and MUST NOT freeze initial prop snapshots into long-lived state when that breaks controlled semantics.
- Svelte builds MUST complete without `state_referenced_locally` warnings in GA components.

## Documentation and support matrix semantics

- `uifn/SPEC.md`, package READMEs, and package manifests MUST agree on supported adapters, licenses, install commands, exported component families, and GA/experimental labels.
- Public packages MUST have a changelog or equivalent release-notes surface.
- `@uifn/files` MUST either be documented as part of the `uifn` surface or removed from the `uifn` scope.

# Invariants

- Runtime randomness such as `Math.random()` MUST NOT be used for public IDs or any behavior that affects SSR, hydration, or deterministic tests.
- Process-global incrementing IDs MAY exist only behind a deterministic seed strategy that yields the same server/client output for the same tree; otherwise they are forbidden.
- Disabled interactive components MUST ignore state-changing user input and MUST NOT emit change callbacks.
- Every popup close reason MUST be attributable to a deterministic semantic reason.
- DOM registration order MUST define keyboard navigation order unless a family explicitly defines a different ordering contract.
- Production bundles MUST NOT contain unconditional `console.log`, `console.debug`, or ad hoc debug output.
- Package tarball contents MUST be deterministic for a given source tree and MUST exclude compiled tests or internal-only files.
- Type declaration availability is mandatory for every GA package entry point.
- Local verification results MUST be reproducible from a clean install in the monorepo workspace.

# Security

- Public components MUST NOT use `eval`, dynamic script execution, or raw HTML injection for normal rendering paths.
- Public components MUST NOT log end-user text content, file names, or form values in production-mode debug output.
- Positioning and portal logic MUST validate target/container availability and MUST fail with canonical invariant errors rather than raw runtime exceptions.
- Form-associated helpers MUST serialize only primitive string values intentionally documented by the component contract.
- Error payloads MUST omit stack traces or user data from stable machine-readable snapshots unless a local development mode explicitly requests them.

# Limits/caps

- Virtualized list helpers MUST support at least 10,000 logical items while rendering fewer than 200 DOM item wrappers at once under default overscan settings.
- Select and Combobox collections MUST be verified against at least 500 logical items and typeahead queries without focus corruption.
- Toast providers MUST support at least 25 queued items without dropping state or leaking timers.
- Menu and context-menu families MUST support at least 3 nested submenu levels.
- Any new runtime dependency added to `@uifn/core` SHOULD stay below 10 kB gzip cost unless a documented exception is approved in release notes.
- GA packages MUST emit declaration files for every documented root export.

# Observability

- Development-only warnings MAY be emitted for programmer misuse such as unsupported prop combinations, but they MUST be gated away from production bundles.
- Local verification MUST include machine-readable or parseable command output for build, test, lint, and pack steps.
- Manual accessibility verification results SHOULD be captured in phase or release reports, not emitted by the runtime libraries themselves.
- Public runtime code MUST NOT emit raw debug traces like the current `Presence` logging pattern.

# Compatibility / versioning strategy

- The `uifn` package family MUST use semver.
- Breaking public API or package-name changes MUST ship in a major version and MUST be documented in changelog/release notes.
- A deprecated package alias, if any, MUST remain behaviorally equivalent for one major cycle or be removed before GA; silent divergence is forbidden.
- Supported environment matrix for this bundle:
  - Node.js `18.x`, `20.x`, `22.x`
  - React `18.2+`
  - Svelte `5.x`
  - Vue `3.5+` only if kept public
  - Evergreen browsers: latest two stable versions of Chrome, Edge, Firefox, Safari
- Package manifests, README install commands, and peer dependency ranges MUST match the supported matrix.
- The canonical package license for this bundle is assumed to be `MIT` unless maintainers intentionally change that legal decision in a separately reviewed change.

# Undefined / Explicitly user-deferred only

- None. Any unsupported package, adapter, or component MUST be removed from public claims or explicitly labeled non-GA rather than left undefined.

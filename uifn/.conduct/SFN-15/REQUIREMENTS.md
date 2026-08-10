# SFN-15 Requirements

## Table of Contents

- ARCH-001 Layered package architecture
- ARCH-002 Clean-room capability target
- CORE-001 Core behavior controller contract
- CORE-002 Part anatomy and prop getters
- ADAPT-001 Adapter-kit conformance harness
- ADAPT-002 React adapter
- ADAPT-003 Svelte adapter
- ADAPT-004 Vue adapter
- ADAPT-005 Solid adapter
- ADAPT-006 Angular adapter
- STYLE-001 Design token schema
- STYLE-002 Runtime theme mounting
- STYLE-003 OKLCH ramps and contrast validation
- STYLE-004 Semantic surfaces and surface depth
- STYLE-005 Tailwind integration
- STYLE-006 Recipe output targets
- COMP-001 Coss catalog coverage
- COMP-002 Styled component contract
- COMP-003 Data-rich component behavior
- HOOK-001 Hook coverage
- REG-001 Registry manifest contract
- REG-002 CLI package import and source install
- STORY-001 Storybook workshop surface
- STORY-002 Story coverage as tests
- PAT-001 Controlled product patterns
- SF-001 Superfunction-backed pattern contract
- SF-002 Phase-one Superfunction panels
- TEST-001 Production release gate
- TEST-002 Accessibility and visual gates
- DOCS-001 Generated docs and examples
- SEC-001 Secret and privacy boundaries
- VER-001 Breaking-change posture and versioning

## Requirements

### ARCH-001

Priority: P0

Statement: `uifn` MUST implement the target package architecture defined in `SPEC.md`.

Rationale: The system needs clear layer ownership so primitives, adapters, styling, components, patterns, registry, and Storybook can evolve without collapsing into one package.

Acceptance criteria:

- Public packages exist for every package listed in `SPEC.md`.
- Each package has a manifest, build script, test script, typecheck script, export map, status metadata, and README.
- Package dependencies follow the allowed layer direction.
- No package imports from a higher layer.

Test vectors: TV-ARCH-001, TV-ARCH-002

Notes: Priority indicates sequencing only; all packages are in scope.

### ARCH-002

Priority: P0

Statement: `uifn` MUST use Coss UI only as a clean-room capability reference.

Rationale: Clean-room implementation avoids licensing, provenance, and maintainability risk.

Acceptance criteria:

- Component catalog maps to public Coss component names only.
- Source files contain no copied Coss source, prose, examples, comments, or assets.
- Implementation notes describe standards and internal behavior, not Coss internals.
- Registry manifests include `sourcePolicy: "clean-room"`.

Test vectors: TV-ARCH-003

Notes: Public web documentation may be linked as capability reference.

### CORE-001

Priority: P0

Statement: `@uifn/core` MUST expose framework-agnostic behavior controllers for every stateful primitive.

Rationale: Shared behavior is the only scalable way to support React, Svelte, Vue, Solid, and Angular consistently.

Acceptance criteria:

- Every stateful primitive exposes `createXController(config, env?)`.
- Controllers expose `state`, `actions`, `parts`, `getState`, `subscribe`, and `destroy`.
- Controllers accept deterministic test environment hooks.
- Controllers do not import React, Svelte, Vue, Solid, Angular, DOM rendering libraries, or Tailwind.

Test vectors: TV-CORE-001, TV-CORE-002

Notes: Stateless display components MAY have token/recipe contracts instead of controllers.

### CORE-002

Priority: P0

Statement: Core controllers MUST define stable part anatomy and DOM-ish prop getters for each primitive.

Rationale: Part-level contracts let every adapter expose native APIs while sharing accessibility and data-state semantics.

Acceptance criteria:

- Each primitive declares canonical part names.
- Each part getter returns role, id, tabIndex, aria, data, style, and event handler metadata where applicable.
- Data attributes are stable across frameworks.
- Negative user props cannot remove required accessibility attributes without an explicit error.

Test vectors: TV-CORE-003

Notes: Framework adapters MAY translate event names and binding shape.

### ADAPT-001

Priority: P0

Statement: `@uifn/adapter-kit` MUST provide shared adapter helpers and a conformance harness used by every framework adapter.

Rationale: Adapter parity requires shared testing and shared low-level utilities for event merging, refs, lifecycle, focus, portal, and environment wiring.

Acceptance criteria:

- Adapter kit exposes event merge, prop merge, cleanup, element registry, focus bridge, portal bridge, and conformance runner utilities.
- Every adapter package imports and uses the conformance harness.
- The harness can run the same primitive vectors against React, Svelte, Vue, Solid, and Angular.
- Missing framework coverage fails the release gate.

Test vectors: TV-ADAPT-001

Notes: Adapter kit MUST NOT expose end-user UI components.

### ADAPT-002

Priority: P0

Statement: `@uifn/react` MUST expose idiomatic React hooks, compound components, and headless prop getters for all primitives.

Rationale: React consumers need both app-ready components and custom design-system APIs.

Acceptance criteria:

- Every primitive has hook and component APIs.
- Components support `asChild` or equivalent slot composition where semantically valid.
- Hooks expose typed prop getters.
- React SSR and hydration tests pass.

Test vectors: TV-ADAPT-002

Notes: React implementation MAY use JSX and React context.

### ADAPT-003

Priority: P0

Statement: `@uifn/svelte` MUST expose idiomatic Svelte components, actions, snippets, and context APIs for all primitives.

Rationale: Svelte consumers should not be forced into React-style composition.

Acceptance criteria:

- Every primitive has component and headless action APIs.
- Context ownership is explicit and errors when parts are used outside roots.
- Svelte 5 runes/snippet compatibility is verified.
- SSR and hydration tests pass.

Test vectors: TV-ADAPT-003

Notes: Legacy Svelte compatibility is undefined.

### ADAPT-004

Priority: P0

Statement: `@uifn/vue` MUST expose idiomatic Vue composables, components, provide/inject context, and scoped slot APIs for all primitives.

Rationale: Vue consumers need composable-first APIs and component convenience.

Acceptance criteria:

- Every primitive has composable and component APIs.
- Props and emits are typed.
- Provide/inject context errors when parts are used outside roots.
- SSR and hydration tests pass.

Test vectors: TV-ADAPT-004

Notes: Vue support is first-class in SFN-15, not experimental.

### ADAPT-005

Priority: P0

Statement: `@uifn/solid` MUST expose idiomatic Solid signals, prop getters, context, and JSX components for all primitives.

Rationale: Solid should receive native fine-grained reactivity rather than React-like wrappers.

Acceptance criteria:

- Every primitive has signal-based headless API and JSX component API.
- Prop getters are callable and reactive.
- SSR tests pass.
- Conformance harness passes for every primitive.

Test vectors: TV-ADAPT-005

Notes: Solid support MUST be public and documented.

### ADAPT-006

Priority: P0

Statement: `@uifn/angular` MUST expose standalone Angular directives first and components second for all primitives.

Rationale: Angular primitive composition is most idiomatic as directives with explicit bindings and outputs.

Acceptance criteria:

- Every primitive has standalone directive APIs.
- Component wrappers exist for common usage.
- Two-way bindings and output events are typed.
- Angular SSR and hydration tests pass where framework support allows.

Test vectors: TV-ADAPT-006

Notes: Angular support MUST NOT imitate React compound components.

### STYLE-001

Priority: P0

Statement: `@uifn/tokens` MUST define a W3C Design Tokens-style schema with semantic public token names.

Rationale: Wider adoption depends on understandable semantic tokens rather than project-specific or cryptic shorthand.

Acceptance criteria:

- Token JSON validates with `$type` and `$value`.
- Public tokens use semantic names such as `surface.canvas`, `text.primary`, and `accent.solid`.
- Cryptic aliases are not required for public use.
- Schema rejects unknown required token groups.

Test vectors: TV-STYLE-001

Notes: Generated aliases MAY exist for internal compiled output.

### STYLE-002

Priority: P0

Statement: `@uifn/theme` MUST mount runtime CSS variables as the source of truth for themes.

Rationale: CSS variables support non-Tailwind consumers, runtime theme switching, scoped themes, and framework neutrality.

Acceptance criteria:

- Theme provider can mount variables globally or into a scoped root.
- Light, dark, high-contrast light, and high-contrast dark first-party themes exist.
- Theme switching does not require rebuilding Tailwind.
- Mounted variables avoid app- or product-specific names.

Test vectors: TV-STYLE-002

Notes: Shadow-root mounting SHOULD be supported.

### STYLE-003

Priority: P0

Statement: Token generation MUST use OKLCH ramps and automated contrast validation for foreground/background pairs.

Rationale: Arbitrary brand hues and custom surfaces need predictable perceptual ramps and accessibility guarantees.

Acceptance criteria:

- Custom hue generation accepts OKLCH inputs or converts supported color inputs to OKLCH.
- Text/background token pairs meet WCAG AA unless marked decorative.
- Accent contrast tokens are computed per theme.
- Release gate fails on invalid contrast.

Test vectors: TV-STYLE-003

Notes: Decorative exceptions MUST be explicit in token metadata.

### STYLE-004

Priority: P0

Statement: Styled APIs MUST support both semantic surfaces and numeric `surfaceDepth`.

Rationale: Semantic surfaces are easier for public users, while depth remains useful for layered UI recipes.

Acceptance criteria:

- Components accept semantic surface props where applicable.
- Recipes accept `{ depth: number }` where applicable.
- Excessive or unsupported depth values fail validation.
- Documentation recommends semantic surface names for most public usage.

Test vectors: TV-STYLE-004

Notes: `surfaceDepth` is public, not a legacy alias.

### STYLE-005

Priority: P0

Statement: `@uifn/theme-tailwind` MUST generate Tailwind preset/plugin output from token and recipe contracts.

Rationale: Tailwind support is important, but Tailwind must not be the design system source of truth.

Acceptance criteria:

- Tailwind colors reference CSS variables.
- Generated utilities are statically discoverable.
- Dynamic class strings that Tailwind cannot detect are rejected.
- Tailwind integration is optional for consumers.

Test vectors: TV-STYLE-005

Notes: Tailwind v3 and v4 support SHOULD be specified during implementation.

### STYLE-006

Priority: P0

Statement: `@uifn/recipes` MUST emit class names, CSS variables, inline style objects, and data attributes.

Rationale: Recipe output must work across Tailwind, plain CSS, CSS Modules, Angular templates, and internal design systems.

Acceptance criteria:

- Every recipe returns `className`, `style`, `vars`, and `data`.
- Recipes use static class tokens.
- Hover effects are explicit recipe options.
- `tint` is the default hover effect and `stripe` is optional.

Test vectors: TV-STYLE-006

Notes: Recipes MUST NOT require Tailwind at runtime.

### COMP-001

Priority: P0

Statement: `@uifn/components` MUST provide all base components listed in the Coss UI docs snapshot.

Rationale: The user explicitly requested full Coss catalog coverage as the capability target.

Acceptance criteria:

- All 45 components are represented in the component catalog.
- Both hooks are represented in the hook catalog.
- Each component has package import and source-installable registry entries for every supported framework where applicable.
- Missing catalog entries fail the release gate.

Test vectors: TV-CATALOG-001

Notes: Coss is a capability target only.

### COMP-002

Priority: P0

Statement: Every styled component MUST expose consistent anatomy, variants, states, tokens, stories, tests, and unstyled escape hatches.

Rationale: Production consumers need both opinionated defaults and design-system control.

Acceptance criteria:

- Component part names match the component manifest.
- Components expose `unstyled`, `className`, part class/style overrides, and recipe props.
- Components expose loading, disabled, invalid, focus-visible, active, and selected states where semantically valid.
- Storybook stories cover default, variants, states, accessibility, and theming.

Test vectors: TV-COMP-001

Notes: Exact prop naming MUST be normalized across frameworks where framework syntax allows.

### COMP-003

Priority: P0

Statement: Data-rich components MUST define deterministic data, keyboard, virtualization, and empty/error/loading behavior.

Rationale: Components such as Data Table, Command, Calendar, Date Picker, Sidebar, and Resizable carry more behavior risk than simple display components.

Acceptance criteria:

- Data Table supports sorting, filtering, selection, pagination, loading, empty, error, and large-data scenarios.
- Calendar and Date Picker support locale, keyboard navigation, min/max, disabled dates, and controlled values.
- Sidebar supports responsive collapse and keyboard navigation.
- Resizable supports pointer and keyboard resizing with min/max constraints.

Test vectors: TV-COMP-002

Notes: Implementation MAY use proven open-source libraries only when license and adapter requirements are compatible and the code is not copied into clean-room internals.

### HOOK-001

Priority: P0

Statement: `uifn` MUST provide `useMediaQuery` and `useCopyToClipboard` equivalents across supported frameworks.

Rationale: The Coss target includes hooks, and framework consumers expect idiomatic helper APIs.

Acceptance criteria:

- Hooks/composables/actions/services exist for React, Svelte, Vue, Solid, and Angular.
- SSR-safe fallback behavior is documented and tested.
- Clipboard failure behavior is explicit.
- Media query subscriptions clean up on unmount/destroy.

Test vectors: TV-HOOK-001

Notes: Angular MAY expose injectable services plus directives.

### REG-001

Priority: P0

Statement: Every public artifact MUST have a registry manifest with ownership, status, framework support, dependencies, stories, tests, and source policy.

Rationale: The registry manifest is the source of truth for Storybook, docs, source install, lifecycle, and Bit-like metadata.

Acceptance criteria:

- Manifest schema validates all artifacts.
- Manifests include owner, status, dependencies, framework support, and tests.
- Dependency graph can be computed from manifests.
- Missing required metadata fails the release gate.

Test vectors: TV-REG-001

Notes: Manifest fields MUST be documented.

### REG-002

Priority: P0

Statement: The `uifn` CLI MUST support both package import guidance and source installation for components, patterns, and Superfunction-backed variants.

Rationale: Public consumers need package imports, while app teams often need source-owned shadcn-style code.

Acceptance criteria:

- `uifn add` writes source files, stories, fixtures, tests, manifest, and lock entries.
- `uifn info` prints package import instructions.
- `uifn diff` reports local modifications.
- Unsupported framework requests fail before writing files.

Test vectors: TV-REG-002

Notes: CLI implementation MAY live inside `@uifn/registry`.

### STORY-001

Priority: P0

Statement: `@uifn/storybook` MUST provide the consumer-facing workshop, docs, fixtures, decorators, and compatibility panels.

Rationale: Storybook is the best surface for isolated inspection, review, docs, and interaction testing.

Acceptance criteria:

- Preset includes theme, density, locale, auth/session mock, viewport, a11y, and Superfunction mock decorators.
- Stories can be generated or validated from manifests.
- Compatibility panel shows version, status, dependencies, framework support, and backing.
- Storybook is optional for runtime consumers but required for release validation.

Test vectors: TV-STORY-001

Notes: Storybook is not the sole source of truth.

### STORY-002

Priority: P0

Statement: Stories MUST be reusable as interaction, accessibility, and visual test cases.

Rationale: Stories should double as executable documentation and browser-level verification.

Acceptance criteria:

- Stories include args/controls for public props.
- Interaction stories verify user workflows.
- A11y checks run against story states.
- Visual snapshots run across theme and viewport matrix.

Test vectors: TV-STORY-002

Notes: Unit tests remain required for core and adapter behavior.

### PAT-001

Priority: P0

Statement: `@uifn/patterns` MUST provide controlled, backend-agnostic product patterns.

Rationale: Product teams need reusable UI flows that do not force Superfunction clients.

Acceptance criteria:

- Patterns accept explicit data, callbacks, and status props.
- Patterns do not import Superfunction clients.
- Patterns have source-installable registry entries.
- Patterns have fixtures for loading, empty, error, partial, and success states.

Test vectors: TV-PAT-001

Notes: Patterns MAY reuse base components.

### SF-001

Priority: P0

Statement: `@uifn/sf` MUST provide Superfunction-backed variants that require injected client contracts.

Rationale: Superfunctions should provide ready-to-use panels while remaining app-composable and testable.

Acceptance criteria:

- Backed variants require explicit client props.
- Client contracts are typed and mockable.
- Loading, empty, error, optimistic, partial, and success states are exposed.
- Backed variants never read app-global singletons.

Test vectors: TV-SF-001

Notes: Client adapters MUST be narrow and documented.

### SF-002

Priority: P0

Statement: Phase-one Superfunction-backed panels MUST cover `authfn`, `plugfn`, `filefn`, and `billfn`.

Rationale: These are the default panels approved by the user.

Acceptance criteria:

- `authfn`: auth panel and API key table.
- `plugfn`: provider picker and OAuth connections panel.
- `filefn`: file upload/dropzone panel.
- `billfn`: billing plan cards and subscription status panel.
- Each backed panel has a controlled pattern counterpart.

Test vectors: TV-SF-002

Notes: Additional Superfunctions MAY be added after these pass.

### TEST-001

Priority: P0

Statement: `uifn` MUST provide a production release gate that validates packages, manifests, registry, stories, tests, and docs.

Rationale: Production readiness must be machine-verifiable.

Acceptance criteria:

- Release gate runs build, lint, typecheck, unit tests, conformance tests, a11y tests, interaction tests, visual tests, SSR tests, pack checks, export-map checks, and manifest checks.
- Gate emits JSON output.
- Gate fails on missing framework coverage.
- Gate fails on stale docs or registry metadata.

Test vectors: TV-RELEASE-001

Notes: The current dry-run/full-gate split MAY be replaced.

### TEST-002

Priority: P0

Statement: Accessibility and visual regression gates MUST block GA release.

Rationale: UI infrastructure cannot be considered production-ready without accessibility and visual guarantees.

Acceptance criteria:

- WCAG AA checks cover public story states.
- Keyboard navigation tests cover all interactive primitives.
- Visual matrix covers light, dark, high-contrast light, high-contrast dark, mobile, tablet, desktop, and reduced motion.
- Failures include component, story, theme, viewport, and framework metadata.

Test vectors: TV-RELEASE-002

Notes: Decorative contrast exceptions require metadata.

### DOCS-001

Priority: P0

Statement: Documentation MUST be generated or validated from manifests, stories, tokens, recipes, and package exports.

Rationale: Docs must stay synchronized with shipped APIs and registry metadata.

Acceptance criteria:

- Docs list all components, hooks, patterns, and supported frameworks.
- Docs include package import and source install instructions.
- Docs include token and recipe usage.
- Docs generation rejects local absolute paths.

Test vectors: TV-DOCS-001

Notes: Manual prose MAY exist but cannot contradict manifests.

### SEC-001

Priority: P0

Statement: `uifn` MUST enforce secret and privacy boundaries in Superfunction-backed panels, Storybook mocks, CLI logs, and release output.

Rationale: UI tooling often touches auth, OAuth, file upload, and billing data.

Acceptance criteria:

- No logs include secrets, tokens, upload URLs, raw files, PII payloads, local absolute paths, hostnames, or usernames.
- Storybook uses fake credentials and fake tenants.
- CLI checksum and install errors redact sensitive paths and values.
- Superfunction-backed panels receive clients and data explicitly.

Test vectors: TV-SEC-001

Notes: Sanitized repository-relative paths are allowed.

### VER-001

Priority: P0

Statement: SFN-15 implementation MUST remove legacy scaffolding and may make breaking changes before GA.

Rationale: The user explicitly confirmed no one is using `uifn` yet and asked to avoid backward compatibility and legacy scaffolding.

Acceptance criteria:

- Deprecated compatibility APIs are removed rather than preserved.
- Package docs do not promise compatibility with pre-SFN-15 APIs.
- After GA, semantic versioning rules are documented.
- Registry diff tooling helps source-installed consumers after GA.

Test vectors: TV-VER-001

Notes: Existing package names SHOULD be preserved when they align with the target architecture.


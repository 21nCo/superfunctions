# SFN-15 Specification

## Metadata

| Field | Value |
| --- | --- |
| timestamp | 2026-06-27T14:49:46Z |
| agent_name | Codex |
| model | GPT-5 Codex |
| launcher | Codex Desktop |
| workspace | repo root |
| OS | Darwin arm64 |
| shell | zsh |
| git branch | SFN-15 |
| git commit | 9cf38123 |
| git dirty status | clean at spec start; generated spec artifacts are new changes |
| spec_folder | SFN-15 |
| spec path | uifn/.conduct/SFN-15 |
| spec_type | new |
| spec_id | SFN-15 |
| input paths | user prompt; sanitized side-chat attachment: Storybook and Bit ideation; sanitized side-chat attachment: styling system ideation |
| external references | https://coss.com/ui/docs, https://storybook.js.org/docs, https://bit.dev/docs |

## Overview

SFN-15 MUST make `uifn` production-ready as a clean-room, cross-framework UI system for the Superfunctions stack and external adopters. The system MUST preserve a layered model:

1. behavior primitives in `@uifn/core`,
2. shared adapter utilities in `@uifn/adapter-kit`,
3. unstyled framework adapters for React, Svelte, Vue, Solid, and Angular,
4. semantic tokens, runtime themes, Tailwind generation, and recipes,
5. styled base components covering the Coss UI catalog,
6. composed patterns and Superfunction-backed panels,
7. a registry and CLI for package import and source installation,
8. Storybook as the consumer-facing workshop, documentation, and test surface.

Coss UI is a capability reference only. Implementations MUST be clean-room and MUST NOT copy Coss source code, prose, assets, examples, or private implementation details.

## Glossary

- Adapter: framework-specific API that exposes core behavior through native framework composition.
- Adapter kit: shared utilities and conformance harness used by every adapter.
- Base component: styled component such as Button, Dialog, Table, or Sidebar.
- Behavior controller: framework-agnostic object returned by `@uifn/core` that owns state, actions, part props, and accessibility semantics.
- Clean-room implementation: implementation based on public capability requirements and platform standards, not copied source.
- Component manifest: JSON metadata describing a primitive, component, pattern, or Superfunction-backed artifact.
- Framework-native composition: idiomatic API for each framework, such as React hooks, Svelte actions/snippets, Vue composables, Solid signals, and Angular directives.
- Pattern: composed UI/product flow that can run with controlled data and without required backend binding.
- Recipe: typed style function that maps semantic props to CSS classes, CSS variables, inline style objects, and Tailwind-safe static classes.
- Registry item: source-installable component/pattern package with manifest, files, stories, fixtures, tests, and dependencies.
- Superfunction-backed pattern: pattern wired to an injected Superfunction client contract, such as `authfn`, `plugfn`, `filefn`, or `billfn`.
- Token: semantic design value such as `surface.canvas`, `text.primary`, `accent.solid`, `radius.md`, or `motion.duration.fast`.

## Goals

- `uifn` MUST support React, Svelte, Vue, Solid, and Angular as first-class framework targets.
- `uifn` MUST provide all base components currently listed in the Coss UI docs snapshot:
  Accordion, Alert Dialog, Aspect Ratio, Avatar, Badge, Breadcrumb, Button, Calendar, Card, Checkbox, Collapsible, Command, Context Menu, Data Table, Date Picker, Dialog, Dropdown Menu, Form, Hover Card, Input, Input OTP, Label, Menubar, Pagination, Popover, Progress, Radio Group, Resizable, Scroll Area, Select, Separator, Sheet, Sidebar, Skeleton, Slider, Sonner, Switch, Table, Tabs, Textarea, Toast, Toggle, Toggle Group, Tooltip, Typography, plus `useMediaQuery` and `useCopyToClipboard`.
- `uifn` MUST support both package imports and source installation.
- `uifn` MUST expose a CSS-variable/design-token-first styling system and generate Tailwind integration from that contract.
- `uifn` MUST use Storybook as the consumer-facing workshop/test/docs surface.
- `uifn` MUST borrow Bit-like metadata concepts for ownership, dependency graph, component versioning, isolated previews, and lifecycle status without requiring Bit.
- `uifn` MUST provide headless patterns and Superfunction-backed variants for `authfn`, `plugfn`, `filefn`, and `billfn`.
- `uifn` MAY make breaking changes to current package internals and public APIs because no external consumers are assumed.

## Non-goals

- `uifn` MUST NOT preserve legacy scaffolding, compatibility aliases, or deprecated APIs unless explicitly required by this spec.
- `uifn` MUST NOT expose product-specific package names, token names, theme names, or migration wrappers.
- `uifn` MUST NOT make Tailwind a hard runtime requirement.
- `uifn` MUST NOT make Bit a required toolchain.
- `uifn` MUST NOT treat Storybook stories as the only source of truth.
- `uifn` MUST NOT implement Coss internals or copy Coss code.

## Package Architecture

The target public package set is:

```txt
@uifn/core
@uifn/adapter-kit
@uifn/react
@uifn/svelte
@uifn/vue
@uifn/solid
@uifn/angular
@uifn/tokens
@uifn/theme
@uifn/theme-tailwind
@uifn/recipes
@uifn/components
@uifn/patterns
@uifn/sf
@uifn/registry
@uifn/storybook
```

Each package MUST have a precise support status:

- GA candidates: `core`, `adapter-kit`, `tokens`, `theme`, `theme-tailwind`, `recipes`, `react`, `svelte`, `vue`, `solid`, `angular`, `components`, `registry`, `storybook`.
- Beta candidates until Superfunction client contracts stabilize: `patterns`, `sf`.

Support status MUST be declared in package manifests and registry manifests. A package MUST NOT claim GA unless its release gate passes.

## Public API

### Core Behavior Controllers

`@uifn/core` MUST expose behavior controllers rather than framework components.

```ts
export interface UIFnEnvironment {
  document?: Document;
  window?: Window;
  direction?: "ltr" | "rtl";
  locale?: string;
  reducedMotion?: boolean;
  now?: () => number;
  generateId?: (scope: string) => string;
}

export interface UIFnPartProps {
  role?: string;
  id?: string;
  tabIndex?: number;
  aria?: Record<string, string | boolean | number | undefined>;
  data?: Record<string, string | boolean | number | undefined>;
  style?: Record<string, string | number>;
  on?: Record<string, UIFnEventHandler>;
}

export interface UIFnPartController<UserProps = unknown> {
  part: string;
  getProps(userProps?: UserProps): UIFnPartProps;
}

export interface UIFnController<State, Actions, Parts extends Record<string, UIFnPartController>> {
  readonly state: State;
  readonly actions: Actions;
  readonly parts: Parts;
  getState(): State;
  subscribe(callback: (state: State, meta?: UIFnChangeMeta) => void): () => void;
  destroy(): void;
}
```

Every primitive MUST expose a `createXController(config, env?)` function. Existing `createX` names MAY be replaced if needed for consistency; compatibility shims are not required.

### Framework Adapter APIs

Every framework adapter MUST expose:

1. a component API for normal app usage,
2. a headless attachment API for custom design systems,
3. a conformance test adapter that can run shared test vectors.

React MUST expose hooks plus compound components:

```tsx
const dialog = useDialog(options);
<button {...dialog.triggerProps}>Open</button>
<Dialog.Root>
  <Dialog.Trigger asChild>Open</Dialog.Trigger>
  <Dialog.Content>...</Dialog.Content>
</Dialog.Root>
```

Svelte MUST expose components plus actions/snippets:

```svelte
<Dialog let:api>
  <button use:api.trigger>Open</button>
  <section use:api.content>...</section>
</Dialog>
```

Vue MUST expose composables plus components and scoped slots:

```vue
<script setup>
const dialog = useDialog()
</script>
<button v-bind="dialog.triggerProps">Open</button>
```

Solid MUST expose signals, prop getters, context, and JSX components:

```tsx
const dialog = createDialog();
<button {...dialog.triggerProps()}>Open</button>
```

Angular MUST expose standalone directives first and components second:

```html
<uifn-dialog [(open)]="open">
  <button uifnDialogTrigger>Open</button>
  <section uifnDialogContent>...</section>
</uifn-dialog>
```

### Styling APIs

`@uifn/tokens` MUST own token schema and token validation. `@uifn/theme` MUST own runtime CSS variable mounting and theme context. `@uifn/theme-tailwind` MUST generate Tailwind preset/plugin output from tokens. `@uifn/recipes` MUST own typed recipe functions.

Public token names MUST be semantic:

```ts
surface.canvas
surface.raised
surface.overlay
text.primary
text.muted
border.subtle
accent.solid
accent.contrast
danger.solid
```

Recipe APIs MUST support semantic surfaces and numeric depth:

```ts
surface("raised")
surface({ depth: 2 })
surfaceHover({ surface: "raised", effect: "tint" })
surfaceHover({ depth: 1, effect: "stripe" })
activeSurface({ tone: "accent" })
customSurface({ hue: 240, contrast: "auto" })
buttonRecipe({ variant: "primary", size: "md" })
```

Recipes MUST output multiple targets:

```ts
type RecipeResult = {
  className: string;
  style: Record<string, string | number>;
  vars: Record<`--uifn-${string}`, string>;
  data: Record<string, string | boolean | number>;
};
```

### Components API

`@uifn/components` MUST expose framework-specific entry points:

```ts
@uifn/components/react
@uifn/components/svelte
@uifn/components/vue
@uifn/components/solid
@uifn/components/angular
```

Every styled component MUST provide:

- controlled and uncontrolled state when stateful,
- part-level styling hooks,
- `unstyled` escape hatch,
- semantic variants,
- accessibility labels and error reporting,
- Storybook stories,
- manifest metadata,
- package import and source-installable registry form.

### Registry and CLI API

`@uifn/registry` MUST ship a `uifn` CLI binary or integrate with the Superfunctions CLI under the same command namespace.

```bash
uifn list
uifn info button
uifn add button --framework react
uifn add auth-panel --framework svelte --sf authfn
uifn diff
uifn update button
```

The CLI MUST support source installation and MUST write a lock file in consuming repos.

### Patterns and Superfunction API

`@uifn/patterns` MUST expose controlled patterns with data passed in by the caller. `@uifn/sf` MUST expose Superfunction-backed variants that require injected clients.

```tsx
<ApiKeyTable keys={keys} onCreate={createKey} onRevoke={revokeKey} />
<AuthFnApiKeyTable authClient={authClient} />

<ProviderPicker providers={providers} selected={selected} onSelect={setSelected} />
<PlugFnOAuthConnectionsPanel plugClient={plugClient} />
```

Superfunction-backed patterns MUST NOT import app-global singletons.

## Data Formats

### Component Manifest

Every primitive, component, pattern, and Superfunction-backed pattern MUST have a manifest:

```json
{
  "schemaVersion": 1,
  "name": "Button",
  "kind": "component",
  "status": "stable",
  "frameworks": ["react", "svelte", "vue", "solid", "angular"],
  "imports": {
    "package": "@uifn/components/react",
    "source": "registry/components/button/react"
  },
  "dependencies": ["@uifn/core", "@uifn/recipes"],
  "backing": [],
  "owners": ["platform-ui"],
  "tokens": ["surface", "text", "border", "accent", "radius", "motion"],
  "tests": ["render", "a11y", "interaction", "visual", "ssr", "pack"],
  "stories": ["default", "variants", "states", "accessibility"],
  "sourcePolicy": "clean-room"
}
```

### Theme Token File

Theme files MUST use a W3C Design Tokens-style JSON shape with `@type`, `$value`, and optional metadata:

```json
{
  "$schema": "https://uifn.dev/schemas/tokens.schema.json",
  "name": "uifn-light",
  "mode": "light",
  "tokens": {
    "color": {
      "surface": {
        "canvas": { "$type": "color", "$value": "oklch(98% 0.01 250)" }
      },
      "text": {
        "primary": { "$type": "color", "$value": "oklch(20% 0.02 250)" }
      }
    }
  }
}
```

### Registry Lock

Consuming repos MUST receive a lock file:

```json
{
  "schemaVersion": 1,
  "registry": "https://uifn.dev/registry",
  "items": {
    "button": {
      "version": "0.1.0",
      "framework": "react",
      "mode": "source",
      "files": ["components/ui/button.tsx", "components/ui/button.stories.tsx"],
      "checksum": "sha256-placeholder"
    }
  }
}
```

## Semantics

### Behavior Semantics

Core controllers MUST define state, actions, part anatomy, ARIA attributes, data attributes, keyboard behavior, controlled/uncontrolled rules, disabled behavior, focus behavior, portal behavior, and positioning intent.

Adapters MUST map those semantics into framework-native APIs without changing behavior.

### Styling Semantics

CSS variables MUST be the runtime source of truth. Tailwind classes MUST be generated from variables and known static selectors. Dynamic Tailwind class generation that cannot be statically discovered MUST NOT be used.

Themes MUST include:

- `uifn-light`,
- `uifn-dark`,
- `uifn-high-contrast-light`,
- `uifn-high-contrast-dark`,
- generated custom brand themes.

Custom hues MUST use OKLCH ramps and MUST be contrast-checked.

### Component Semantics

Base components MUST be consistent across frameworks in:

- component names,
- part names,
- data attributes,
- accessibility contract,
- keyboard behavior,
- state names,
- design token usage,
- Storybook state coverage,
- registry metadata.

Framework API syntax MAY vary to remain idiomatic.

### Pattern Semantics

Headless patterns MUST accept explicit data and callbacks. Superfunction-backed variants MUST accept injected clients and MUST expose loading, error, empty, partial, and optimistic states.

## Invariants

- Coss catalog coverage MUST remain explicit and testable.
- Public behavior MUST be deterministic for the same props, environment, and user events.
- Id generation MUST be deterministic in tests when `env.generateId` is supplied.
- CSS variable names MUST remain stable within a major version.
- Component manifests MUST be the source of truth for ownership, status, dependencies, framework coverage, and test coverage.
- Accessibility failures MUST block GA release.
- Token contrast failures MUST block GA release unless the token pair is explicitly marked decorative.
- Source-installed files MUST include provenance and checksums.
- No artifact generated by this spec or its implementation MUST contain local absolute machine paths.

## Security

- Superfunction-backed patterns MUST use injected clients and MUST NOT read secrets from globals, local storage, process environment, or undocumented app state.
- Storybook mocks MUST use fake tokens and fake tenant identifiers.
- Registry manifests MUST NOT include private package credentials.
- CLI installs MUST validate checksums before writing files.
- Logs MUST NOT include API keys, OAuth tokens, upload URLs, PII payloads, or raw file contents.

## Limits and Caps

- Component manifests SHOULD remain under 128 KB.
- Registry lock files SHOULD remain under 1 MB for normal apps.
- Data Table examples SHOULD include virtualization test coverage for 10,000 rows.
- Sidebar and Command examples SHOULD include keyboard navigation coverage for at least 100 items.
- Default visual regression matrix MUST cover light, dark, high contrast, mobile, tablet, desktop, and reduced motion.

## Observability

Release gates MUST emit machine-readable JSON summaries. The CLI MUST emit structured diagnostics for install, update, diff, validation, and checksum failures. Storybook MUST expose a compatibility panel showing component version, status, dependencies, framework support, and Superfunction backing.

Observability MUST NOT expose secrets, raw credentials, full local paths, hostnames, usernames, or private tenant data.

## Compatibility and Versioning

Because no external consumers are assumed, SFN-15 MAY break existing `uifn` APIs. The implementation SHOULD remove legacy scaffolding instead of preserving aliases. After SFN-15 GA, public packages MUST follow semantic versioning and MUST provide registry diff tooling for source-installed components.

## Undefined / Explicitly User-Deferred Only

- Web Components are undefined for SFN-15.
- Native mobile adapters are undefined for SFN-15.
- Bit platform publishing is undefined for SFN-15.
- Product-specific theme packages, compatibility packages, and migration wrappers are explicitly out of scope.
- Copying code from Coss UI, shadcn, Radix UI, Base UI, Storybook, or Bit is out of scope.

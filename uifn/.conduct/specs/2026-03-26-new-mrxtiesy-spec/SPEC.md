# Metadata

- Timestamp: `2026-03-26T05:48:27Z`
- Agent name: `spec`
- Model: `unknown`
- Launcher: `Codex Desktop`
- Workspace/project absolute path: `/Users/serro/.codex/worktrees/ef26/superfunctions/uifn`
- OS + shell: `Darwin 25.3.0 arm64`, shell `/bin/zsh`
- Repo metadata: git repo detected at `/Users/serro/.codex/worktrees/ef26/superfunctions`; branch `HEAD (detached)`; commit `ca86e25e6faf11da93e390c18dad8ae5f22b6f69`; dirty worktree `no`
- Spec folder name: `2026-03-26-new-mrxtiesy-spec`
- Spec folder path: `/Users/serro/.codex/worktrees/ef26/superfunctions/uifn/.conduct/specs/2026-03-26-new-mrxtiesy-spec`
- Spec type: `new`
- Spec id: `mrxtiesy`
- Input paths read:
  - `/Users/serro/.codex/worktrees/ef26/superfunctions/AGENTS.md`
  - `/Users/serro/.codex/worktrees/ef26/superfunctions/package.json`
  - `/Users/serro/.codex/worktrees/ef26/superfunctions/turbo.json`
  - `/Users/serro/.codex/worktrees/ef26/superfunctions/uifn/README.md`
  - `/Users/serro/.codex/worktrees/ef26/superfunctions/uifn/SPEC.md`
  - `/Users/serro/.codex/worktrees/ef26/superfunctions/uifn/core/package.json`
  - `/Users/serro/.codex/worktrees/ef26/superfunctions/uifn/react/package.json`
  - `/Users/serro/.codex/worktrees/ef26/superfunctions/uifn/svelte/package.json`
  - `/Users/serro/.codex/worktrees/ef26/superfunctions/uifn/vue/package.json`
  - `/Users/serro/.codex/worktrees/ef26/superfunctions/uifn/react/README.md`
  - `/Users/serro/.codex/worktrees/ef26/superfunctions/uifn/svelte/README.md`
  - `/Users/serro/.codex/worktrees/ef26/superfunctions/uifn/vue/README.md`
  - `/Users/serro/.codex/worktrees/ef26/superfunctions/docsfn/examples/README.md`
  - `/Users/serro/.codex/worktrees/ef26/superfunctions/docsfn/examples/next-docs-site/package.json`
  - `/Users/serro/.codex/worktrees/ef26/superfunctions/datafn/examples/sharing-app/package.json`
  - `/Users/serro/.codex/worktrees/ef26/superfunctions/uifn/.conduct/specs/2026-03-20-audit-fix-dhrtycgi-spec/SPEC.md`
  - `Conversation intent in the current Codex thread (no filesystem path)`

# Overview

Project name: `uifn`

One-sentence goal: Define the complete implementation contract for adding private, deterministic, Vite-based example apps under `uifn/examples/*` with a shared scenario kit, React and Svelte canonical playgrounds, a truthfully labeled experimental Vue playground, documentation, and local verification.

Target users:

- Frontend engineers evaluating `@uifn/*` primitives in realistic app-like compositions
- Maintainers of the `uifn` package family who need stable local demo surfaces
- QA and documentation contributors validating adapter parity and accessibility behavior

Target environments:

- Monorepo workspace execution from the repository root on macOS/Linux developer machines
- Node.js `18.x`, `20.x`, and `22.x`
- Evergreen browsers supported by `uifn`: Chrome, Edge, Firefox, and Safari
- Framework runtimes:
  - React `18.2+`
  - Svelte `5.x`
  - Vue `3.5+` as experimental-only in this bundle
- Offline/local-only development and verification; no remote services are required

Languages/packages required:

- TypeScript for shared example data and the React/Vue playgrounds
- Svelte for the Svelte playground
- Vite-based app scaffolding for React, Svelte, and Vue
- npm workspaces and Turbo-compatible package scripts

Existing systems it must integrate with:

- Root monorepo workspace rules in `/Users/serro/.codex/worktrees/ef26/superfunctions/package.json`
- Current `uifn` package family and support matrix in `/Users/serro/.codex/worktrees/ef26/superfunctions/uifn/README.md`
- Existing `uifn` package-level release gate at `/Users/serro/.codex/worktrees/ef26/superfunctions/scripts/verify-uifn-release.mjs`
- Existing example conventions in `docsfn/examples` and `datafn/examples`

Data model summary:

- No persistent backend data model is required
- Shared example data consists of deterministic scenario definitions, capability support records, and fixture datasets consumed by all example apps

Security model:

- No authentication or authorization layer exists
- Examples MUST operate without secrets, tokens, or remote fetches
- Example apps MUST NOT emit analytics, telemetry, or background network traffic

Performance constraints:

- All example apps MUST build locally with standard Vite production builds
- Shared fixtures MUST remain small enough to load instantly during local navigation
- Virtualized example rendering MUST demonstrate non-full-mount behavior only in adapters that support `VirtualizedList`

Assumptions:

- Assumption A1: Example apps are reference/developer tooling only and MUST remain `private: true`.
- Assumption A2: The first complete bundle uses Vite-based client-side apps only; SSR-specific example apps are not part of this change.
- Assumption A3: `@uifn/files` does not require an example app in this bundle because the user request and proposed approach centered on adapter playgrounds for React, Svelte, and Vue.
- Assumption A4: Example-app verification is separate from the publish-focused `verify:uifn-release` gate, but it MAY share helper conventions and shell usage.

# Glossary

- Example hub: The private runner workspace at `uifn/examples` that owns human-facing commands and shared verification entry points.
- Shared example package: The private workspace at `uifn/examples/shared` that exports scenario definitions, capability metadata, and deterministic fixtures.
- Playground: A framework-specific example app workspace that renders the shared scenarios using one adapter.
- Canonical adapter playground: A playground for a GA adapter. In this spec, React and Svelte are canonical.
- Experimental adapter playground: A playground for an adapter that is public but not GA. In this spec, Vue is experimental.
- Scenario: A named, ordered, app-like demo flow rendered by every playground according to support rules.
- Capability: A primitive family or helper surface, such as `dialog`, `combobox`, or `virtualized-list`, that a scenario exercises.
- Capability matrix: The normalized table that states whether a capability is supported, unsupported, or intentionally unavailable for a given adapter playground.
- Unsupported view: The stable UI state shown when a valid scenario route is requested for an adapter that does not support one or more required capabilities.
- Verification summary: The canonical JSON envelope emitted by `verify:uifn-examples`.

# Goals / Non-goals

Goals:

- Add a clean `uifn/examples/*` workspace area without polluting the published `@uifn/*` package surface.
- Provide realistic, scenario-driven example apps instead of a component zoo.
- Guarantee a shared scenario registry and shared fixture data across adapters.
- Deliver first-class React and Svelte playgrounds because those adapters are GA.
- Deliver a Vue playground that is explicitly marked experimental and that truthfully handles unsupported capabilities.
- Keep example verification local, deterministic, and independent from pack/export-map release checks.
- Update `uifn` documentation so the examples are discoverable and the support story is truthful.

Non-goals:

- This bundle does not publish the example apps to npm.
- This bundle does not create Storybook or a docs-site replacement.
- This bundle does not add SSR-only example apps for Next.js, SvelteKit, or Nuxt.
- This bundle does not add a dedicated `@uifn/files` example app.
- This bundle does not change the runtime API of `@uifn/core`, `@uifn/react`, `@uifn/svelte`, or `@uifn/vue`; it consumes them.

# Public API

## Workspace and package contract

The repository MUST expose the following private example workspaces:

| Directory | Package name | Role | Publishability |
| --- | --- | --- | --- |
| `uifn/examples` | `@uifn/examples` | Runner/README/verification hub | Private only |
| `uifn/examples/shared` | `@uifn/examples-shared` | Shared scenario, fixture, and capability exports | Private only |
| `uifn/examples/react-playground` | `@uifn/example-react-playground` | React adapter playground | Private only |
| `uifn/examples/svelte-playground` | `@uifn/example-svelte-playground` | Svelte adapter playground | Private only |
| `uifn/examples/vue-playground` | `@uifn/example-vue-playground` | Vue adapter playground | Private only |

The root workspace manifest MUST include `uifn/examples/*` in addition to the existing `uifn/*` entry.

## Script contract

The following scripts are part of the public developer contract for the examples bundle:

```ts
type ExampleRootScriptName = "verify:uifn-examples";

type ExampleHubScriptName =
  | "dev:react"
  | "dev:svelte"
  | "dev:vue"
  | "build"
  | "verify";

type ExampleAppScriptName = "dev" | "build" | "preview";
```

Required script behavior:

- Root `package.json` MUST expose `verify:uifn-examples` and delegate to the example hub.
- `uifn/examples/package.json` MUST expose:
  - `dev:react`
  - `dev:svelte`
  - `dev:vue`
  - `build`
  - `verify`
- Each playground package MUST expose:
  - `dev` with a fixed port
  - `build`
  - `preview`

Fixed dev ports:

- React playground: `6111`
- Svelte playground: `6112`
- Vue playground: `6113`

## Shared example module contract

`@uifn/examples-shared` MUST export the following exact TypeScript shapes:

```ts
export type ExampleAdapterId = "react" | "svelte" | "vue";

export type ExampleScenarioId =
  | "settings-console"
  | "team-directory"
  | "command-center"
  | "virtualized-results";

export type ExampleCapabilityId =
  | "dialog"
  | "tabs"
  | "switch"
  | "checkbox"
  | "toast"
  | "avatar"
  | "badge"
  | "dropdown-menu"
  | "popover"
  | "hover-card"
  | "combobox"
  | "select"
  | "scroll-area"
  | "context-menu"
  | "virtualized-list";

export interface ExampleScenarioDefinition {
  id: ExampleScenarioId;
  order: 1 | 2 | 3 | 4;
  title: string;
  description: string;
  supportedAdapters: ExampleAdapterId[];
  requiredCapabilities: ExampleCapabilityId[];
  fixtureKey: "settings" | "team" | "commands" | "results";
}

export interface ExampleCapabilitySupport {
  adapter: ExampleAdapterId;
  capability: ExampleCapabilityId;
  status: "supported" | "unsupported";
  note?: string;
}
```

Canonical scenario definitions:

1. `settings-console`
   - order `1`
   - title `Settings Console`
   - supported adapters `react`, `svelte`, `vue`
   - required capabilities `dialog`, `tabs`, `switch`, `checkbox`, `toast`
2. `team-directory`
   - order `2`
   - title `Team Directory`
   - supported adapters `react`, `svelte`, `vue`
   - required capabilities `avatar`, `badge`, `dropdown-menu`, `popover`, `hover-card`
3. `command-center`
   - order `3`
   - title `Command Center`
   - supported adapters `react`, `svelte`, `vue`
   - required capabilities `combobox`, `select`, `scroll-area`, `context-menu`
4. `virtualized-results`
   - order `4`
   - title `Virtualized Results`
   - supported adapters `react`, `svelte`
   - required capabilities `virtualized-list`, `scroll-area`

## Route contract

Every playground MUST use the same hash-based route contract:

```ts
export type ExampleRouteHash =
  | "#/settings-console"
  | "#/team-directory"
  | "#/command-center"
  | "#/virtualized-results";
```

Route behavior:

- The default route MUST be `#/settings-console`.
- A missing or unknown hash MUST be normalized to `#/settings-console`.
- If a route is valid but unsupported by the current adapter, the app MUST render an unsupported view and MUST NOT crash.

## Verification output envelope

`verify:uifn-examples` MUST emit a deterministic JSON summary using this shape:

```ts
export type ExampleVerificationCheck =
  | "workspace"
  | "manifest"
  | "build"
  | "docs"
  | "offline";

export type ExampleVerificationErrorCode =
  | "EXAMPLE_WORKSPACE_MISSING"
  | "EXAMPLE_SCRIPT_MISSING"
  | "EXAMPLE_CONFIG_ERROR"
  | "EXAMPLE_CAPABILITY_MISMATCH"
  | "EXAMPLE_BUILD_ERROR"
  | "EXAMPLE_DOC_LINK_MISSING"
  | "EXAMPLE_NETWORK_FORBIDDEN";

export interface ExampleVerificationFailure {
  code: ExampleVerificationErrorCode;
  workspace: string;
  detail: string;
}

export interface ExampleVerificationWorkspaceResult {
  name: string;
  adapter: "hub" | "shared" | ExampleAdapterId;
  ok: boolean;
  notes: string[];
}

export interface ExampleVerificationSummary {
  ok: boolean;
  command: "verify:uifn-examples";
  checks: ExampleVerificationCheck[];
  workspaces: ExampleVerificationWorkspaceResult[];
  failures: ExampleVerificationFailure[];
}
```

# Data formats / protocol

## Canonical scenario registry payload

The scenario registry exported from `@uifn/examples-shared` MUST serialize to the following logical payload:

```json
[
  {
    "id": "settings-console",
    "order": 1,
    "title": "Settings Console",
    "description": "Dialog-driven preferences flow with tabs, toggles, checkboxes, and toast feedback.",
    "supportedAdapters": ["react", "svelte", "vue"],
    "requiredCapabilities": ["dialog", "tabs", "switch", "checkbox", "toast"],
    "fixtureKey": "settings"
  },
  {
    "id": "team-directory",
    "order": 2,
    "title": "Team Directory",
    "description": "Profile and actions flow using avatar, badge, menu, popover, and hover-card primitives.",
    "supportedAdapters": ["react", "svelte", "vue"],
    "requiredCapabilities": ["avatar", "badge", "dropdown-menu", "popover", "hover-card"],
    "fixtureKey": "team"
  },
  {
    "id": "command-center",
    "order": 3,
    "title": "Command Center",
    "description": "Filtering and command execution flow using combobox, select, scroll-area, and context-menu primitives.",
    "supportedAdapters": ["react", "svelte", "vue"],
    "requiredCapabilities": ["combobox", "select", "scroll-area", "context-menu"],
    "fixtureKey": "commands"
  },
  {
    "id": "virtualized-results",
    "order": 4,
    "title": "Virtualized Results",
    "description": "Large-result browsing flow proving adapter-level virtualized rendering behavior.",
    "supportedAdapters": ["react", "svelte"],
    "requiredCapabilities": ["virtualized-list", "scroll-area"],
    "fixtureKey": "results"
  }
]
```

## Capability support payload

The capability matrix MUST be derived from normalized `ExampleCapabilitySupport` records. Vue MUST mark `virtualized-list` as `unsupported` with note `VirtualizedList is not exported by @uifn/vue`.

## Verification success payload

```json
{
  "ok": true,
  "command": "verify:uifn-examples",
  "checks": ["workspace", "manifest", "build", "docs", "offline"],
  "workspaces": [
    { "name": "@uifn/examples", "adapter": "hub", "ok": true, "notes": [] },
    { "name": "@uifn/examples-shared", "adapter": "shared", "ok": true, "notes": [] },
    { "name": "@uifn/example-react-playground", "adapter": "react", "ok": true, "notes": [] },
    { "name": "@uifn/example-svelte-playground", "adapter": "svelte", "ok": true, "notes": [] },
    { "name": "@uifn/example-vue-playground", "adapter": "vue", "ok": true, "notes": ["experimental"] }
  ],
  "failures": []
}
```

## Verification failure payload

```json
{
  "ok": false,
  "command": "verify:uifn-examples",
  "checks": ["workspace", "manifest", "build", "docs", "offline"],
  "workspaces": [
    { "name": "@uifn/example-vue-playground", "adapter": "vue", "ok": false, "notes": ["experimental"] }
  ],
  "failures": [
    {
      "code": "EXAMPLE_CAPABILITY_MISMATCH",
      "workspace": "@uifn/example-vue-playground",
      "detail": "virtualized-results route attempted to mount VirtualizedList instead of rendering unsupported view"
    }
  ]
}
```

# Semantics

## Workspace semantics

- The root workspace manifest MUST discover nested example workspaces via `uifn/examples/*`.
- Example packages MUST remain private and MUST NOT be added to publish/release pack lists.
- The existing `verify:uifn-release` gate MUST continue to validate only publishable `uifn` packages.

## Example hub semantics

- `uifn/examples/README.md` MUST be the single human-facing entry point for running example apps.
- `uifn/examples/package.json` MUST provide the canonical dev/build/verify commands so users do not need to memorize workspace names.
- The hub MAY contain helper scripts under `uifn/examples/scripts/`, but those scripts MUST only operate on local workspaces.

## Shared scenario semantics

- Scenario ids, order, titles, and descriptions MUST be defined once in `@uifn/examples-shared` and consumed by every playground.
- Shared fixture data MUST be deterministic, checked into the repository, and free of timestamps/randomized identifiers.
- Capability metadata MUST be the single source of truth for adapter support, including the Vue `virtualized-list` restriction.

## Playground shell semantics

- Every playground MUST render:
  - a top-level app heading,
  - an adapter badge (`React`, `Svelte`, or `Vue Experimental`),
  - a scenario navigation list in canonical order,
  - a capability matrix view,
  - a scenario panel for the current route.
- Every playground MUST use the same scenario titles and descriptive copy from the shared package.
- Every playground MUST normalize invalid hashes back to `#/settings-console`.

## Scenario semantics

- `settings-console` MUST demonstrate a dialog-based preferences flow with tabs, at least one switch, at least one checkbox, and toast feedback after an apply/save action.
- `team-directory` MUST demonstrate avatar fallback behavior, badge display, an action menu, a popover, and a hover-card.
- `command-center` MUST demonstrate option filtering via combobox, an alternate selection control via select, a scrollable results region, and a context menu action surface.
- `virtualized-results` MUST demonstrate large-list rendering with `VirtualizedList` in React and Svelte.
- Vue MUST render an unsupported view for `virtualized-results` that names the unsupported capability and points back to supported scenarios.

## Unsupported-view semantics

- An unsupported view MUST include:
  - the requested scenario title,
  - the adapter name,
  - a concise unsupported explanation,
  - a stable support note derived from the shared capability matrix.
- Unsupported views MUST be treated as successful route resolution, not as runtime exceptions.

## Documentation semantics

- The root `uifn/README.md` MUST link to `uifn/examples/README.md`.
- Adapter READMEs for React, Svelte, and Vue MUST link to the example hub and name the corresponding playground.
- Vue documentation MUST continue to mark the adapter as experimental when linking to its playground.

## Verification semantics

- `verify:uifn-examples` MUST perform, in order, workspace discovery, manifest validation, local builds, docs-link validation, and offline/network-forbidden checks.
- The command MUST exit with code `0` when `ok` is `true` and non-zero otherwise.
- Offline validation MUST fail if example source files include obvious network primitives such as `fetch`, `XMLHttpRequest`, `WebSocket`, or `navigator.sendBeacon`.

# Invariants

- Scenario ordering MUST always be `settings-console`, `team-directory`, `command-center`, `virtualized-results`.
- Scenario ids MUST be stable and MUST NOT vary by adapter.
- Shared copy MUST be adapter-neutral except for adapter badges and unsupported notes.
- Dev ports MUST remain fixed at `6111`, `6112`, and `6113`.
- The examples bundle MUST remain runnable without environment variables, secrets, or network access.
- Vue MUST never claim support for `virtualized-list` in example UI, docs, or verification output.
- Unknown routes MUST deterministically resolve to `#/settings-console`.
- Build artifacts MAY vary in hashed filenames, but logical route names, headings, scenario ids, and verification JSON keys MUST NOT vary.

# Security

- Example apps MUST NOT require auth credentials or read secrets from environment variables.
- Example apps MUST NOT transmit data off-machine.
- Example apps MUST NOT execute remote code or depend on CDN assets.
- Example apps SHOULD avoid dangerously setting HTML; if unavoidable, such behavior is Undefined and not required by this spec.
- Verification output MUST describe failures without logging user-entered demo text beyond scenario ids and workspace names.

# Limits/caps

- The shared scenario registry is capped at exactly four scenarios in this bundle.
- The capability matrix is capped at the capability ids defined in this spec.
- Shared fixtures SHOULD remain under 100 logical records per scenario except `virtualized-results`, which MAY synthesize a large in-memory list deterministically.
- Example apps MUST fit within standard Vite SPA build expectations; no server process or database is allowed.

# Observability

- `verify:uifn-examples` MUST emit the canonical JSON envelope to stdout.
- Example apps MAY log local developer warnings during `dev`, but production builds MUST NOT emit analytics or telemetry code.
- Unsupported views SHOULD surface the support note in UI instead of only logging it.
- Verification failures MUST use one of the canonical error codes defined in this spec.

# Compatibility / versioning strategy

- Example apps MUST consume the local workspace versions of `@uifn/*`, not registry-published versions.
- React playground compatibility MUST align with `@uifn/react` (`React 18.2+`).
- Svelte playground compatibility MUST align with `@uifn/svelte` (`Svelte 5.x`).
- Vue playground compatibility MUST align with `@uifn/vue` (`Vue 3.5+`) and remain labeled experimental.
- Future additions of more playgrounds or scenarios MUST update the shared registry first and then extend the capability matrix, requirements, and verification vectors in a follow-up tracked change.

# Undefined / Explicitly user-deferred only

No explicit user-deferred items were provided. Behavior not defined by the contracts above is Undefined and NOT required by this bundle.

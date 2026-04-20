# Purpose

This document is informational support for the `extfn` spec bundle. It describes how an external consumer repository such as `nucleus` SHOULD adopt `extfn` without requiring this spec to modify any files outside `superfunctions`.

Nothing in this document changes the implementation scope of the spec. All implementation work remains inside this repository.

# Consumer problem summary

The main consumer-side blocker observed in the external `nucleus` repo is host coupling inside reusable-looking shared UI code. Several shared components import SvelteKit runtime APIs directly, such as:

- external consumer repo path: `client/layout/topNav/TopNav.svelte`
- external consumer repo path: `client/layout/layers/BaseLayer.svelte`
- external consumer repo path: `client/layout/topNav/TopNavLeftMenuItem.svelte`
- external consumer repo path: `client/layout/SplitView.svelte`

These imports include patterns such as:

- `$app/stores`
- `$app/navigation`
- `$app/environment`

This creates three migration problems:

1. A shared component stops being host-agnostic once it depends on SvelteKit runtime state.
2. A browser extension page or content UI is not automatically a SvelteKit runtime, even if it uses Svelte.
3. A TypeScript path alias that makes `$app/*` compile does not create the actual SvelteKit runtime behavior.

# Recommended consumer architecture

## Core rule

Consumer repositories SHOULD treat host runtime concerns as an adapter boundary.

Shared packages SHOULD depend on a consumer-owned host abstraction, not directly on `$app/*`.

## Host layers

The consumer SHOULD split code into three layers:

1. `pure shared UI`
   - Reusable components with no routing, navigation, or environment imports.
2. `host-aware shared UI`
   - Components that depend on page state, navigation, environment, or lifecycle hooks.
   - These MUST depend on a consumer-owned host abstraction.
3. `app shells`
   - Top-level SvelteKit pages, layouts, or extension entrypoints.
   - These MAY depend directly on the host implementation because they are host-specific by definition.

# Proposed host abstraction

The consumer SHOULD introduce a small host API package. The exact name is consumer-owned; examples:

- `@21n/host`
- `client/host`
- `shared/host`

## Suggested interface

```ts
import type { Readable } from "svelte/store"

export interface HostPageState {
  pathname: string
  searchParams: URLSearchParams
  params: Record<string, string | undefined>
  routeId?: string
}

export interface HostEnvironment {
  browser: boolean
  dev: boolean
  extension: boolean
}

export interface HostNavigation {
  goto(path: string, options?: { replaceState?: boolean; reload?: boolean }): Promise<void> | void
  afterNavigate?(handler: () => void): () => void
  beforeNavigate?(handler: () => void): () => void
}

export interface HostApi {
  page: Readable<HostPageState>
  environment: Readable<HostEnvironment>
  navigation: HostNavigation
}
```

## Why this interface

This interface covers the high-friction SvelteKit imports seen in the consumer:

- `$app/stores.page`
- `$app/navigation.goto`
- `$app/navigation.afterNavigate`
- `$app/environment.browser`

It is intentionally smaller than SvelteKit and smaller than `extfn`. It is a consumer host abstraction, not a framework API clone.

# Adapter strategy

## SvelteKit adapter

The consumer SHOULD implement a `kitHostAdapter` in the app repo.

Responsibilities:

- convert `$app/stores.page` into the consumer `HostApi.page`
- wrap `goto`, `afterNavigate`, `beforeNavigate`
- expose environment flags

This adapter MAY be used by app shells and host-aware shared components in app contexts.

## extfn adapter

The consumer SHOULD implement an `extfnHostAdapter` for extension surfaces.

Responsibilities:

- derive page state from `window.location`
- map extension navigation to the extension page router or hash/query strategy
- expose `extension = true`
- provide no-op or extension-specific lifecycle hooks where browser navigation semantics differ from SvelteKit

This adapter MAY be used by popup, options, sidepanel, or other extension pages built with `extfn`.

## Content-script UI adapter

Content-script UI SHOULD generally use a narrower host shape than full page surfaces.

Recommended behavior:

- derive `pathname` and `searchParams` from `window.location`
- expose `extension = true`
- implement `goto()` only if content-script UI actually performs browser navigation
- omit or no-op `afterNavigate` if the content surface is not route-driven

# Migration guidance

## Rule 1: move direct `$app/*` imports upward

If a shared component imports `$app/*`, the consumer SHOULD first decide whether it is truly shared or actually app-shell code.

- If it is app-shell code, keep it host-specific.
- If it is meant to be reused in extension surfaces, replace `$app/*` usage with `HostApi`.

## Rule 2: convert implicit globals into explicit dependencies

Example migration shape:

Before:

```ts
import { page } from "$app/stores"
import { goto } from "$app/navigation"
```

After:

```ts
import { host } from "@21n/host"
```

Then use:

```ts
$host.page.searchParams.get("tab")
host.navigation.goto("/settings")
```

## Rule 3: prefer derived stores over route globals in reusable components

A reusable component SHOULD receive the smallest dependency possible:

- `activeTab`
- `isExtension`
- `currentPath`
- `openSettings()`

This is better than importing a route store directly.

## Rule 4: keep route parsing out of leaf UI

Leaf UI components SHOULD NOT know about:

- query parameter names
- route param names
- SvelteKit route IDs

Instead, app-shell or host-aware wrappers SHOULD derive those values and pass them down.

# Migration categories for `nucleus`

## Category A: pure components

These MAY move to extension surfaces immediately.

Typical signs:

- no `$app/*`
- no `window.location` parsing in component body
- no direct `goto()`

## Category B: host-aware shared components

These MUST migrate to host abstraction first.

Typical signs:

- imports from `$app/stores`
- imports from `$app/navigation`
- environment branching based on `$app/environment`

Examples from the external consumer descriptor:

- `client/layout/topNav/TopNav.svelte`
- `client/layout/layers/BaseLayer.svelte`

## Category C: app shells

These SHOULD remain app-specific and be rewritten separately for extension surfaces.

Typical signs:

- top-level layouts
- route trees
- app bootstrap code
- full authenticated shell orchestration

# Consumer command flow

Consumer repositories such as `nucleus` SHOULD treat the `extfn` CLI as the primary extension workflow entrypoint.

Recommended flow:

1. Run `extfn dev --target chromium-mv3` during day-to-day local development.
2. Use `extfn dev --no-open` when the developer wants manual browser loading with the emitted `dist/<target>-dev` output.
3. Run `extfn build` to produce deterministic unpacked production outputs.
4. Run `extfn scan` before packaging or release review.
5. Run `extfn package` to produce store-uploadable archives.

Important scan behavior:

- `extfn scan` is strict by default.
- `extfn scan --no-strict` still emits the full report but does not block on error findings.
- `extfn package` inherits strict scan behavior by default and SHOULD only be made non-blocking with explicit intent.

For a consumer such as `nucleus`, the expected adoption shape is:

- extension package defines `extfn.config.ts`
- extension package uses the repository-owned `vite.config.ts` integration
- developers work through `extfn dev`, `extfn scan`, and `extfn package`
- shared UI is migrated behind a consumer-owned host abstraction where needed

Repository-owned reuse expectations:

- the extension config loader should come from the shared repository CLI utility path, not from a consumer-local duplicate
- `datafn/extfn` should rely on the existing DataFn browser extension transport and storage primitives already present in this repository
- consumers should not need to recreate those framework-level pieces inside `nucleus`

# Recommended extfn consumer usage

## Popup / options / sidepanel pages

The consumer SHOULD treat these as extension page surfaces, not as full SvelteKit apps.

Recommended pattern:

1. use `extfn.config.ts` to declare the surface
2. mount a Svelte 5 root with `@superfunctions/extfn-svelte`
3. inject the consumer `extfnHostAdapter`
4. render host-aware shared components only after they depend on `HostApi`, not `$app/*`

## Content-script UI

The consumer SHOULD keep content-script UI smaller and more local than app pages.

Recommended pattern:

1. author isolated content modules under extension-owned source folders
2. reuse only pure components or host-adapted shared components
3. keep page-routing assumptions out of content scripts

## Background authority

The consumer SHOULD keep extension-wide authority in background services.

This is especially important for:

- DataFn storage
- DataFn sync
- cross-context fanout
- commands
- long-lived messaging routes

# DataFn consumer guidance

## Recommended authority model

When a consumer uses `@datafn/extfn`:

- background SHOULD initialize the authoritative DataFn client
- popup/options/sidepanel/content SHOULD use proxy clients
- non-background contexts SHOULD NOT attempt to own durable sync state

## Why this model fits the consumer problem

It avoids duplicating storage and sync logic across:

- popup
- sidepanel
- options
- multiple content modules

It also gives the consumer one place to integrate auth and remote sync policy.

# Why `extfn` should not emulate full SvelteKit

The consumer SHOULD NOT rely on `extfn` reproducing the entire SvelteKit runtime.

Reasons:

1. It would couple `extfn` to one frontend host model.
2. It would make non-Svelte consumers harder to support later.
3. Content scripts and service workers are not natural SvelteKit runtimes anyway.

The correct long-term boundary is:

- `extfn` owns extension runtime and browser context behavior
- the consumer owns the host abstraction used by its shared UI packages

# Suggested consumer adoption order

1. Build a new extension surface in the consumer using only pure shared components plus `extfn`.
2. Introduce a consumer `HostApi`.
3. Migrate host-aware shared components away from direct `$app/*` imports.
4. Move reused stateful logic behind background-authority services where appropriate.
5. Adopt `@datafn/extfn` once background authority and host abstraction are in place.

# Consumer success criteria

The consumer migration is on the right track when:

- extension pages no longer require fake `$app/*` path aliases
- host-aware components compile under both SvelteKit and `extfn` adapters
- content modules reuse shared UI without importing SvelteKit runtime APIs
- DataFn authority runs only in background
- new extension surfaces are authored through `extfn.config.ts`

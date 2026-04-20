# Architecture Sketch

## Repository additions

- `extfn/core`
  - Owns config types, runtime types, error model, canonical envelopes, browser facade, plugin interfaces, content-script definitions, persistent port abstractions, and runtime context helpers.
  - SHOULD reuse or align with `@superfunctions/errors`, `@superfunctions/envelope`, and `@superfunctions/metrics` where those packages already define compatible primitives.
- `extfn/vite`
  - Owns config loading, Vite plugin integration, target-aware manifest generation, build graph assembly, dev reload strategy, and packaging of unpacked target outputs.
  - SHOULD consume a shared config-loader path extracted or exported from `packages/cli` instead of shipping a second TS loader.
- `extfn/cli`
  - Owns the `extfn` binary, target selection, browser launch orchestration, packaging flows, and scan reporting.
  - SHOULD consume `clifn` for generic CLI-building concerns such as action runner semantics, output formatting, config loading, env-backed defaults, diagnostics formatting, subprocess execution, and scaffolding.
  - SHOULD consume `@superfunctions/config` for env-backed defaults and `@superfunctions/metrics`/`@superfunctions/errors` compatible primitives where applicable.
  - MUST keep extension-specific workflows such as browser launch orchestration, manifest-aware packaging, and extension scan rules inside `extfn/cli` rather than moving them into `clifn`.
- `extfn/svelte`
  - Owns Svelte 5 adapter helpers for page and content-script mounts only.
- `datafn/extfn`
  - Owns background authority startup, DataFn proxy clients, DataFn-specific runtime routes, and subscription fanout for extension contexts.
  - MUST compose public `@datafn/client` extension primitives and stay aligned to the current `DatafnClientConfig` surface on this branch.
- `extfn/examples/*`
  - Own example extensions used for local validation and manual QA.
- Phase 09 docs
  - MUST include guidance for future package-owned plugins such as `searchfn/extfn` and `filefn/extfn` so new integrations follow repository-native adapter/provider patterns.

## Core responsibilities

- `@superfunctions/extfn` MUST remain framework-agnostic and domain-agnostic.
- `@superfunctions/extfn-vite` MUST translate `extfn.config.ts` into target-specific Vite/Rollup entry graphs and manifests.
- Shared CLI config loading SHOULD be reused or extracted from `packages/cli` instead of duplicated.
- Shared error, envelope, config, and metrics primitives SHOULD be reused from `packages/` before introducing extfn-local variants.
- `@superfunctions/extfn-svelte` MUST remain a thin adapter over the core runtime and Svelte 5 mounting behavior.
- `@datafn/extfn` MUST keep DataFn authority in background, MUST not require external consumer repos for validation, and SHOULD reuse existing `@datafn/client` extension primitives instead of reimplementing them.
- Future package-owned plugins SHOULD follow the same pattern as `@datafn/extfn`: own their domain logic in their package tree, contribute only via extfn hooks, and compose existing public package contracts such as `@searchfn/adapter-contracts`, `@searchfn/client`, `@filefn/client`, `@filefn/viewer`, `@superfunctions/files`, and `@superfunctions/storage`.

# Dependency Graph

1. Root workspace wiring MUST exist before any new packages can build.
2. `extfn/core` MUST exist before `extfn/vite`.
3. `extfn/vite` MUST exist before `extfn/cli`.
4. `extfn/core` MUST exist before `extfn/svelte`.
5. `extfn/core`, `extfn/vite`, and `extfn/cli` MUST exist before the final example validation flow is complete.
6. `datafn/extfn` MUST depend on `extfn/core` and existing `datafn` packages.
7. Svelte example validation MUST wait for `extfn/svelte`.
8. DataFn example validation MUST wait for `datafn/extfn`.
9. If `extfn/cli` requires new generic CLI primitives, the corresponding `clifn` extraction or implementation MUST land before Phase 08 is considered complete.

# Phases Overview

| Phase | Goal | Delivered capability | Verification method |
|---|---|---|---|
| `PHASE_00` | Wire the repository for new packages | Workspace entries, shared tsconfig/build scaffolding, package shells | `npm install`, `turbo run build --filter=@superfunctions/extfn --dry=json` or equivalent workspace discovery |
| `PHASE_01` | Define code-first config and target validation | `defineExtension`, config loader, target validation, surface definitions | Unit tests for config loading and invalid target handling |
| `PHASE_02` | Build core runtime and browser facade | `getRuntime`, context detection, error model, browser facade, capability registry | Runtime unit tests for context and browser facade behavior |
| `PHASE_03` | Implement messaging and modular background handlers | Canonical envelopes, router, request/response, event bus, persistent ports, reconnect semantics, handler directory discovery | Unit and integration tests for routing, timeout, collision, fanout, and reconnect |
| `PHASE_04` | Implement content-script orchestration | Multiple content modules, anchored mounts, style isolation, reinjection and idempotency | Browser-like integration tests against example content modules |
| `PHASE_05` | Implement Vite build/dev pipeline | Target manifests, deterministic outputs, dev reload policy, unpacked outputs | Build snapshots and dev policy tests for Chromium and Firefox |
| `PHASE_06` | Add UI adapters and validation examples | Svelte 5 adapter, vanilla example, Svelte multi-content example | Local build and manual smoke commands for both examples |
| `PHASE_07` | Add `datafn/extfn` | Background DataFn authority, proxy client, subscriptions, DataFn example extension | DataFn integration tests and example smoke runs |
| `PHASE_08` | Add CLI, packaging, and scan workflows | `extfn` binary, browser orchestration, package archives, strict scan reports, and `clifn`-backed generic CLI reuse | CLI integration tests and package/scan fixtures |
| `PHASE_09` | Finalize docs and consumer guidance | Repository docs plus migration guidance for consumer host abstraction | Doc presence checks and command examples validated from repo root |

# Definition of Done

No phase is complete unless its verification steps pass.

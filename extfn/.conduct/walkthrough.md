# extfn Phase 00 Reuse Plan

This note captures the shared-package reuse path that `extfn` will follow before runtime implementation begins.

## Generic CLI concerns

- `extfn/cli` reuses `clifn` for:
  - action runner semantics
  - output formatting
  - env-backed defaults
  - diagnostics formatting
  - subprocess execution
  - scaffolding
- `extfn/cli` keeps ownership of:
  - browser orchestration
  - extension packaging flow
  - extension scan rules
  - target-specific validation

## Config loading

- `loadExtensionConfig()` MUST reuse the Jiti-backed TypeScript config loading pattern that already exists in `packages/cli/src/utils/load-library-config.ts`.
- If `extfn` needs a dedicated loader helper instead of consuming `clifn/config-loader` directly, the helper must be extracted into a shared package or shared utility first.
- `extfn` does not introduce a second unrelated TypeScript config loader.

## Direct shared-package reuse

- `@superfunctions/config`
  - env-backed CLI configuration and defaults when env parsing is needed
- `@superfunctions/errors`
  - typed error registration and shared error construction
- `@superfunctions/envelope`
  - response error metadata semantics such as `status` and `retryable`
- `@superfunctions/metrics`
  - metrics-compatible observability emitter contracts

## DataFn integration reuse

- `@datafn/extfn` lives under `datafn/`.
- `@datafn/extfn` composes the existing `@datafn/client` primitives for:
  - extension transport
  - subscription management
  - IndexedDB-backed storage adapters
- Any helper required from `@datafn/client` must be consumed through a public export or extracted first; the integration does not rely on long-term private deep imports.

## Extraction boundaries

- `extfn` does not depend directly on `hostfn/cli`.
- If a generic helper is wanted from `hostfn/cli`, it must be extracted before reuse.
- Future package-owned integrations such as search or file support should compose existing public contracts rather than creating extfn-local copies.

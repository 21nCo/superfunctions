# clifn Adoption Walkthrough

This walkthrough positions `clifn` as the shared generic CLI toolkit for Superfunctions packages. It is not a mandate to migrate every CLI immediately. The goal is to make the boundary clear enough that `extfn/cli` and other adopters can reuse `clifn` without guessing what belongs in the shared layer.

## What `clifn` owns

- parser-agnostic action execution with `clifn/runner`
- generic text/json output transport with `clifn/output`
- deterministic config discovery with `clifn/config-loader`
- generic env reading with `clifn/env`
- generic diagnostic formatting and redaction with `clifn/diagnostics`
- subprocess orchestration with `clifn/exec`
- deterministic file creation with `clifn/scaffold`
- compatibility-facing Conduct helpers that already exist at:
  - `clifn/credentials`
  - `clifn/config`
  - `clifn/client`
  - `clifn/ui`
  - `clifn/stdio`
  - `clifn/prompt`

## What stays product-owned

- command graph design and parser choice
- domain models and domain validation
- product-specific diagnostics and rules
- package/build/deploy logic that encodes one product's semantics
- extension, deployment, recording, or API-generation behavior that is not reusable across CLIs

## Repository comparison map

### `packages/cli`

- Current references:
  - `packages/cli/src/utils/load-library-config.ts`
  - `packages/cli/src/utils/config.ts`
- Repeated generic concern:
  - config-path discovery and TS/JS config loading
- `clifn` target:
  - `clifn/config-loader`
- Product-owned concern that stays local:
  - schema/library semantics and output tied to `@superfunctions/cli`

### `apifn/cli`

- Current references:
  - `apifn/cli/src/index.ts`
  - `apifn/cli/src/config.ts`
  - `apifn/cli/src/utils/output.ts`
- Repeated generic concern:
  - parser wiring around reusable action execution
  - config loading
  - output mode handling
- `clifn` target:
  - `clifn/runner`
  - `clifn/output`
  - `clifn/config-loader`
- Product-owned concern that stays local:
  - OpenAPI generation, diffing, serving, snippets, and collection semantics

### `hostfn/cli`

- Current references:
  - `hostfn/cli/src/index.ts`
  - `hostfn/cli/src/utils/logger.ts`
- Repeated generic concern:
  - repeated async `try/catch` wrappers around commands
  - generic terminal output
  - subprocess usage during deployments
- `clifn` target:
  - `clifn/runner`
  - `clifn/output`
  - `clifn/exec`
- Product-owned concern that stays local:
  - deployment orchestration, SSH flows, runtime registry behavior, and host-specific validation

### `recfn/cli`

- Current references:
  - `recfn/cli/src/output.ts`
- Repeated generic concern:
  - output mode switching and stable text/json transport
- `clifn` target:
  - `clifn/output`
- Product-owned concern that stays local:
  - domain-specific formatter functions for recordings, transcripts, analytics, and calendar state

## extfn adoption boundary

`extfn/cli` SHOULD use:

- `clifn/runner`
- `clifn/output`
- `clifn/diagnostics`
- `clifn/config-loader`
- `clifn/env`
- `clifn/exec`
- `clifn/scaffold`

`extfn/cli` MAY keep:

- its own parser choice
- thin extfn-specific presentation helpers where they encode extension semantics

`extfn/cli` MUST stay extfn-owned for:

- Vite-based extension orchestration
- browser launch and browser-profile behavior
- extension packaging rules
- manifest-aware validation and scan rules
- plugin-specific integration contracts
- target-specific extension validation

## Migration checklist

1. Identify the CLI concern being changed.
2. If the concern is parser-agnostic and reusable across products, prefer `clifn`.
3. If the concern encodes product semantics, keep it in the owning CLI.
4. If a needed generic primitive is missing, add it to `clifn` first and then consume it from the product CLI.
5. Keep parser choice local to the consuming CLI unless the repository explicitly standardizes on one parser in a separate decision.

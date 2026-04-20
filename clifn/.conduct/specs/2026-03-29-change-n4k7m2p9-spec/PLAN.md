# Architecture Sketch

## Package responsibilities

- `clifn/core`
  - remains the single published package `clifn`
  - preserves the current compatibility surface
  - adds generic CLI-builder modules:
    - output
    - runner
    - config-loader
    - env
    - diagnostics
    - exec
    - scaffold
- Existing modules
  - `ui` becomes a compatibility wrapper over the new output service
  - `config` remains the simple JSON project-config store
  - `client`, `credentials`, `stdio`, and `prompt` remain intact unless a compatibility-preserving internal refactor is needed
- Repository integrations
  - `packages/cli` and `apifn/cli` inform the config-loader design
  - `apifn/cli`, `hostfn/cli`, and `recfn/cli` inform output and runner design
  - `docsfn/cli` and `plugfn/cli` inform diagnostics formatting
  - `extfn/cli` is a planned consumer of generic `clifn` concerns only

## Module sketch

- `src/output.ts`
  - quiet/verbose/color/json/text output service
  - table formatting
  - spinner
- `src/runner.ts`
  - action execution context
  - exit-code normalization
  - error rendering
  - IO injection
- `src/config-loader.ts`
  - config discovery
  - TS/JS/JSON loading
  - validation hooks
- `src/env.ts`
  - required and optional env readers
  - numeric and boolean coercion
- `src/diagnostics.ts`
  - diagnostic types
  - stable sort
  - default redaction
  - text/json formatting
- `src/exec.ts`
  - subprocess run/capture/stream/timeout
- `src/scaffold.ts`
  - deterministic file and directory writes
  - dry-run and overwrite policies
- `src/ui.ts`
  - compatibility layer over `output`

# Dependency Graph

1. Package export-map and file layout decisions MUST exist before new modules are wired.
2. `output` MUST exist before `runner`.
3. `diagnostics` SHOULD exist before `runner` finalization because the runner collects diagnostics.
4. `exec` and `scaffold` MUST exist before `runner` finalization because the runner context exposes them.
5. `config-loader` and `env` are independent of `output`, but both SHOULD exist before canary integrations are added.
6. Compatibility wrappers MUST follow the underlying implementation modules they wrap.
7. Parser compatibility fixtures MUST wait for `runner` and `output`.
8. Adoption docs and extfn-facing guidance MUST wait for all generic modules to be defined.

# Phases Overview

| Phase | Goal | Delivered capability | Verification method |
|---|---|---|---|
| `PHASE_00` | Align package exports and compatibility plan | export-map decisions, compatibility guarantees, file scaffolding for new modules | build and import-resolution checks |
| `PHASE_01` | Implement generic output service | text/json output, quiet/verbose, tables, spinner, `ui` wrapper path | output unit tests |
| `PHASE_02` | Implement runner and normalized exit handling | parser-agnostic action execution context and error handling | runner unit tests |
| `PHASE_03` | Implement config-loader and env readers | TS/JS/JSON config loading and deterministic env parsing | loader/env unit tests |
| `PHASE_04` | Implement diagnostics model and formatters | stable diagnostics, redaction, text/json formatting | diagnostics unit tests |
| `PHASE_05` | Implement exec and scaffold helpers | subprocess capture/timeout and deterministic file operations | exec/scaffold unit tests |
| `PHASE_06` | Validate parser-agnostic consumption patterns | commander, cac, and parseArgs canary fixtures/tests | integration-style fixture tests |
| `PHASE_07` | Ship adoption docs and extfn-oriented guidance | migration/adoption docs for existing CLIs and extfn generic reuse boundary | docs presence and example validation |

# Definition of Done

No phase is complete unless its verification steps pass.


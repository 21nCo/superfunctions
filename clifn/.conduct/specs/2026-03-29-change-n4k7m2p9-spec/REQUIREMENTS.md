# Table of Contents

- PKG-001
- COMP-001
- OUT-001
- RUN-001
- RUN-002
- CFG-001
- ENV-001
- DIAG-001
- EXEC-001
- FS-001
- PARS-001
- SEC-001
- OBS-001
- ADOPT-001

## PKG-001

- ID: `PKG-001`
- Priority: `P0`
- Statement: `clifn` MUST remain a single-package function implemented at `clifn/core` and published as `clifn`.
- Rationale: The repository already treats `clifn` as a single-package function, and this change must extend it without creating a nested monorepo or incompatible package split.
- Acceptance criteria:
  - `clifn/core/package.json` remains the package metadata source for package name `clifn`.
  - New modules are added as subpath exports, not as a second published package in this spec bundle.
  - Root workspace and Turbo behavior continue to recognize `clifn/*`.
- Test vectors: `TV-PKG-001`
- Notes: This does not forbid a future multi-package design, but this spec does not require it.

## COMP-001

- ID: `COMP-001`
- Priority: `P0`
- Statement: `clifn` MUST preserve the current public subpaths and their source-compatible behavior while adding new CLI-builder modules.
- Rationale: Existing users of `clifn` should not be forced to rewrite imports merely because the package is growing.
- Acceptance criteria:
  - `clifn/credentials`, `clifn/config`, `clifn/client`, `clifn/ui`, `clifn/stdio`, and `clifn/prompt` remain exported.
  - Existing error codes for preserved modules remain stable.
  - New modules are additive and do not shadow existing subpaths.
- Test vectors: `TV-COMP-001`
- Notes: Internal implementation changes are allowed as long as public behavior remains compatible.

## OUT-001

- ID: `OUT-001`
- Priority: `P0`
- Statement: `clifn` MUST provide a generic output service with deterministic text and JSON modes, quiet and verbose behavior, table rendering, and spinner support.
- Rationale: Output behavior is duplicated today across `clifn`, `apifn`, `hostfn`, and `recfn`.
- Acceptance criteria:
  - `clifn/output` exports a `createOutput()` API.
  - Text output respects `quiet` and `verbose`.
  - JSON output writes exactly one newline-terminated JSON document.
  - Table rendering uses declared column order and deterministic row rendering.
  - Spinner support remains available.
- Test vectors: `TV-OUT-001`
- Notes: `clifn/ui` MAY delegate to this implementation.

## RUN-001

- ID: `RUN-001`
- Priority: `P0`
- Statement: `clifn` MUST provide a parser-agnostic action runner that standardizes execution context, diagnostics collection, and injected IO for CLI actions.
- Rationale: Existing CLIs repeatedly build one-off wrappers around async actions, stdout/stderr injection, and exit handling.
- Acceptance criteria:
  - `clifn/runner` exports `runAction()`.
  - `runAction()` supplies output, diagnostics, exec, scaffold, cwd, env, and non-interactive state in one context object.
  - The runner accepts injected stdout and stderr writers.
  - The runner does not depend on `commander`, `cac`, or any other one parser.
- Test vectors: `TV-RUN-001`
- Notes: Consumers continue to own command registration and parsing.

## RUN-002

- ID: `RUN-002`
- Priority: `P0`
- Statement: `clifn` MUST normalize uncaught action failures and explicit action outcomes into deterministic exit-code behavior.
- Rationale: Today, many CLIs inline inconsistent error/exit handling.
- Acceptance criteria:
  - Successful actions resolve to exit code `0` unless they explicitly request another code.
  - Uncaught errors resolve to a deterministic non-zero exit code.
  - Errors are rendered through one normalized path rather than ad hoc console handling.
  - Machine-readable mode does not emit extra human-readable lines around a JSON payload.
- Test vectors: `TV-RUN-002`
- Notes: The exact default non-zero code is part of the runner contract and must be documented.

## CFG-001

- ID: `CFG-001`
- Priority: `P0`
- Statement: `clifn` MUST provide a generic config loader for TS, JS, MJS, CJS, and JSON config files with deterministic discovery order and validation hooks.
- Rationale: `packages/cli` and `apifn/cli` already carry similar loader logic, and `extfn/cli` would otherwise add a third variant.
- Acceptance criteria:
  - `clifn/config-loader` exports `loadConfig()` and `defineConfig()`.
  - Explicit config paths bypass discovery and fail deterministically when missing.
  - Candidate discovery order is deterministic.
  - `.ts` loading uses one shared repository mechanism.
  - Consumers can supply a validation function that transforms or rejects the loaded value.
- Test vectors: `TV-CFG-001`
- Notes: This requirement does not force all current CLIs to migrate immediately.

## ENV-001

- ID: `ENV-001`
- Priority: `P0`
- Statement: `clifn` MUST provide deterministic environment readers for required strings, optional strings, integers, and booleans.
- Rationale: Multiple CLIs already implement lightweight env parsing, and extfn will need it for generic CLI defaults.
- Acceptance criteria:
  - Missing required values fail with an explicit error code.
  - Integer readers enforce optional min and max constraints.
  - Boolean readers support common truthy and falsy inputs.
  - Semantics are compatible with `@superfunctions/config`.
- Test vectors: `TV-ENV-001`
- Notes: This module is for generic env reading, not product-specific config assembly.

## DIAG-001

- ID: `DIAG-001`
- Priority: `P0`
- Statement: `clifn` MUST provide a generic diagnostics model with deterministic sorting, default redaction, and text/JSON formatting.
- Rationale: `docsfn` and `plugfn` already use structured diagnostic ideas, and extfn scan will need generic formatting support even though its rules stay product-owned.
- Acceptance criteria:
  - `clifn/diagnostics` exports a diagnostic type, sort, redact, and format helpers.
  - Diagnostics are serializable to deterministic JSON.
  - Text formatting is human-readable and stable.
  - Redaction removes sensitive keys by default.
- Test vectors: `TV-DIAG-001`
- Notes: Product-specific diagnostic taxonomies remain owned by the product package.

## EXEC-001

- ID: `EXEC-001`
- Priority: `P0`
- Statement: `clifn` MUST provide generic subprocess execution helpers with deterministic capture, streaming, timeout, and result reporting.
- Rationale: Build, package, deploy, test, and generator CLIs repeatedly need the same subprocess capabilities.
- Acceptance criteria:
  - `clifn/exec` exports a command execution API.
  - Commands support cwd, env, timeout, buffered capture, and optional streaming callbacks.
  - Timeouts are reported explicitly.
  - Results include exit code, signal, stdout, stderr, timeout state, and duration.
- Test vectors: `TV-EXEC-001`
- Notes: This helper does not own domain-specific command selection.

## FS-001

- ID: `FS-001`
- Priority: `P0`
- Statement: `clifn` MUST provide generic scaffolding helpers for deterministic file and directory operations with explicit overwrite policy.
- Rationale: Initializer and generator CLIs repeatedly implement the same file-creation patterns.
- Acceptance criteria:
  - `clifn/scaffold` supports directory creation and file writing.
  - Existing-file behavior is explicit via `error`, `skip`, or `overwrite`.
  - Operation ordering is deterministic.
  - Dry-run mode reports intended writes without mutating files.
- Test vectors: `TV-FS-001`
- Notes: Template rendering MAY be added later, but base file operations are mandatory here.

## PARS-001

- ID: `PARS-001`
- Priority: `P1`
- Statement: `clifn` MUST document and test parser-agnostic usage patterns for `commander`, `cac`, and `node:util.parseArgs`.
- Rationale: The repository currently uses all three styles, so `clifn` cannot be credible as a shared toolkit unless it demonstrates all of them.
- Acceptance criteria:
  - Tests or fixtures demonstrate runner/output integration with `commander`.
  - Tests or fixtures demonstrate runner/output integration with `cac`.
  - Tests or fixtures demonstrate runner/output integration with raw `parseArgs`.
  - No parser library becomes a mandatory dependency of `clifn` because of this requirement.
- Test vectors: `TV-PARS-001`
- Notes: This requirement is about compatibility patterns, not a new parser abstraction DSL.

## SEC-001

- ID: `SEC-001`
- Priority: `P0`
- Statement: `clifn` MUST redact sensitive information by default and prevent unsafe filesystem or config-loading behavior in its generic helpers.
- Rationale: Generic CLI infrastructure becomes a leak vector quickly if it logs env, headers, tokens, or traverses paths unsafely.
- Acceptance criteria:
  - Diagnostics redact sensitive keys by default.
  - Scaffold helpers reject path traversal outside the configured working directory.
  - Config loading rejects remote URLs.
  - Exec helpers do not emit full environment contents by default.
  - Prompt helpers fail deterministically in non-interactive mode when a prompt is required.
- Test vectors: `TV-SEC-001`
- Notes: Product packages may still add stricter controls.

## OBS-001

- ID: `OBS-001`
- Priority: `P1`
- Statement: `clifn` SHOULD make its generic helpers easy to observe and test through injected writers, durations, diagnostics, and deterministic formatting.
- Rationale: Reusable CLI infrastructure should improve testability and debugging for every consumer.
- Acceptance criteria:
  - Output helpers accept injected stdout and stderr writers.
  - Exec helpers include duration and timeout state.
  - Runner helpers surface collected diagnostics to tests and callers.
  - Deterministic formatting supports snapshot-style tests.
- Test vectors: `TV-OBS-001`
- Notes: This requirement is `SHOULD` because some consumers may not use every observation surface.

## ADOPT-001

- ID: `ADOPT-001`
- Priority: `P0`
- Statement: `clifn` MUST document an adoption path for `extfn/cli` and other Superfunctions CLIs that clearly separates generic CLI concerns from product-specific logic.
- Rationale: The user explicitly wants `clifn` to absorb what is generic enough for any CLI builder, while leaving extfn-specific logic in extfn.
- Acceptance criteria:
  - The docs identify which responsibilities move into `clifn`.
  - The docs identify which responsibilities remain in the owning CLI.
  - The docs reference current repository CLIs as examples of repeated patterns that `clifn` now generalizes.
  - The docs include an explicit extfn adoption contract for generic concerns only.
- Test vectors: `TV-ADOPT-001`
- Notes: This requirement is documentation and architecture guidance, not an immediate migration mandate.

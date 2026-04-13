# Metadata

- timestamp: `2026-03-29T04:42:08Z`
- agent_name: `unknown-agent`
- model: `unknown`
- launcher: `Codex Desktop`
- repo root: `repo root`
- OS: `Darwin arm64`
- shell: `zsh`
- git:
  - branch: `detached HEAD`
  - commit: `a4ed4ed01ca907e9a6beb1b2a8e76940a5dfb2ef`
  - dirty: `true`
- spec_folder: `2026-03-29-change-n4k7m2p9-spec`
- spec_path: `clifn/.conduct/specs/2026-03-29-change-n4k7m2p9-spec`
- spec_type: `change`
- spec_id: `n4k7m2p9`
- input paths:
  - `clifn/core/README.md`
  - `clifn/core/package.json`
  - `clifn/core/src/index.ts`
  - `clifn/core/src/client.ts`
  - `clifn/core/src/config.ts`
  - `clifn/core/src/credentials.ts`
  - `clifn/core/src/prompt.ts`
  - `clifn/core/src/stdio.ts`
  - `clifn/core/src/ui.ts`
  - `package.json`
  - `turbo.json`
  - `packages/cli/src/cli.ts`
  - `packages/cli/src/utils/config.ts`
  - `packages/cli/src/utils/load-library-config.ts`
  - `apifn/cli/src/bin.ts`
  - `apifn/cli/src/index.ts`
  - `apifn/cli/src/config.ts`
  - `apifn/cli/src/utils/output.ts`
  - `contentfn/cli/src/index.ts`
  - `contentfn/cli/src/commands/schema.ts`
  - `contentfn/cli/src/commands/dataset.ts`
  - `docsfn/cli/src/index.ts`
  - `datafn/cli/src/cli.ts`
  - `hostfn/cli/src/index.ts`
  - `hostfn/cli/src/utils/logger.ts`
  - `plugfn/cli/src/index.ts`
  - `plugfn/cli/src/commands/init.ts`
  - `plugfn/cli/src/commands/test.ts`
  - `recfn/cli/src/index.ts`
  - `recfn/cli/src/config.ts`
  - `recfn/cli/src/output.ts`
  - `watchfn/cli/src/index.ts`
  - `.conduct/specs/2026-03-29-new-99b2vbqg-spec/SPEC.md`
  - `.conduct/specs/2026-03-29-new-99b2vbqg-spec/REQUIREMENTS.md`
  - sanitized user intent: expand `clifn` with generic CLI-builder primitives that `extfn` and other Superfunctions CLIs can reuse, while keeping product-specific logic in each owning CLI

# Overview

`clifn` currently provides a small set of reusable CLI primitives: credentials, JSON project config, an HTTP client, terminal UI helpers, stdin/stdout helpers, and prompts. The repository now needs `clifn` to become the canonical parser-agnostic toolkit for building CLIs across Superfunctions packages, including but not limited to `extfn`.

This spec defines a repository-native expansion of `clifn` under `clifn/core` that MUST:

- preserve the existing `clifn` package name and current public subpaths
- add new public subpaths for generic CLI-building concerns that are currently duplicated across multiple CLIs
- remain parser-agnostic so it can support CLIs built with `commander`, `cac`, and raw `node:util.parseArgs`
- absorb generic logic that `extfn/cli` would otherwise re-implement
- keep domain-specific workflows, rule engines, and transport semantics in the owning CLI package rather than in `clifn`

This spec also establishes the adoption contract that `extfn/cli` and future CLIs SHOULD follow after the `clifn` capabilities defined here exist.

# Glossary

- `clifn`: The single-package CLI utility function implemented at `clifn/core` and published as `clifn`.
- `CLI builder`: Any package or application that uses `clifn` to implement a command-line interface.
- `parser`: The command-line parsing library or mechanism used by a CLI builder, such as `commander`, `cac`, or `node:util.parseArgs`.
- `parser-agnostic`: An API shape that MUST NOT require one specific parser library in order to be useful.
- `runner`: The `clifn` module that standardizes action execution, exit-code handling, signal propagation, and error normalization around a CLI action.
- `output service`: The `clifn` module that standardizes human-readable and machine-readable terminal output, including quiet, verbose, and colorized modes.
- `diagnostic`: A structured finding emitted by generic `clifn` helpers or a consuming CLI. Diagnostics are repository-agnostic and are not extfn scan rules by themselves.
- `config loader`: The `clifn` module that discovers and loads user config files from deterministic candidate paths or an explicit path.
- `config candidate`: One possible config filename evaluated in deterministic order during config discovery.
- `scaffold operation`: A generic file or directory creation/update step used by an initializer or generator CLI.
- `exec task`: A subprocess run through `clifn` with deterministic capture, streaming, timeout, and exit-state reporting.
- `sensitive key`: An environment variable name, header name, or object field that MUST be redacted from logs, diagnostics, or error details by default.
- `compatibility wrapper`: A legacy API preserved for current users while being reimplemented on top of a newer internal subsystem.

# Goals / Non-goals

## Goals

- `clifn` MUST remain a single-package function published as `clifn`.
- `clifn` MUST preserve the existing public subpaths:
  - `clifn/credentials`
  - `clifn/config`
  - `clifn/client`
  - `clifn/ui`
  - `clifn/stdio`
  - `clifn/prompt`
- `clifn` MUST add new public subpaths for generic CLI-building concerns:
  - runner
  - output
  - config loading
  - environment readers
  - diagnostics
  - subprocess execution
  - scaffolding helpers
- `clifn` MUST remain parser-agnostic.
- `clifn` MUST be useful to `extfn/cli` without forcing `extfn`-specific behavior into `clifn`.
- `clifn` MUST reflect and generalize patterns already repeated in repository CLIs such as:
  - `packages/cli`
  - `apifn/cli`
  - `contentfn/cli`
  - `docsfn/cli`
  - `hostfn/cli`
  - `plugfn/cli`
  - `recfn/cli`
  - `watchfn/cli`
- `clifn` MUST prefer reuse of existing shared Superfunctions packages where behavior already exists, especially `@superfunctions/config`.
- `clifn` MUST define deterministic, testable behavior for output, diagnostics, config discovery, execution, and scaffolding.

## Non-goals

- `clifn` MUST NOT become a framework-specific or product-specific CLI package.
- `clifn` MUST NOT own extension packaging, browser launching, MV3 scanning, or any other `extfn` domain logic.
- `clifn` MUST NOT force the entire monorepo onto one parser library.
- `clifn` MUST NOT replace domain SDKs or business logic in `apifn`, `datafn`, `docsfn`, `hostfn`, `plugfn`, `recfn`, or `watchfn`.
- `clifn` MUST NOT replace the current credential-store backend in this spec; the existing file-based credential store remains supported.
- `clifn` MUST NOT introduce a rich TUI framework, terminal layout system, or curses-like UI in this spec bundle.

# Public API

## Package layout

The implementation MUST continue using `clifn/core` as the package root with package name `clifn`.

The implementation MUST preserve existing files and MAY add the following public modules:

- `clifn/core/src/output.ts`
- `clifn/core/src/runner.ts`
- `clifn/core/src/config-loader.ts`
- `clifn/core/src/env.ts`
- `clifn/core/src/diagnostics.ts`
- `clifn/core/src/exec.ts`
- `clifn/core/src/scaffold.ts`

The package MUST expose additive public subpaths for those modules.

## Existing compatibility surface

The current `clifn` compatibility surface MUST remain available.

```ts
export interface CredentialProfile {
  backend: string
  key: string
}

export interface CredentialStore {
  readonly path: string
  getProfile(name: string): CredentialProfile
  setProfile(name: string, profile: CredentialProfile): void
  hasProfile(name: string): boolean
  listProfiles(): string[]
  removeProfile(name: string): void
}

export declare class MissingProfileError extends Error {
  readonly profile: string
  readonly filePath: string
  readonly code: "CLIFN_MISSING_PROFILE"
}

export declare function createCredentialStore(path?: string): CredentialStore

export interface ProjectConfigStore<TConfig extends Record<string, unknown> = Record<string, unknown>> {
  readonly path: string
  read(): TConfig
  write(next: TConfig): void
  get<TKey extends keyof TConfig>(key: TKey): TConfig[TKey] | undefined
  set<TKey extends string, TValue>(key: TKey, value: TValue): void
}

export declare class InvalidConfigError extends Error {
  readonly filePath: string
  readonly code: "CLIFN_INVALID_CONFIG"
}

export declare function createProjectConfig<TConfig extends Record<string, unknown> = Record<string, unknown>>(
  path?: string
): ProjectConfigStore<TConfig>

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  path: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  headers?: Record<string, string>
}

export interface ApiResponse<T = unknown> {
  status: number
  data: T
  headers: Headers
}

export interface ApiClient {
  request<T = unknown>(options: ApiRequestOptions): Promise<ApiResponse<T>>
  get<T = unknown>(path: string, query?: ApiRequestOptions["query"]): Promise<ApiResponse<T>>
  post<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>>
  put<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>>
  patch<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>>
  delete<T = unknown>(path: string): Promise<ApiResponse<T>>
}

export interface ApiClientConfig {
  baseUrl?: string
  credentials?: CredentialStore
  profile?: string
  apiKey?: string
  projectId?: string
  retries?: number
  retryDelayMs?: number
  timeoutMs?: number
  defaultHeaders?: Record<string, string>
  fetchImpl?: typeof fetch
}

export declare class HttpFailureError extends Error {
  readonly code: "CLIFN_HTTP_FAILURE"
  readonly status: number
  readonly url: string
  readonly responseBody: unknown
}

export declare class HttpRequestError extends Error {
  readonly code: "CLIFN_HTTP_REQUEST_ERROR"
  readonly url: string
}

export declare function createApiClient(config: ApiClientConfig): ApiClient

export interface Spinner {
  start(): void
  stop(): void
  succeed(message?: string): void
  fail(message?: string): void
}

export declare const ui: {
  success(message: string): void
  error(message: string): void
  warn(message: string): void
  info(message: string): void
  spinner(message: string): Spinner
  table(rows: Array<Record<string, string | number>>): void
}

export declare class InvalidJsonStdinError extends Error {
  readonly code: "CLIFN_INVALID_STDIN_JSON"
}

export declare function readJsonStdin<T>(input?: NodeJS.ReadableStream): Promise<T>
export declare function writeJsonStdout<T>(value: T, output?: NodeJS.WritableStream): void

export declare class PromptInputError extends Error {
  readonly code: "CLIFN_PROMPT_INPUT_ERROR"
}

export interface PromptApi {
  select<T extends string>(label: string, choices: T[]): Promise<T>
  multiSelect<T extends string>(label: string, choices: T[]): Promise<T[]>
  text(label: string, options?: { default?: string }): Promise<string>
  confirm(label: string): Promise<boolean>
}

export declare function createPrompt(options?: { ask?: (label: string) => Promise<string> }): PromptApi
export declare const prompt: PromptApi
```

## `clifn/output`

```ts
export type OutputMode = "text" | "json"
export type OutputLevel = "debug" | "info" | "success" | "warn" | "error"

export interface OutputMessage {
  level: OutputLevel
  message: string
  details?: unknown
}

export interface OutputTable {
  columns: readonly string[]
  rows: ReadonlyArray<Record<string, string | number | boolean | null | undefined>>
}

export interface OutputOptions {
  quiet?: boolean
  verbose?: boolean
  color?: boolean
  mode?: OutputMode
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

export interface OutputService {
  readonly mode: OutputMode
  debug(message: string, details?: unknown): void
  info(message: string, details?: unknown): void
  success(message: string, details?: unknown): void
  warn(message: string, details?: unknown): void
  error(message: string, details?: unknown): void
  json(value: unknown): void
  table(input: OutputTable): void
  spinner(message: string): Spinner
}

export declare function createOutput(options?: OutputOptions): OutputService
```

`clifn/ui` MUST remain available as a compatibility wrapper over `clifn/output`.

## `clifn/runner`

```ts
import type { OutputService } from "clifn/output"
import type { Diagnostic } from "clifn/diagnostics"
import type { ExecService } from "clifn/exec"
import type { ScaffoldService } from "clifn/scaffold"

export interface RunnerOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  quiet?: boolean
  verbose?: boolean
  color?: boolean
  mode?: "text" | "json"
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  nonInteractive?: boolean
}

export interface RunnerContext {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly output: OutputService
  readonly diagnostics: {
    add(input: Diagnostic): void
    list(): readonly Diagnostic[]
  }
  readonly exec: ExecService
  readonly scaffold: ScaffoldService
  readonly nonInteractive: boolean
}

export type RunnerActionResult =
  | void
  | {
      exitCode?: number
      data?: unknown
      diagnostics?: readonly Diagnostic[]
    }

export declare function runAction<TOptions>(
  action: (options: TOptions, ctx: RunnerContext) => Promise<RunnerActionResult> | RunnerActionResult,
  options: TOptions,
  runnerOptions?: RunnerOptions
): Promise<number>
```

## `clifn/config-loader`

```ts
export interface ConfigLoaderOptions<T> {
  cwd?: string
  configPath?: string
  candidates?: readonly string[]
  exportNames?: readonly string[]
  validate?: (value: unknown, path: string) => T
}

export interface LoadedConfig<T> {
  config: T
  path: string
}

export declare function defineConfig<T>(config: T): T

export declare function loadConfig<T>(
  options?: ConfigLoaderOptions<T>
): Promise<LoadedConfig<T>>
```

The loader MUST support `.ts`, `.js`, `.mjs`, `.cjs`, and `.json`.

## `clifn/env`

```ts
export interface StringEnvOptions {
  defaultValue?: string
  allowEmpty?: boolean
  env?: NodeJS.ProcessEnv
}

export interface IntEnvOptions {
  defaultValue?: number
  min?: number
  max?: number
  env?: NodeJS.ProcessEnv
}

export interface BooleanEnvOptions {
  defaultValue?: boolean
  env?: NodeJS.ProcessEnv
}

export declare function readRequiredStringEnv(key: string, options?: Omit<StringEnvOptions, "defaultValue">): string
export declare function readStringEnv(key: string, options: StringEnvOptions): string
export declare function readIntEnv(key: string, options: IntEnvOptions): number
export declare function readBooleanEnv(key: string, options: BooleanEnvOptions): boolean
```

`clifn/env` SHOULD compose `@superfunctions/config` primitives rather than reimplementing incompatible semantics.

## `clifn/diagnostics`

```ts
export type DiagnosticSeverity = "error" | "warning" | "info"

export interface Diagnostic {
  code: string
  severity: DiagnosticSeverity
  message: string
  path?: string
  details?: Record<string, unknown>
}

export interface DiagnosticReport {
  ok: boolean
  diagnostics: readonly Diagnostic[]
}

export declare function createDiagnostic(input: Diagnostic): Diagnostic
export declare function sortDiagnostics(input: readonly Diagnostic[]): Diagnostic[]
export declare function redactDiagnostics(input: readonly Diagnostic[]): Diagnostic[]
export declare function formatDiagnosticsText(input: readonly Diagnostic[]): string
export declare function formatDiagnosticsJson(input: readonly Diagnostic[]): string
```

## `clifn/exec`

```ts
export interface ExecOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdin?: string
  timeoutMs?: number
  streamOutput?: boolean
  maxBufferBytes?: number
  stdout?: (chunk: string) => void
  stderr?: (chunk: string) => void
}

export interface ExecResult {
  command: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

export interface ExecService {
  command(file: string, args?: readonly string[], options?: ExecOptions): Promise<ExecResult>
}

export declare function createExec(): ExecService
```

## `clifn/scaffold`

```ts
export type FileExistsBehavior = "error" | "skip" | "overwrite"

export type ScaffoldOperation =
  | {
      kind: "mkdir"
      path: string
    }
  | {
      kind: "write-file"
      path: string
      content: string
      ifExists?: FileExistsBehavior
    }

export interface ScaffoldResult {
  written: string[]
  skipped: string[]
}

export interface ScaffoldService {
  apply(operations: readonly ScaffoldOperation[], options?: { cwd?: string; dryRun?: boolean }): Promise<ScaffoldResult>
}

export declare function createScaffold(): ScaffoldService
```

# Data formats / protocol

## Runner result shape

`runAction()` MUST normalize action execution into one deterministic process outcome:

```ts
type RunnerOutcome = {
  exitCode: number
  diagnostics: readonly Diagnostic[]
  emittedJson?: unknown
}
```

## Diagnostic JSON format

Machine-readable diagnostics MUST serialize to:

```json
{
  "ok": false,
  "diagnostics": [
    {
      "code": "EXAMPLE_ERROR",
      "severity": "error",
      "message": "Human-readable explanation",
      "path": "optional/path",
      "details": {}
    }
  ]
}
```

Required invariants:

- `diagnostics` MUST be deterministically ordered.
- `details` MUST be omitted or redacted when it contains sensitive keys.

## Exec result format

Generic subprocess execution MUST normalize to:

```json
{
  "command": "npm run build",
  "exitCode": 0,
  "signal": null,
  "stdout": "",
  "stderr": "",
  "timedOut": false,
  "durationMs": 120
}
```

## Scaffold result format

Generic scaffolding MUST normalize to:

```json
{
  "written": ["src/index.ts"],
  "skipped": ["README.md"]
}
```

# Semantics

## Package semantics

- `clifn` MUST remain a single package located at `clifn/core`.
- Existing subpaths MUST continue to work without source-breaking changes.
- New public modules MUST be additive.

## Output semantics

- `createOutput()` MUST support text and JSON modes.
- `quiet` MUST suppress non-error human-readable output.
- `verbose` MUST enable debug output.
- `json()` MUST emit exactly one JSON document followed by a newline.
- `table()` MUST render columns in deterministic order from the declared `columns` list.
- `ui` MUST remain usable as a compatibility wrapper and SHOULD delegate to the new output system internally.

## Runner semantics

- `runAction()` MUST create one consistent execution context for a CLI action.
- Uncaught errors from an action MUST be normalized into a deterministic non-zero exit result.
- `runAction()` MUST NOT require a specific parser library.
- Consuming CLIs MAY still own their own parser, subcommand tree, and option definitions.

## Config-loader semantics

- Config discovery MUST evaluate candidates in user-provided order, or deterministic default order when none are provided.
- An explicit `configPath` MUST bypass candidate discovery and fail deterministically when missing.
- `.ts` config loading MUST use one shared repository approach rather than a second incompatible loader.
- Loaded config exports MAY come from `default`, one configured export name, or the module object itself, in that deterministic preference order.

## Environment semantics

- `clifn/env` MUST provide deterministic missing-value and invalid-value failures.
- Boolean parsing MUST support the same truthy and falsy semantics as `@superfunctions/config`.
- Integer readers MUST enforce optional bounds.

## Diagnostics semantics

- Diagnostics MUST be sortable, redactable, and formatable independent of any one CLI product.
- `error` severity diagnostics SHOULD drive non-zero exit behavior when the consuming CLI chooses strict mode.
- `clifn/diagnostics` MUST NOT encode `extfn`-specific rule IDs or product taxonomies.

## Exec semantics

- `createExec().command()` MUST support deterministic command display, capture, timeout handling, and streaming hooks.
- Streaming and buffering MAY be enabled together.
- Timed-out processes MUST set `timedOut = true`.
- Execution helpers MUST support dependency injection for testing.

## Scaffold semantics

- Scaffolding MUST support deterministic ordered operations.
- Parent directories MUST be created automatically for `write-file` operations.
- `ifExists = "error"` MUST fail on pre-existing files.
- `ifExists = "skip"` MUST preserve the original file and report it in `skipped`.
- `ifExists = "overwrite"` MUST replace the file content deterministically.

## Parser integration semantics

- `clifn` MUST remain parser-agnostic.
- The package MUST document and test compatibility patterns for:
  - `commander`
  - `cac`
  - `node:util.parseArgs`
- `clifn` MAY provide small parser-neutral wrappers around action execution, but MUST NOT require consumers to adopt a `clifn` command-definition DSL in this spec bundle.

## Adoption semantics

- `extfn/cli` SHOULD consume `clifn` for generic concerns:
  - runner
  - output
  - diagnostics
  - config loading
  - environment readers
  - subprocess execution
  - scaffolding
- `extfn/cli` MUST keep extfn-specific concerns outside `clifn`, including:
  - Vite integration
  - browser launch orchestration
  - extension packaging
  - extension scanning rules
  - MV3-specific runtime semantics
- Other CLIs in the repository MAY adopt `clifn` incrementally.
- This spec does NOT require all existing CLIs to migrate immediately, but it MUST provide a usable shared target for future migrations.

# Invariants

- Public subpath names MUST be deterministic and stable.
- Existing `clifn` subpaths MUST remain source-compatible.
- Diagnostic ordering MUST be deterministic for the same inputs.
- Config candidate evaluation order MUST be deterministic.
- Scaffold operation order MUST be deterministic.
- JSON output MUST remain newline-terminated and single-document.
- `runAction()` MUST return the same exit code for the same normalized action outcome.
- `clifn` MUST remain parser-agnostic.
- `clifn` MUST NOT absorb product-specific logic from `extfn` or other CLIs.

# Security

- Sensitive keys in diagnostics, environment-derived config, headers, and subprocess details MUST be redacted by default.
- Config loading MUST read only local repository-relative or explicit filesystem paths; remote URLs are forbidden.
- Scaffolding MUST reject path traversal outside the configured working directory.
- Prompt helpers MUST support deterministic failure in non-interactive environments when prompting is required.
- Subprocess helpers MUST NOT log full environment maps by default.
- Credential-store behavior MUST remain file-path-explicit and MUST NOT silently fall back to remote secret providers.

# Limits/caps

- Config candidate lists MUST be limited to at most `32` entries per load attempt.
- Default subprocess timeout MUST be `30000 ms` unless overridden.
- Default buffered capture per subprocess stream MUST be `1048576` bytes unless overridden.
- Prompt choice lists SHOULD remain under `200` entries for interactive usability; larger lists are allowed but not optimized in this spec.

# Observability

- Output helpers MUST support injected stdout/stderr writers for deterministic tests.
- Runner helpers SHOULD surface collected diagnostics to the caller before final exit-code resolution.
- Exec helpers MUST report duration and timeout state.
- Diagnostics formatters MUST support both human-readable and machine-readable output.
- Debug output MUST be suppressible when `verbose` is disabled.

# Compatibility / versioning strategy

- `clifn` MUST continue using semver.
- Existing subpaths are a compatibility contract.
- New subpaths added by this spec MUST be additive and MUST NOT require consumers to migrate existing imports.
- Compatibility wrappers such as `clifn/ui` MAY be internally reimplemented, but their external behavior MUST remain stable.

# Undefined / Explicitly user-deferred only

- A `clifn`-owned command-parser DSL is undefined and not required.
- A rich terminal UI or curses-style framework is undefined and not required.
- Replacing the current file-based credential store backend is undefined and not required.
- Automatic migration of every existing repository CLI to `clifn` is undefined and not required by this spec bundle.

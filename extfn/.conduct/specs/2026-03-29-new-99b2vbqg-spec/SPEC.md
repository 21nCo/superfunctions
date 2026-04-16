# Metadata

- timestamp: `2026-03-29T01:42:25Z`
- agent_name: `unknown-agent`
- model: `unknown`
- launcher: `Codex Desktop`
- repo root: `repo root`
- OS: `Darwin arm64`
- shell: `zsh`
- git:
  - branch: `detached HEAD`
  - commit: `aa36705f8a38f459903c514d5dab91be4c669185`
  - dirty: `false`
- spec_folder: `2026-03-29-new-99b2vbqg-spec`
- spec_path: `.conduct/specs/2026-03-29-new-99b2vbqg-spec`
- spec_type: `new`
- spec_id: `99b2vbqg`
- input paths:
  - `package.json`
  - `turbo.json`
  - `packages/cli/src/utils/load-library-config.ts`
  - `packages/config/src/index.ts`
  - `packages/envelope/src/index.ts`
  - `packages/errors/src/index.ts`
  - `packages/metrics/src/index.ts`
  - `clifn/core/README.md`
  - `clifn/.conduct/specs/2026-03-29-change-n4k7m2p9-spec/SPEC.md`
  - `datafn/client/README.md`
  - `datafn/client/src/client.ts`
  - `datafn/client/src/adapters/indexedDbStorage.ts`
  - `datafn/client/src/extension/subscriptionManager.ts`
  - `datafn/client/src/extension/transport.ts`
  - `datafn/SECURITY.md`
  - `searchfn/adapter-contracts/src/index.ts`
  - `searchfn/datafn-provider/src/index.ts`
  - `filefn/client/src/types.ts`
  - `packages/files/src/types.ts`
  - `packages/storage/src/types.ts`
  - `authfn/core/src/types.ts`
  - `authfn/core/src/plugin-runner.ts`
  - `external consumer repo descriptor: nucleus monorepo with Vite/SvelteKit apps and extensions and shared client packages using SvelteKit runtime imports`
  - `external legacy extension descriptor: Plasmo based memotron clipper with many isolated content modules, anchored mounts, modular background message and port handlers, and injected UI style-isolation needs`

# Overview

`extfn` is a new browser extension framework that MUST be implemented inside this repository under `extfn/`. It MUST be code-first, Vite-powered, frontend-framework-agnostic at the core, and first-party integrated with Superfunctions packages through plugin contracts rather than through `extfn`-owned domain logic. `nucleus` and other consumer repositories MUST consume `extfn`; they are not part of the implementation scope of this spec.

V1 MUST support:

- Chromium MV3 builds.
- Firefox MV3 builds.
- Background service workers.
- Popup, options, and sidepanel pages.
- Multiple independently matched content script modules.
- Anchored content-script UI mounts and isolated DOM roots.
- Content-style isolation and root normalization for injected UI.
- Typed request/response messaging and event fanout between extension contexts.
- Typed long-lived ports with MV3-aware reconnect semantics.
- A Promise-first browser API facade while preserving direct raw browser globals.
- A first-party mandatory CLI for dev, build, package, and scan workflows.
- A first-party Svelte adapter targeting Svelte 5.
- A vanilla example proving framework-agnostic core behavior.
- A `datafn/extfn` integration package that keeps durable storage and sync authority in the extension background context.

# Glossary

- `extfn`: The framework family implemented in `extfn/`.
- `consumer extension`: A browser extension built using `extfn`.
- `target`: A browser/platform output tuple. V1 targets are `chromium-mv3` and `firefox-mv3`.
- `surface`: A browser-visible extension context such as popup, options, sidepanel, or a content script UI mount.
- `background authority`: The background runtime that owns cross-context coordination and authoritative extension services.
- `context`: One runtime location. V1 contexts are `background`, `popup`, `options`, `sidepanel`, and `content`.
- `content module`: A single content-script entry with its own match rules, lifecycle, and optional UI mounts.
- `anchor`: A DOM location selected or resolved at runtime where a content module MAY mount UI.
- `plugin`: A package-owned integration that contributes manifest, runtime, or build behavior through `extfn` hooks.
- `consumer host abstraction`: A consumer-defined wrapper over host-specific APIs such as navigation and page state. This is informational for migration guidance only and is not implemented by this spec in external repositories.
- `browser facade`: The Promise-first `extfn` wrapper over browser extension APIs.
- `canonical envelope`: The required wire format for runtime requests, responses, and events within `extfn`.
- `scan finding`: One reported issue, risk, or manual-review reminder emitted by `extfn scan`.
- `strict scan`: The default scan mode where any error-severity finding causes a non-zero CLI exit.
- `repository reuse plan`: The required mapping from new `extfn` functionality to existing reusable code already present in this repository.

# Goals / Non-goals

## Goals

- `extfn` MUST provide a code-first extension definition model.
- `extfn` MUST use Vite as the build and dev engine.
- `extfn` core MUST remain frontend-framework-agnostic.
- `extfn` MUST ship a Svelte adapter and a vanilla path without forcing either as the only authoring model.
- `extfn` MUST ship a first-party CLI as the primary developer entrypoint for dev, build, package, and scan.
- `extfn` MUST let domain packages such as `datafn` own their extension integrations.
- `extfn` MUST expose enough hooks to support complex extensions like the legacy clipper shape with many isolated content modules, anchored mounts, modular background message and port handlers, and persistent background coordination.
- `extfn` MUST let consumer extensions access raw browser APIs and a normalized Promise-first browser facade.

## Non-goals

- `extfn` MUST NOT depend on WXT.
- `extfn` MUST NOT require implementation changes in external repositories as part of this spec bundle.
- `extfn` MUST NOT emulate the entire SvelteKit runtime inside extension contexts.
- `extfn` MUST NOT introduce first-party React or Vue adapters in V1, although the core MUST be designed so those adapters can be added later.
- `extfn` MUST NOT define domain-specific data semantics inside `extfn` core; such semantics belong in the owning packages.

# Public API

## Package layout

The implementation MUST create these packages and folders:

- `extfn/core` with package name `@superfunctions/extfn`
- `extfn/vite` with package name `@superfunctions/extfn-vite`
- `extfn/cli` with package name `@superfunctions/extfn-cli`
- `extfn/svelte` with package name `@superfunctions/extfn-svelte`
- `extfn/examples/vanilla-messaging-demo`
- `extfn/examples/svelte-multi-content-demo`
- `extfn/examples/svelte-datafn-demo`
- `datafn/extfn` with package name `@datafn/extfn`

## Repository reuse plan

The implementation MUST avoid duplicating repository-local functionality when an equivalent reusable implementation already exists.

Mandatory reuse targets:

- Generic CLI-building concerns in `extfn/cli` SHOULD reuse `clifn` once the shared primitives exist there, specifically:
  - action runner and exit normalization
  - human and JSON output formatting
  - config discovery and typed config loading
  - env-backed default parsing
  - structured diagnostics formatting
  - subprocess execution helpers
  - safe scaffolding helpers
- If `extfn/cli` needs one of the generic capabilities listed above and `clifn` does not yet expose it, the capability SHOULD be added or extracted into `clifn` first rather than implemented as an `extfn`-local parallel foundation.
- CLI config loading and TypeScript config execution SHOULD reuse the existing Jiti-backed loader pattern already present in `packages/cli`, either by:
  - exporting a shared helper from `@superfunctions/cli`, or
  - extracting a small shared internal utility package,
  instead of creating a second unrelated TS config loader.
- CLI config discovery SHOULD reuse or adapt the existing config discovery patterns already present in `packages/cli` when implementing `--config` resolution or future multi-config workflows.
- Any env-backed CLI parsing introduced for browser launch, scan defaults, or packaging SHOULD reuse `@superfunctions/config` helpers instead of re-implementing ad hoc environment parsing.
- `extfn` typed error registration SHOULD reuse `@superfunctions/errors`, and any response-envelope error shape that needs `status` and `retryable` metadata SHOULD remain compatible with `@superfunctions/envelope` semantics rather than introducing a third repository-local error dialect.
- `extfn` observability SHOULD accept or compose an `@superfunctions/metrics`-compatible emitter instead of defining a repository-unique tracking interface for basic event emission.
- `@datafn/extfn` MUST compose existing `@datafn/client` extension primitives where they already match the required behavior, specifically:
  - `createDatafnClient`
  - extension RPC transport
  - subscription deduplication and teardown
  - IndexedDB-backed durable storage
  - namespace-aware client storage configuration
- Reuse MUST happen through public exports or extracted shared helpers, not through long-term private deep-import coupling across packages.
- `extfn` core MUST NOT depend directly on `hostfn/cli` deployment modules.
- If `hostfn/cli` contains generic logger or validation helpers worth sharing, those helpers MUST be extracted into a shared package before `extfn` consumes them.
- `extfn/cli` MUST retain ownership of extension-specific workflows such as Vite orchestration, browser launching, extension packaging, manifest-aware scan rules, and browser-target validation. Those concerns MUST NOT be moved into `clifn`.

Non-required reuse decisions:

- Future `searchfn/extfn` work SHOULD compose `@searchfn/client`, `@searchfn/adapter-contracts`, and, when browser-persistent local indexes are needed, `@searchfn/adapter-indexeddb` rather than defining extfn-local search contracts.
- Future `searchfn` + `datafn` integration SHOULD prefer the existing `@searchfn/datafn-provider` bridge instead of re-deriving DataFn search-provider semantics inside `extfn`.
- Future `filefn/extfn` work SHOULD compose `@filefn/client`, `@filefn/viewer`, `@superfunctions/files`, and `@superfunctions/storage` rather than defining extfn-local file/storage capability contracts.

## `@superfunctions/extfn`

```ts
export type BrowserTarget = "chromium-mv3" | "firefox-mv3"

export type RuntimeContextKind =
  | "background"
  | "popup"
  | "options"
  | "sidepanel"
  | "content"

export type RunAt = "document_start" | "document_end" | "document_idle"

export interface PageSurfaceConfig {
  entry: string
  html?: string
  title?: string
  mountId?: string
  targets?: readonly BrowserTarget[]
}

export interface AnchorSelectorStrategy {
  kind: "selector"
  selector: string
  observe?: boolean
  uniqueBy?: "element" | "selector"
  mountMode?: "append" | "prepend" | "replace" | "shadow"
}

export interface AnchorSelectorListStrategy {
  kind: "selector-list"
  selector: string
  observe?: boolean
  maxAnchors?: number
  uniqueBy?: "element" | "selector"
  mountMode?: "append" | "prepend" | "replace" | "shadow"
}

export interface AnchorResolverStrategy {
  kind: "resolver"
  exportName?: string
  observe?: boolean
  maxAnchors?: number
  uniqueBy?: "element" | "key"
  mountMode?: "append" | "prepend" | "replace" | "shadow"
}

export type AnchorStrategy =
  | AnchorSelectorStrategy
  | AnchorSelectorListStrategy
  | AnchorResolverStrategy

export interface ContentScriptConfig {
  id: string
  entry: string
  matches: readonly string[]
  excludeMatches?: readonly string[]
  runAt?: RunAt
  allFrames?: boolean
  world?: "ISOLATED" | "MAIN"
  targets?: readonly BrowserTarget[]
  anchors?: readonly AnchorStrategy[]
  css?: readonly string[]
  styleIsolation?: "inherit" | "root-scoped" | "shadow-root"
  normalizeRootStyles?: boolean
}

export interface BackgroundConfig {
  serviceWorker: string
  messageHandlersDir?: string
  portHandlersDir?: string
}

export interface ManifestOverrideConfig {
  permissions?: readonly string[]
  optionalPermissions?: readonly string[]
  hostPermissions?: readonly string[]
  commands?: Record<string, unknown>
  icons?: Record<string, string>
  webAccessibleResources?: readonly unknown[]
}

export interface ExtensionConfig {
  id?: string
  name: string
  version: string
  description?: string
  targets: readonly BrowserTarget[]
  background: BackgroundConfig
  popup?: PageSurfaceConfig
  options?: PageSurfaceConfig
  sidepanel?: PageSurfaceConfig
  contentScripts?: readonly ContentScriptConfig[]
  manifest?: ManifestOverrideConfig
  plugins?: readonly ExtfnPlugin[]
}

export interface BrowserCapabilities {
  target: BrowserTarget
  sidepanel: boolean
  offscreen: boolean
  scripting: boolean
}

export interface RuntimeAddress {
  context: RuntimeContextKind
  surfaceId?: string
  contentScriptId?: string
  tabId?: number
  frameId?: number
}

export interface ExtfnError {
  code:
    | "E_CONFIG_INVALID"
    | "E_TARGET_UNSUPPORTED"
    | "E_MANIFEST_COLLISION"
    | "E_ENTRY_NOT_FOUND"
    | "E_HANDLER_NOT_FOUND"
    | "E_CONTEXT_UNAVAILABLE"
    | "E_TIMEOUT"
    | "E_PAYLOAD_TOO_LARGE"
    | "E_PERMISSION_DENIED"
    | "E_PLUGIN_CONFLICT"
    | "E_RUNTIME_PROTOCOL"
    | "E_ANCHOR_RESOLUTION"
  message: string
  status: number
  retryable: boolean
  details?: Record<string, unknown>
}

export interface RuntimeRequestEnvelope {
  v: 1
  kind: "request"
  requestId: string
  namespace: string
  method: string
  source: RuntimeAddress
  target: RuntimeAddress
  payload: unknown
  timeoutMs?: number
}

export interface RuntimeResponseEnvelope {
  v: 1
  kind: "response"
  requestId: string
  ok: boolean
  result?: unknown
  error?: ExtfnError
}

export interface RuntimeEventEnvelope {
  v: 1
  kind: "event"
  namespace: string
  event: string
  source: RuntimeAddress
  payload: unknown
}

export type PortCloseReason =
  | "client-closed"
  | "target-closed"
  | "background-restarted"
  | "context-unavailable"
  | "protocol-error"

export interface RuntimePortEnvelope {
  v: 1
  kind: "port-message"
  portId: string
  channel: string
  seq: number
  source: RuntimeAddress
  payload: unknown
}

export interface RuntimePortCloseEnvelope {
  v: 1
  kind: "port-close"
  portId: string
  channel: string
  source: RuntimeAddress
  reason: PortCloseReason
}

export interface BrowserFacade {
  raw: unknown
  capabilities: BrowserCapabilities
  call<T = unknown>(path: string, ...args: unknown[]): Promise<T>
  namespace<T extends object = Record<string, unknown>>(path: string): T
}

export interface RpcClient {
  call<T = unknown>(
    namespace: string,
    method: string,
    payload: unknown,
    target?: Partial<RuntimeAddress>,
    options?: { timeoutMs?: number }
  ): Promise<T>
}

export interface EventBus {
  emit(namespace: string, event: string, payload: unknown): Promise<void>
  on(
    namespace: string,
    event: string,
    handler: (payload: unknown, envelope: RuntimeEventEnvelope) => void | Promise<void>
  ): () => void
}

export interface RuntimePort<Inbound = unknown, Outbound = Inbound> {
  id: string
  channel: string
  state: "opening" | "open" | "reconnecting" | "closed"
  send(payload: Outbound): Promise<void>
  onMessage(
    handler: (payload: Inbound, envelope: RuntimePortEnvelope) => void | Promise<void>
  ): () => void
  onClose(
    handler: (envelope: RuntimePortCloseEnvelope) => void | Promise<void>
  ): () => void
  close(): Promise<void>
}

export interface PortClient {
  open<Inbound = unknown, Outbound = Inbound>(
    channel: string,
    target?: Partial<RuntimeAddress>,
    options?: {
      reconnect?: "never" | "background-resume"
      timeoutMs?: number
    }
  ): Promise<RuntimePort<Inbound, Outbound>>
}

export interface ExtfnRuntime {
  address: RuntimeAddress
  browser: BrowserFacade
  rpc: RpcClient
  events: EventBus
  ports: PortClient
}

export interface ManifestContribution {
  permissions?: readonly string[]
  optionalPermissions?: readonly string[]
  hostPermissions?: readonly string[]
  webAccessibleResources?: readonly unknown[]
}

export interface BackgroundHandlerDefinition<P = unknown, R = unknown> {
  namespace: string
  method: string
  handle(
    runtime: ExtfnRuntime,
    payload: P,
    envelope: RuntimeRequestEnvelope
  ): Promise<R> | R
}

export interface BackgroundPortHandlerDefinition<Inbound = unknown, Outbound = Inbound> {
  channel: string
  onConnect?(
    runtime: ExtfnRuntime,
    port: RuntimePort<Inbound, Outbound>,
    source: RuntimeAddress
  ): Promise<void> | void
  onMessage?(
    runtime: ExtfnRuntime,
    payload: Inbound,
    envelope: RuntimePortEnvelope,
    port: RuntimePort<Inbound, Outbound>
  ): Promise<void> | void
  onDisconnect?(
    runtime: ExtfnRuntime,
    envelope: RuntimePortCloseEnvelope,
    port: RuntimePort<Inbound, Outbound>
  ): Promise<void> | void
}

export interface ExtfnPluginContext {
  target: BrowserTarget
  config: ExtensionConfig
}

export interface ExtfnRuntimePluginContext extends ExtfnPluginContext {
  runtime: ExtfnRuntime
}

export type ExtfnPluginTeardown = () => Promise<void> | void

export interface ExtfnPlugin {
  id: string
  dependsOn?: readonly string[]
  contributeManifest?(ctx: ExtfnPluginContext): Promise<ManifestContribution | void> | ManifestContribution | void
  setupBackground?(
    ctx: ExtfnRuntimePluginContext
  ): Promise<ExtfnPluginTeardown | void> | ExtfnPluginTeardown | void
  setupContext?(
    ctx: ExtfnRuntimePluginContext
  ): Promise<ExtfnPluginTeardown | void> | ExtfnPluginTeardown | void
  registerBackgroundHandlers?(
    ctx: ExtfnRuntimePluginContext
  ): Promise<readonly BackgroundHandlerDefinition[] | void> | readonly BackgroundHandlerDefinition[] | void
  registerBackgroundPortHandlers?(
    ctx: ExtfnRuntimePluginContext
  ): Promise<readonly BackgroundPortHandlerDefinition[] | void> | readonly BackgroundPortHandlerDefinition[] | void
}

export declare function defineExtension(config: ExtensionConfig): ExtensionConfig
export declare function defineContentScript(config: ContentScriptConfig): ContentScriptConfig
export declare function defineBackgroundHandler<P = unknown, R = unknown>(
  def: BackgroundHandlerDefinition<P, R>
): BackgroundHandlerDefinition<P, R>
export declare function defineBackgroundPortHandler<Inbound = unknown, Outbound = Inbound>(
  def: BackgroundPortHandlerDefinition<Inbound, Outbound>
): BackgroundPortHandlerDefinition<Inbound, Outbound>
export declare function getRuntime(): ExtfnRuntime
```

## `@superfunctions/extfn-vite`

```ts
import type { Plugin, UserConfig } from "vite"
import type { ExtensionConfig } from "@superfunctions/extfn"

export interface ExtfnViteOptions {
  configFile?: string
  mode?: "development" | "production"
}

export interface LoadedExtensionConfig {
  config: ExtensionConfig
  configPath: string
}

export declare function loadExtensionConfig(configFile?: string): Promise<LoadedExtensionConfig>
export declare function extfnVite(options?: ExtfnViteOptions): Plugin[]
export declare function withExtfnConfig(
  base: UserConfig,
  options?: ExtfnViteOptions
): UserConfig
```

## `@superfunctions/extfn-cli`

The repository MUST ship an installable `extfn` binary backed by `@superfunctions/extfn-cli`.

Command surface:

```sh
extfn dev [--config <path>] [--target <target>] [--open] [--no-open] [--browser <browser>] [--profile <path>]
extfn build [--config <path>] [--target <target>] [--out-dir <path>]
extfn package [--config <path>] [--target <target>] [--out-dir <path>] [--no-scan] [--no-strict]
extfn scan [--config <path>] [--target <target>] [--format text|json|sarif] [--report-file <path>] [--no-strict] [--no-build]
```

Rules:

- `extfn dev` MUST wrap the `@superfunctions/extfn-vite` development workflow rather than implementing a separate bundler.
- `extfn build` MUST wrap the `@superfunctions/extfn-vite` production workflow.
- `extfn package` MUST archive target build outputs into store-uploadable artifacts.
- `extfn scan` MUST emit a structured report and MUST be strict by default.
- All CLI commands MUST accept `--config <path>` and default to repository-local config discovery when it is omitted.
- When multiple targets are configured, `extfn dev` MUST require `--target`.
- When multiple targets are configured, `extfn build`, `extfn package`, and `extfn scan` MUST default to all configured targets unless a narrower target set is requested.

```ts
export type ScanSeverity = "error" | "warning" | "info"

export type ScanCategory =
  | "security"
  | "permissions"
  | "privacy"
  | "performance"
  | "store-quality"
  | "packaging"

export type ScanActionability = "enforceable" | "manual-review"

export interface ScanFinding {
  ruleId: string
  severity: ScanSeverity
  category: ScanCategory
  actionability: ScanActionability
  target: BrowserTarget
  file?: string
  message: string
  recommendation?: string
}

export interface ScanSummary {
  strict: boolean
  errors: number
  warnings: number
  info: number
  passed: boolean
}

export interface ScanReport {
  extensionName: string
  version: string
  generatedAt: string
  targets: readonly BrowserTarget[]
  findings: readonly ScanFinding[]
  summary: ScanSummary
}
```

## `@superfunctions/extfn-svelte`

```ts
import type { Component } from "svelte"

export interface SveltePageMountOptions {
  mountId?: string
  props?: Record<string, unknown>
}

export interface SvelteContentMountOptions {
  props?: Record<string, unknown>
}

export declare function mountSveltePage(
  component: Component<any>,
  options?: SveltePageMountOptions
): void

export declare function mountSvelteContent(
  component: Component<any>,
  target: Element | ShadowRoot,
  options?: SvelteContentMountOptions
): { destroy(): void }
```

## `@datafn/extfn`

```ts
import type { DatafnClient, DatafnClientConfig } from "@datafn/client"
import type { DatafnSchema } from "@datafn/core"
import type { ExtfnPlugin } from "@superfunctions/extfn"

export interface DatafnExtfnOptions<S extends DatafnSchema> {
  schema: S
  clientId: string
  namespace?: DatafnClientConfig<S>["namespace"]
  sync?: DatafnClientConfig<S>["sync"]
  storage?: DatafnClientConfig<S>["storage"]
  plugins?: DatafnClientConfig<S>["plugins"]
  searchProvider?: DatafnClientConfig<S>["searchProvider"]
  requestTimeoutMs?: number
}

export declare function datafnExtfn<S extends DatafnSchema>(
  options: DatafnExtfnOptions<S>
): ExtfnPlugin

export declare function createDatafnExtfnProxyClient<S extends DatafnSchema>(
  options: DatafnExtfnOptions<S>
): DatafnClient<S>
```

# Data formats / protocol

## Runtime request envelope

Every cross-context request MUST use `RuntimeRequestEnvelope`.

Required invariants:

- `v` MUST equal `1`.
- `requestId` MUST be unique per sending runtime instance.
- `namespace` MUST identify the owning service or plugin.
- `method` MUST be stable and case-sensitive.
- `source` MUST describe the actual sender context.
- `target` MUST resolve to one runtime context.

## Runtime response envelope

Every handled request MUST yield exactly one `RuntimeResponseEnvelope`.

- `ok = true` responses MUST contain `result` and MUST NOT contain `error`.
- `ok = false` responses MUST contain `error` and MUST NOT contain `result`.
- `error` MUST include `code`, `message`, `status`, and `retryable`; `details` is optional.
- The error shape SHOULD remain compatible with `@superfunctions/envelope`-style error semantics even though the runtime protocol itself is extension-specific.

## Runtime event envelope

Events are one-way broadcasts. They MUST NOT generate response envelopes.

## Runtime port envelopes

Persistent channel traffic MUST use `RuntimePortEnvelope` and `RuntimePortCloseEnvelope`.

- `portId` MUST be stable for the lifetime of one open channel.
- `seq` MUST increase monotonically per port sender.
- `kind = "port-close"` MUST be emitted exactly once per port lifecycle.

## Background handler module contract

Modules under `background.messageHandlersDir` MUST default-export one `defineBackgroundHandler(...)` value. If a file does not export a valid handler definition, the build MUST fail with `E_CONFIG_INVALID`.

## Background port handler module contract

Modules under `background.portHandlersDir` MUST default-export one `defineBackgroundPortHandler(...)` value. If a file does not export a valid port handler definition, the build MUST fail with `E_CONFIG_INVALID`.

## Manifest generation model

For each target, the generated manifest MUST be the normalized merge of:

1. base `ExtensionConfig`
2. built-in target rules
3. plugin contributions in stable plugin order
4. target-specific filtering

# Semantics

## Config semantics

- `defineExtension()` MUST be the single entry point for top-level authoring.
- `targets` MUST contain at least one target and MUST reject unknown values.
- `loadExtensionConfig()` SHOULD accept `.ts`, `.js`, `.mjs`, `.cjs`, and `.json` through the same shared loader strategy used by `packages/cli`, not through a second independently maintained loader.
- `sidepanel` MAY be declared, but it MUST either:
  - be target-limited to browsers that support it, or
  - cause a deterministic `E_TARGET_UNSUPPORTED` build failure.

## Build semantics

- `extfn` MUST run through Vite dev and build commands.
- Development builds MUST produce unpacked target directories under `dist/<target>-dev`.
- Production builds MUST produce unpacked target directories under `dist/<target>`.
- The build MUST emit one target-specific `manifest.json` per target.
- The build MUST produce stable entry identifiers derived from config IDs, not from source file order.

## CLI semantics

- `extfn dev` MUST start a watch-driven development session for one selected target.
- `extfn dev` MUST emit the active dev target to `dist/<target>-dev`.
- `extfn dev` MUST either:
  - launch the requested browser with the unpacked extension loaded when `--open` is enabled, or
  - print the unpacked load path and keep watching when `--no-open` is enabled.
- `extfn build` MUST build one or more targets into `dist/<target>`.
- `extfn package` MUST build the requested targets if required, run `extfn scan` unless `--no-scan` is set, and emit deterministic archives under the requested package output directory.
- `extfn package` MUST emit `.zip` archives for Chromium targets and `.xpi` archives for Firefox targets.
- CLI exit codes MUST be deterministic:
  - `0` for success with no blocking scan findings
  - `1` for scan failures in strict mode
  - `2` for usage or configuration failures
  - `3` for build, package, or runtime orchestration failures

## Dev semantics

- Popup, options, and sidepanel surfaces SHOULD use HMR when the framework adapter supports it.
- Background changes MUST trigger extension reload.
- Content-script code changes MUST reinject or reload according to whether HMR is declared safe for that adapter.
- Firefox dev mode MAY fall back to full reload more often than Chromium, but MUST preserve correctness.
- Persistent ports affected by background reload MUST emit a deterministic close or reconnect transition rather than silently hanging.

## Scan semantics

- `extfn scan` MUST analyze generated manifests, packaged outputs, and bundled code unless `--no-build` is explicitly requested and valid build outputs already exist.
- `extfn scan` MUST emit structured findings with `ruleId`, `severity`, `category`, `actionability`, `target`, and a human-readable recommendation when available.
- `extfn scan` MUST distinguish:
  - enforceable findings that can be derived from static analysis with high confidence
  - manual-review findings that remind the developer about store-review items that cannot be proven statically
- At minimum, `extfn scan` MUST detect or report:
  - Manifest V3 violations for supported targets
  - remote-hosted-code or remote-execution patterns in bundled outputs
  - insecure transport usage such as `http://` endpoints in shipped extension code or manifests, except for loopback development allowances
  - broad or warning-bearing permissions and host-permission usage, including `<all_urls>` and opportunities for optional permissions or `activeTab`
  - unsafe dynamic execution patterns such as `eval` or `new Function`
  - manifest CSP or externally connectable patterns that expand risk beyond the extension's stated purpose
  - content-script patterns that can harm performance or bfcache, including long-lived network sockets in content contexts
  - manual-review reminders for privacy disclosures, single-purpose alignment, and store-listing completeness
- `extfn scan` MUST be strict by default.
- `extfn scan --no-strict` MUST still emit the full report while returning success unless the command itself fails.
- `extfn package` MUST inherit strict scan behavior by default and MUST support `--no-strict` and `--no-scan`.

## Runtime context semantics

- `getRuntime().address.context` MUST report the actual executing context.
- `getRuntime().browser.raw` MUST expose the underlying raw browser global.
- `getRuntime().browser.call()` MUST normalize callback-style and Promise-style browser APIs into Promise-returning calls.
- `getRuntime().browser.namespace()` MUST return a namespace proxy backed by the same normalization layer.

## Browser capability semantics

- `capabilities` MUST be target-specific.
- Unsupported APIs MUST NOT be silently polyfilled as working features when the browser does not support them.
- Unsupported APIs MUST be detectable through `capabilities` before runtime use.

## Messaging semantics

- Background is the default authority for requests unless a target address is provided.
- Request routing MUST be namespace-first, method-second.
- Unknown namespace or method MUST return `E_HANDLER_NOT_FOUND`.
- Request ordering MUST be preserved per sender and namespace for in-flight messages dispatched serially over the same runtime client.
- Event emission MUST preserve per-emitter order within the same namespace and event name.

## Port semantics

- Ports MUST be background-brokered in V1.
- Port channels MUST support ordered bidirectional messages.
- Unknown channels MUST fail with `E_HANDLER_NOT_FOUND`.
- Port close semantics MUST be explicit through `RuntimePortCloseEnvelope`.
- `background.portHandlersDir` MUST allow modular handler files similar in capability to a `background/ports/*.ts` tree.
- File naming MUST NOT define port protocol names by itself if the file explicitly exports `channel`.
- Duplicate `channel` registrations MUST fail with `E_MANIFEST_COLLISION`.
- When `reconnect = "background-resume"` is enabled, a background suspension or restart MUST move the client into `reconnecting`, attempt bounded reconnection, and either:
  - restore the same logical channel without duplicate listeners, or
  - close with reason `context-unavailable`.

## Content-script semantics

- Multiple content modules MAY match the same page. Each MUST remain isolated by `contentScripts[].id`.
- Each content module MUST receive its own deterministic DOM root key.
- Anchor strategies MUST support:
  - single selector mount
  - selector list mount
  - user-defined resolver export
- Missing anchors MUST be a no-op, not a hard runtime failure.
- Anchor resolution failures MUST surface `E_ANCHOR_RESOLUTION` logs without crashing unrelated content modules.
- Reinjection after navigation or DOM replacement MUST be idempotent.
- `styleIsolation` MUST support `inherit`, `root-scoped`, and `shadow-root`.
- When `normalizeRootStyles = true`, the content mount root MUST receive a deterministic typography and box-model baseline.
- Content style attachment MUST be idempotent across first mount and reinjection.
- Resolver-based anchors MAY be used to support host pages that require custom traversal, including shadow-DOM-aware lookup.

## Background message module semantics

- `background.messageHandlersDir` MUST allow modular handler files similar in capability to a `background/messages/*.ts` tree.
- File naming MUST NOT define protocol names by itself if the file explicitly exports `namespace` and `method`.
- Duplicate `namespace + method` combinations MUST fail with `E_MANIFEST_COLLISION`.

## Background port module semantics

- `background.portHandlersDir` MUST allow modular handler files similar in capability to a `background/ports/*.ts` tree.
- Port handlers MUST own one stable `channel` each.
- Duplicate `channel` combinations MUST fail with `E_MANIFEST_COLLISION`.

## Plugin semantics

- Plugins MUST live in their owning packages.
- `extfn` core MUST expose hooks only; it MUST NOT embed domain-specific logic for `datafn`, `authfn`, or `searchfn`.
- `extfn` MUST expose runtime bootstrap hooks so package-owned integrations can start and stop authorities without moving their domain logic into `extfn` core.
- Plugin execution order MUST be deterministic:
  - first by dependency resolution
  - then by user-specified config order for equal dependency depth
- `setupBackground()` MUST run once per live background lifecycle before the plugin's handlers begin serving requests and MAY return teardown logic.
- `setupContext()` MUST run once per non-background context bootstrap and MAY return teardown logic used during dev reloads or context shutdown.
- Permission and manifest contributions from plugins MUST merge additively unless they collide on single-owner fields.
- Package-owned plugin namespaces SHOULD match the owning package or bounded subdomain, for example `datafn`, `searchfn`, or `filefn.viewer`.

## DataFn integration semantics

- `@datafn/extfn` MUST own DataFn extension integration logic.
- The authoritative DataFn client instance MUST live in the background context.
- Non-background contexts MUST communicate with DataFn through `extfn` runtime envelopes.
- Durable storage and remote sync MUST be owned by the background DataFn authority.
- `@datafn/extfn` MUST compose the public `@datafn/client` surface rather than duplicating it, specifically `createDatafnClient`, `IndexedDbStorageAdapter`, `createExtensionTransport`, and `ExtensionSubscriptionManager` once those extension helpers are publicly exported.
- `DatafnExtfnOptions` MUST stay aligned with the actual public `DatafnClientConfig` surface on this repository branch; unsupported fields such as `authContext` MUST NOT appear in the extfn integration contract unless they first exist in `@datafn/client`.
- `namespace`, `storage`, `plugins`, `searchProvider`, and `sync` options MUST forward predictably into the authoritative background DataFn client configuration.
- Subscriptions MUST fan out background-originated events to popup, options, sidepanel, and content contexts.
- Background restarts MUST either reconnect and restore active proxy subscriptions or fail them explicitly without duplicate registrations.
- The existing `datafn/client` extension transport semantics MUST be preserved or strengthened, not weakened.

## Future SearchFn integration semantics

- A future `searchfn/extfn` package SHOULD own SearchFn extension logic rather than `extfn` core.
- If extension-wide shared or persistent search state is needed, the authoritative `SearchAdapter` instance SHOULD live in background context so popup, options, sidepanel, and content consumers can share one extension-origin index.
- The integration SHOULD compose `@searchfn/client` and `@searchfn/adapter-contracts`; when browser-persistent local indexes are required it SHOULD prefer `@searchfn/adapter-indexeddb` rather than a new extfn-owned index layer.
- When SearchFn participates in DataFn-backed search, the integration SHOULD prefer `@searchfn/datafn-provider` over an extfn-local SearchProvider bridge.

## Future FileFn integration semantics

- A future `filefn/extfn` package SHOULD own FileFn extension logic rather than `extfn` core.
- Privileged upload-session creation, signed URL access, and other credential-bearing operations SHOULD remain background-mediated.
- The integration SHOULD compose `@filefn/client` for transport behavior, `@filefn/viewer` for render-resolution behavior, and shared `@superfunctions/files` and `@superfunctions/storage` contracts for file/storage capability descriptions.
- Content and page contexts MAY receive viewer descriptors, upload handles, or proxy results through runtime envelopes, but MUST NOT receive raw storage credentials or long-lived privileged secrets.

## Example validation semantics

The implementation MUST ship example extensions that validate:

- vanilla messaging and browser API access
- Svelte page and content-script mounting
- multiple isolated anchored content modules
- background handler directory support
- DataFn background authority plus proxy clients
- CLI-driven dev, build, package, and scan flows

# Invariants

- Generated manifests MUST be deterministic for the same input tree, target, and mode.
- Plugin ordering MUST be deterministic.
- Entry IDs, content-script IDs, and handler route IDs MUST be deterministic and case-sensitive.
- Request `requestId` values MAY vary per runtime instance; all other envelope fields MUST be deterministic for the same call inputs.
- Payload serialization MUST use structured-clone-safe data only.
- No context other than background MAY become the authoritative owner of `@datafn/extfn` storage and sync.
- Runtime error envelopes MUST always carry `status` and `retryable` metadata.
- Silent last-writer-wins behavior for manifest collisions is forbidden.
- CLI scan reports and package archive names MUST be deterministic for the same build input, target set, and strictness mode.

# Security

- Manifest permissions MUST be explicit and target-aware.
- Browser API helper layers MUST NOT grant access to APIs that are not available to the executing context.
- Runtime handlers MUST validate namespace and method before dispatch.
- Logs MUST NOT include auth tokens, cookies, raw personally identifying payloads, or entire DataFn records by default.
- Content-script mounts MUST namespace DOM roots to avoid accidental host-page collisions.
- The scan command MUST default to surfacing blocking security findings before packaging or release artifacts are emitted.

# Limits/caps

- `namespace` MUST be 1 to 64 ASCII characters.
- `method` MUST be 1 to 64 ASCII characters.
- Serialized request payloads larger than `8 MiB` MUST fail with `E_PAYLOAD_TOO_LARGE`.
- Default request timeout MUST be `30000 ms` unless overridden per call.
- `maxAnchors` MAY be set per anchor strategy; when unset it is unlimited by `extfn` and only constrained by browser/runtime resources.

# Observability

- Build logs MUST include target, extension name, and failing config path on errors.
- Runtime error logs MUST include `code`, `namespace`, `method`, and source/target context metadata.
- Dev reload logs SHOULD indicate whether an update used HMR, reinjection, or full reload.
- DataFn authority logs MUST include lifecycle boundaries for start, stop, sync start, sync stop, and subscription fanout counts.
- `extfn` observability sinks SHOULD support `@superfunctions/metrics`-compatible emitters for package-owned plugin lifecycle and scan-rule telemetry.
- Observability output MUST redact sensitive payload fields by default.
- Scan reports MUST support human-readable output and machine-readable output.

# Compatibility / versioning strategy

- The runtime envelope protocol version MUST begin at `v = 1`.
- Any future envelope-breaking change MUST increment `v`.
- `extfn` packages MUST use semver.
- V1 compatibility scope is limited to:
  - `chromium-mv3`
  - `firefox-mv3`
- Any other browser target is unsupported unless added by a future spec.

# Undefined / Explicitly user-deferred only

- First-party framework adapters beyond Svelte are user-deferred after V1. The core architecture MUST remain adapter-ready, but no first-party React or Vue adapter is required by this spec bundle.

# Table of Contents

- CFG-001
- CFG-002
- SURF-001
- SURF-002
- SURF-003
- BLD-001
- BLD-002
- BLD-003
- CLI-001
- CLI-002
- CLI-003
- CTX-001
- CTX-002
- CTX-003
- MSG-001
- MSG-002
- MSG-003
- MSG-004
- MSG-005
- CNT-001
- CNT-002
- CNT-003
- CNT-004
- PLG-001
- PLG-002
- PLG-003
- FWK-001
- FWK-002
- DFX-001
- DFX-002
- DFX-003
- DFX-004
- REUSE-001
- REUSE-002
- SCN-001
- SCN-002
- SEC-001
- OBS-001
- EX-001
- DOC-001

## CFG-001

- ID: `CFG-001`
- Priority: `P0`
- Statement: `extfn` MUST define browser extensions through a single code-first `defineExtension()` configuration entry point.
- Rationale: A single declarative config is required for deterministic builds, plugin contribution, and target-specific validation.
- Acceptance criteria:
  - A consumer extension exposes one `extfn.config.ts` entry file that default-exports `defineExtension(...)`.
  - The loader rejects missing default exports or non-object returns with `E_CONFIG_INVALID`.
  - The loader resolves relative entry paths from the config file directory.
- Test vectors: `TV-CFG-001`
- Notes: Manual manifest-first authoring is out of scope for V1.

## CFG-002

- ID: `CFG-002`
- Priority: `P0`
- Statement: `extfn` MUST validate browser targets explicitly and reject unsupported or ambiguously scoped target features.
- Rationale: Firefox MV3 and Chromium MV3 differ on supported features; silent drift would produce invalid builds.
- Acceptance criteria:
  - `targets` rejects unknown values.
  - A feature unsupported on one target either has explicit target scoping or fails with `E_TARGET_UNSUPPORTED`.
  - Validation runs before Vite output emission.
- Test vectors: `TV-CFG-002`
- Notes: V1 target set is limited to `chromium-mv3` and `firefox-mv3`.

## SURF-001

- ID: `SURF-001`
- Priority: `P0`
- Statement: `extfn` MUST support popup, options, and sidepanel page surfaces as code-first page definitions.
- Rationale: Complex extensions require multiple page surfaces and target-specific manifest emission.
- Acceptance criteria:
  - Popup and options page definitions compile into target manifests and page entry bundles.
  - Sidepanel generation is target-aware.
  - Missing page entry files fail with `E_ENTRY_NOT_FOUND`.
- Test vectors: `TV-SURF-001`
- Notes: V1 does not require devtools panel authoring.

## SURF-002

- ID: `SURF-002`
- Priority: `P0`
- Statement: `extfn` MUST support one background service worker plus modular background message handlers loaded from a configured handlers directory.
- Rationale: The legacy clipper shape depends on both a background authority entry and many isolated background handler modules.
- Acceptance criteria:
  - A configured `serviceWorker` entry emits one background bundle per target.
  - `messageHandlersDir` discovers modular handler files.
  - Invalid handler exports fail with `E_CONFIG_INVALID`.
  - Duplicate `namespace + method` combinations fail with `E_MANIFEST_COLLISION`.
- Test vectors: `TV-SURF-002`
- Notes: Directory discovery is capability-oriented and need not reproduce Plasmo file naming exactly.

## SURF-003

- ID: `SURF-003`
- Priority: `P0`
- Statement: `extfn` MUST support modular background port handlers loaded from a configured handlers directory.
- Rationale: The legacy clipper shape includes persistent background ports in addition to one-shot message handlers, and `extfn` needs a first-class equivalent.
- Acceptance criteria:
  - `BackgroundConfig.portHandlersDir` discovers modular handler files.
  - Each discovered handler contributes one stable `channel`.
  - Invalid port handler exports fail with `E_CONFIG_INVALID`.
  - Duplicate port channel registrations fail with `E_MANIFEST_COLLISION`.
  - Port handler discovery can coexist with `messageHandlersDir` in the same extension.
- Test vectors: `TV-SURF-003`
- Notes: Directory discovery is capability-oriented and need not reproduce Plasmo file naming exactly.

## BLD-001

- ID: `BLD-001`
- Priority: `P0`
- Statement: `extfn` MUST integrate with Vite as the build and dev engine without depending on WXT.
- Rationale: The framework direction is Vite-based and fully owned inside this repository.
- Acceptance criteria:
  - `@superfunctions/extfn-vite` exports a Vite plugin entry.
  - Example extensions run through `vite dev` and `vite build`.
  - No runtime or build dependency on WXT is present.
- Test vectors: `TV-BLD-001`
- Notes: This requirement does not forbid ordinary Vite ecosystem dependencies.

## BLD-002

- ID: `BLD-002`
- Priority: `P0`
- Statement: `extfn` MUST emit deterministic target-specific build outputs and manifests for both Chromium MV3 and Firefox MV3.
- Rationale: Consumer extensions need reproducible unpacked outputs and target-correct manifests.
- Acceptance criteria:
  - `dist/chromium-mv3` and `dist/firefox-mv3` are emitted in production mode when both targets are configured.
  - `dist/chromium-mv3-dev` and `dist/firefox-mv3-dev` are emitted in dev mode.
  - Generated manifest structure is stable for identical inputs.
  - Hash-bearing asset filenames MAY vary only when source content changes.
- Test vectors: `TV-BLD-002`
- Notes: Deterministic ordering applies to manifest keys, entries, plugin contributions, and route IDs.

## BLD-003

- ID: `BLD-003`
- Priority: `P0`
- Statement: `extfn` MUST implement a correctness-first dev update policy that uses HMR where safe and full reload or reinjection where required.
- Rationale: Extension contexts have different reload constraints; HMR cannot be assumed everywhere.
- Acceptance criteria:
  - Popup, options, and sidepanel updates MAY use HMR if the adapter declares support.
  - Background changes trigger extension reload.
  - Content script changes trigger reinjection or reload according to adapter capability.
  - The dev server logs which strategy was applied.
- Test vectors: `TV-BLD-003`
- Notes: Firefox MAY use more conservative reload behavior than Chromium.

## CLI-001

- ID: `CLI-001`
- Priority: `P0`
- Statement: `extfn` MUST ship a first-party CLI under `extfn/cli` that exposes the canonical `extfn` binary for development and release workflows.
- Rationale: A framework-level CLI is required for cohesive developer ergonomics, packaging, and repository-owned workflows.
- Acceptance criteria:
  - `extfn/cli` exists as a package with an installable `extfn` binary.
  - The CLI exposes `dev`, `build`, `package`, and `scan` commands.
  - All CLI commands accept `--config <path>`.
  - The CLI uses `@superfunctions/extfn-vite` rather than introducing a separate bundler.
  - Generic CLI concerns in `extfn/cli`, including action running, output formatting, config loading, env parsing, diagnostics formatting, subprocess execution, and scaffolding, reuse `clifn` when the shared primitives exist there.
- Test vectors: `TV-CLI-001`
- Notes: Wrapper ownership belongs to the repository; command names are part of the contract.

## CLI-002

- ID: `CLI-002`
- Priority: `P0`
- Statement: `extfn dev` MUST orchestrate the watch-mode development cycle for one selected target, including browser loading behavior and correctness-first reload handling.
- Rationale: Typical development needs one canonical command that starts the extension, watches changes, and applies the correct reload strategy.
- Acceptance criteria:
  - `extfn dev` requires `--target` when the config declares more than one target.
  - `extfn dev` emits the active unpacked extension under `dist/<target>-dev`.
  - `extfn dev --open` launches the requested browser session when supported.
  - `extfn dev --no-open` prints the unpacked load path and continues watching.
  - Dev updates follow the same HMR, reinjection, and reload rules defined for the Vite runtime.
- Test vectors: `TV-CLI-002`
- Notes: The browser launch surface is orchestration, not a replacement for manual browser loading when the developer opts out.

## CLI-003

- ID: `CLI-003`
- Priority: `P0`
- Statement: `extfn build` and `extfn package` MUST produce deterministic build artifacts and store-uploadable archives for the selected targets.
- Rationale: Packaging is a core extension workflow and must be owned by the framework rather than left to ad hoc scripts.
- Acceptance criteria:
  - `extfn build` builds all configured targets by default, or the requested subset when `--target` is provided.
  - `extfn package` builds if required and emits deterministic archives under the selected package output directory.
  - Chromium package outputs use `.zip`.
  - Firefox package outputs use `.xpi`.
  - `extfn package` runs scan by default unless `--no-scan` is provided.
- Test vectors: `TV-CLI-003`
- Notes: Archive byte-for-byte equality MAY vary when timestamps are intentionally normalized by the packager, but file membership and naming MUST remain deterministic.

## CTX-001

- ID: `CTX-001`
- Priority: `P0`
- Statement: `extfn` MUST expose the actual runtime context and address metadata through `getRuntime()`.
- Rationale: Cross-context messaging and plugin behavior depend on knowing where code is executing.
- Acceptance criteria:
  - `getRuntime().address.context` returns `background`, `popup`, `options`, `sidepanel`, or `content`.
  - Content contexts include `contentScriptId`, and SHOULD include `tabId` and `frameId` when available.
  - Incorrect or unavailable context metadata yields `E_CONTEXT_UNAVAILABLE`.
- Test vectors: `TV-CTX-001`
- Notes: Runtime address metadata is part of canonical envelopes.

## CTX-002

- ID: `CTX-002`
- Priority: `P0`
- Statement: `extfn` MUST provide a Promise-first browser facade while preserving direct access to the raw browser global.
- Rationale: Developers need cross-browser ergonomics without losing the full underlying API surface.
- Acceptance criteria:
  - `getRuntime().browser.raw` exposes the underlying raw browser object.
  - `call()` normalizes callback-style and Promise-style methods into Promise-returning calls.
  - `namespace()` provides namespace-level proxy access.
  - Unsupported method paths fail deterministically with `E_CONTEXT_UNAVAILABLE` or `E_TARGET_UNSUPPORTED`.
- Test vectors: `TV-CTX-002`
- Notes: `extfn` is not required to hand-wrap every browser API namespace individually.

## CTX-003

- ID: `CTX-003`
- Priority: `P0`
- Statement: `extfn` MUST expose a target-specific capability registry for browser features that are not uniformly available across supported targets.
- Rationale: Consumers need a reliable way to gate features such as sidepanel support.
- Acceptance criteria:
  - `capabilities.target` reports the active target.
  - At minimum, `sidepanel`, `offscreen`, and `scripting` capability flags are provided.
  - Capability values are derived from target rules, not hard-coded consumer assumptions.
- Test vectors: `TV-CTX-003`
- Notes: Capabilities report availability, not permission grants.

## MSG-001

- ID: `MSG-001`
- Priority: `P0`
- Statement: `extfn` MUST use canonical versioned request, response, and event envelopes for cross-context communication.
- Rationale: A stable protocol is required for plugins, background services, and future compatibility.
- Acceptance criteria:
  - Every request contains `v`, `kind`, `requestId`, `namespace`, `method`, `source`, `target`, and `payload`.
  - Every response contains `v`, `kind`, `requestId`, and either `result` or `error`.
  - Every event contains `v`, `kind`, `namespace`, `event`, `source`, and `payload`.
  - Invalid envelopes fail with `E_RUNTIME_PROTOCOL`.
- Test vectors: `TV-MSG-001`
- Notes: Envelope version starts at `1`.

## MSG-002

- ID: `MSG-002`
- Priority: `P0`
- Statement: `extfn` MUST route request/response messaging by namespace and method and return explicit errors for unknown handlers, timeouts, and oversized payloads.
- Rationale: Explicit failures are required for reliable debugging and plugin interoperability.
- Acceptance criteria:
  - Unknown namespace or method returns `E_HANDLER_NOT_FOUND`.
  - Timed-out requests return `E_TIMEOUT`.
  - Requests exceeding the payload cap return `E_PAYLOAD_TOO_LARGE`.
  - Exactly one response is emitted per handled request.
- Test vectors: `TV-MSG-002`
- Notes: Timeout defaults to `30000 ms`.

## MSG-003

- ID: `MSG-003`
- Priority: `P0`
- Statement: `extfn` MUST provide a namespaced event bus that supports fanout from background to popup, options, sidepanel, and content contexts.
- Rationale: Extension UIs and data services need publish/subscribe communication beyond one-shot RPC.
- Acceptance criteria:
  - Background can emit events to multiple listeners in other contexts.
  - Per-emitter event ordering is preserved by namespace and event name.
  - Listener registration returns an unsubscribe function.
  - Handler errors are isolated and do not break unrelated listeners.
- Test vectors: `TV-MSG-003`
- Notes: V1 does not require durable event replay after browser restart.

## MSG-004

- ID: `MSG-004`
- Priority: `P0`
- Statement: `extfn` MUST provide a typed long-lived port/channel abstraction for bidirectional communication between background and other extension contexts.
- Rationale: Complex extensions need persistent channels for streaming, delegation, and background-mediated coordination that go beyond one-shot RPC and broadcast events.
- Acceptance criteria:
  - `getRuntime().ports` exposes a typed API for opening named channels.
  - Port channels preserve message ordering per port.
  - Unknown channels fail with `E_HANDLER_NOT_FOUND`.
  - Port close notifications are explicit and deterministic.
  - Port lifecycle APIs support explicit client-side close and teardown.
- Test vectors: `TV-MSG-004`
- Notes: V1 port routing is background-brokered even when the logical peers are non-background contexts.

## MSG-005

- ID: `MSG-005`
- Priority: `P0`
- Statement: `extfn` MUST handle MV3 background suspension or restart deterministically for persistent channels and active subscription-style listeners.
- Rationale: MV3 service workers are ephemeral; the framework must define what happens when background authority disappears and returns.
- Acceptance criteria:
  - A background-origin port disconnect caused by service-worker suspension or reload produces an explicit close reason.
  - A port opened with background-resume behavior attempts bounded reconnection automatically.
  - Successful reconnection restores channel delivery without duplicating listeners or subscription registrations.
  - Failed recovery ends in an explicit unavailable-state outcome.
- Test vectors: `TV-MSG-005`
- Notes: This requirement covers both ordinary MV3 suspension and dev-time background reloads.

## CNT-001

- ID: `CNT-001`
- Priority: `P0`
- Statement: `extfn` MUST support multiple independently matched and independently bundled content modules in one extension.
- Rationale: The legacy clipper shape depends on many isolated content modules targeting different sites and page shapes.
- Acceptance criteria:
  - Multiple content modules can share broad host matches without clobbering each other.
  - Each content module has a deterministic `id`.
  - Each module emits an isolated DOM root key.
  - Missing content module entry files fail with `E_ENTRY_NOT_FOUND`.
- Test vectors: `TV-CNT-001`
- Notes: Isolation here means runtime identity and mount identity, not necessarily separate browser processes.

## CNT-002

- ID: `CNT-002`
- Priority: `P0`
- Statement: `extfn` MUST support anchored content-script UI mounts through selector, selector-list, and resolver strategies.
- Rationale: The framework must cover inline and per-anchor UI injection patterns used by clipper-style extensions.
- Acceptance criteria:
  - Single-anchor selector mounts work.
  - Multi-anchor selector-list mounts work.
  - Resolver-export mounts work.
  - Zero matched anchors become a no-op.
  - Resolver failures log `E_ANCHOR_RESOLUTION` without crashing unrelated content modules.
- Test vectors: `TV-CNT-002`
- Notes: Mount mode MUST support at least `append`, `prepend`, `replace`, and `shadow`.

## CNT-003

- ID: `CNT-003`
- Priority: `P0`
- Statement: `extfn` MUST reinject or remount content modules idempotently across navigation and host DOM replacement events.
- Rationale: Modern sites frequently tear down and recreate DOM trees, especially single-page apps.
- Acceptance criteria:
  - A remount does not duplicate an existing mount for the same module and anchor identity.
  - Recovered mounts restore messaging connectivity.
  - Reinjection failures are scoped to the failing module.
- Test vectors: `TV-CNT-003`
- Notes: V1 does not require preserving in-memory UI component state across full page reloads.

## CNT-004

- ID: `CNT-004`
- Priority: `P0`
- Statement: `extfn` MUST support content-module style isolation and root normalization so injected UI remains readable and deterministic on host pages.
- Rationale: Host-page CSS and typography drift are a known pain point for injected extension UI and must be handled deliberately.
- Acceptance criteria:
  - A content module can opt into `inherit`, `root-scoped`, or `shadow-root` style isolation.
  - When root normalization is enabled, the mount root receives a deterministic typography and box-model baseline.
  - Content styles attach idempotently across initial mount and reinjection.
  - Style attachment respects the selected mount root or shadow root rather than leaking unpredictably into unrelated document scope.
- Test vectors: `TV-CNT-004`
- Notes: Style isolation protects extension UI from host CSS drift; it does not guarantee full layout independence from the page.

## PLG-001

- ID: `PLG-001`
- Priority: `P0`
- Statement: Domain integrations for `extfn` MUST live in their owning packages and integrate through `extfn` plugin hooks rather than through `extfn`-owned domain code.
- Rationale: Ownership and dependency direction must remain clear across Superfunctions packages.
- Acceptance criteria:
  - `extfn` core exports plugin hook contracts only.
  - `datafn/extfn` is implemented outside `extfn/`.
  - No `datafn`-specific runtime semantics are hard-coded in `extfn` core.
- Test vectors: `TV-PLG-001`
- Notes: This requirement applies equally to future `authfn` and `searchfn` integrations.

## PLG-002

- ID: `PLG-002`
- Priority: `P0`
- Statement: `extfn` MUST resolve plugin ordering deterministically and fail on conflicting single-owner contributions.
- Rationale: Plugin systems become fragile when contribution ordering or ownership is ambiguous.
- Acceptance criteria:
  - Dependency-aware ordering is deterministic.
  - Equal-depth plugins preserve user config order.
  - Conflicting single-owner contributions fail with `E_PLUGIN_CONFLICT` or `E_MANIFEST_COLLISION`.
  - Additive list contributions merge deterministically.
- Test vectors: `TV-PLG-002`
- Notes: Permission arrays count as additive contributions.

## PLG-003

- ID: `PLG-003`
- Priority: `P0`
- Statement: `extfn` MUST expose deterministic runtime bootstrap and teardown hooks so package-owned integrations can initialize per-context services without moving domain logic into `extfn` core.
- Rationale: The current plugin shape is insufficient for background-owned authorities such as DataFn and future package-owned authorities such as SearchFn.
- Acceptance criteria:
  - `ExtfnPlugin` exposes a background bootstrap hook and a non-background context bootstrap hook.
  - Background bootstrap runs once per live background lifecycle before plugin-owned handlers begin serving traffic.
  - Bootstrap hooks MAY return teardown functions used during reload or context shutdown.
  - Hook ordering follows the same deterministic plugin ordering rules as other plugin contributions.
- Test vectors: `TV-PLG-003`
- Notes: Package-owned integrations decide whether they need both hooks or only one of them.

## FWK-001

- ID: `FWK-001`
- Priority: `P0`
- Statement: `extfn` core MUST be frontend-framework-agnostic and MUST NOT require Svelte or any other UI framework to author background, messaging, content, or page definitions.
- Rationale: The framework must be reusable beyond Svelte while still starting with a Svelte adapter.
- Acceptance criteria:
  - `@superfunctions/extfn` and `@superfunctions/extfn-vite` do not depend on Svelte packages.
  - The vanilla example builds and runs without Svelte dependencies.
  - Core content and messaging APIs are expressed in TypeScript, not framework-specific abstractions.
- Test vectors: `TV-FWK-001`
- Notes: Framework-specific adapters are separate packages.

## FWK-002

- ID: `FWK-002`
- Priority: `P0`
- Statement: V1 MUST ship both a first-party Svelte adapter and a vanilla example path that prove the same core extension model.
- Rationale: The discussion explicitly requires Svelte-first support and a non-Svelte validation path.
- Acceptance criteria:
  - `@superfunctions/extfn-svelte` exists and targets Svelte 5.
  - One example extension uses the Svelte adapter.
  - One example extension uses only vanilla HTML and TypeScript.
- Test vectors: `TV-FWK-002`
- Notes: Additional first-party adapters are explicitly deferred beyond V1.

## DFX-001

- ID: `DFX-001`
- Priority: `P0`
- Statement: A `datafn/extfn` package MUST be implemented under `datafn/` and MUST expose a plugin plus proxy client surface for extension consumers.
- Rationale: DataFn integration belongs with DataFn ownership and must still be first-class for extension consumers.
- Acceptance criteria:
  - `datafn/extfn` exists as its own package.
  - It exports a plugin factory and a proxy client factory.
  - The package depends on `@datafn/client`, `@datafn/core`, and `@superfunctions/extfn`.
- Test vectors: `TV-DFX-001`
- Notes: Folder placement is part of the requirement, not merely documentation.

## DFX-002

- ID: `DFX-002`
- Priority: `P0`
- Statement: `@datafn/extfn` MUST keep durable storage and sync authority in the background context.
- Rationale: The user explicitly requires background-mediated coordination because content scripts must not each become durable authorities.
- Acceptance criteria:
  - Only background initializes the authoritative DataFn client in authority mode.
  - Non-background contexts cannot start authority mode successfully.
  - Sync lifecycle runs through background-owned services.
  - Durable storage is rooted in extension-origin storage, not content-page origins.
- Test vectors: `TV-DFX-002`
- Notes: Background authority MAY use IndexedDB from the extension service worker.

## DFX-003

- ID: `DFX-003`
- Priority: `P0`
- Statement: `@datafn/extfn` MUST provide proxy query, mutation, transaction, sync, and subscription semantics to non-background contexts through `extfn` envelopes.
- Rationale: Popup, options, sidepanel, and content contexts need a lightweight client experience without owning authority.
- Acceptance criteria:
  - Proxy clients can issue DataFn query and mutation operations through the runtime bus.
  - Subscription events are fanned out from background to active contexts.
  - Request and subscription teardown is deterministic and leak-free.
  - Subscription clients recover after background restart when resumable transport is enabled, or fail explicitly without duplicate registration.
  - Transport failures surface explicit `ExtfnError` codes.
- Test vectors: `TV-DFX-003`
- Notes: Existing `datafn/client` extension transport behavior is a lower bound for V1.

## DFX-004

- ID: `DFX-004`
- Priority: `P0`
- Statement: `@datafn/extfn` MUST align its option surface and proxy client surface with the public `@datafn/client` API that exists on this repository branch.
- Rationale: The imported spec used an outdated mental model and currently references unsupported configuration such as `authContext`.
- Acceptance criteria:
  - `DatafnExtfnOptions` is defined in terms of the public `DatafnClientConfig` shape that actually exists on this branch.
  - Unsupported keys absent from `@datafn/client`, including `authContext`, do not appear in the `@datafn/extfn` public contract.
  - `createDatafnExtfnProxyClient()` returns a `DatafnClient`-compatible proxy surface rather than an untyped placeholder.
  - Any `@datafn/client` extension helpers required by `@datafn/extfn` are first exported publicly before the integration package consumes them.
- Test vectors: `TV-DFX-004`
- Notes: This requirement is branch-sensitive and intentionally anchors the integration contract to the current public DataFn API.

## REUSE-001

- ID: `REUSE-001`
- Priority: `P0`
- Statement: `extfn` MUST reuse or extract existing repository utilities where equivalent behavior already exists, rather than duplicating TS config loading, extension transport, subscription management, or durable storage logic.
- Rationale: The repository already contains working implementations for several of the required capabilities; duplicating them would create avoidable drift and maintenance cost.
- Acceptance criteria:
  - `extfn/cli` reuses `clifn` for generic CLI-building concerns such as action runner semantics, output formatting, env-backed defaults, diagnostics formatting, subprocess execution, and scaffolding once those capabilities exist there.
  - `loadExtensionConfig()` and CLI config loading reuse or are extracted from the existing Jiti-backed TypeScript config loader pattern in `packages/cli`.
  - `@datafn/extfn` composes the existing `@datafn/client` extension transport, subscription manager, and IndexedDB storage adapter unless a thin compatibility wrapper is strictly required.
  - Cross-package reuse happens through public exports or extracted shared helpers, not through long-term private deep-import coupling.
  - `extfn` packages do not directly depend on `hostfn/cli` deployment-specific modules.
  - If a generic logger or validation helper is needed from `hostfn/cli`, it is first extracted to a shared package instead of imported from `hostfn/cli`.
- Test vectors: `TV-REUSE-001`
- Notes: Reuse MAY happen through direct imports from a shared package or through an extraction step that promotes the capability into a repository-owned shared module. `extfn/cli` still owns extension-specific workflows such as browser orchestration, packaging, and scan rules.

## REUSE-002

- ID: `REUSE-002`
- Priority: `P0`
- Statement: `extfn` MUST prefer existing shared Superfunctions packages for config parsing, typed errors, envelope-compatible error metadata, metrics emission, and file/search/storage contracts whenever those semantics already exist.
- Rationale: The `next` branch already contains shared packages for these concerns, so creating extfn-local copies would increase drift and make future package-owned plugins harder to build consistently.
- Acceptance criteria:
  - Env-backed CLI configuration uses `@superfunctions/config` when env parsing is needed.
  - Typed error registration reuses `@superfunctions/errors` or an extracted shared derivative rather than an unrelated extfn-local registry.
  - Runtime response errors carry `status` and `retryable` metadata compatible with `@superfunctions/envelope` semantics.
  - Observability hooks accept an `@superfunctions/metrics`-compatible emitter.
  - Future package-owned integrations reference existing public contracts such as `@searchfn/adapter-contracts`, `@filefn/client`, `@filefn/viewer`, `@superfunctions/files`, and `@superfunctions/storage` instead of extfn-local copies.
- Test vectors: `TV-REUSE-002`
- Notes: This requirement does not force `extfn` to serialize the exact HTTP envelope shape on the wire; it does require semantic compatibility with shared repository primitives. Generic CLI reuse through `clifn` is covered by `REUSE-001`, while package contracts and semantic primitives are covered here.

## SCN-001

- ID: `SCN-001`
- Priority: `P0`
- Statement: `extfn scan` MUST analyze built extension outputs and emit a structured report for security, permission, performance, packaging, and store-readiness concerns relevant to browser extension review.
- Rationale: The framework should help catch the issues that commonly block store review or weaken extension safety before packaging or submission.
- Acceptance criteria:
  - `extfn scan` emits a report containing findings with `ruleId`, `severity`, `category`, `actionability`, `target`, and `message`.
  - The scanner detects or reports remote-hosted code or remote-execution patterns.
  - The scanner detects insecure transport references, unsafe dynamic execution patterns, and risky permission scope.
  - The scanner reports permission-warning breadth and recommendations for optional permissions or `activeTab` where applicable.
  - The scanner emits manual-review reminders for privacy disclosure, single-purpose alignment, and store-listing completeness.
- Test vectors: `TV-SCN-001`
- Notes: Some findings are advisory or manual-review only; the report must distinguish those from enforceable issues.

## SCN-002

- ID: `SCN-002`
- Priority: `P0`
- Statement: `extfn scan` MUST run in strict mode by default and MUST provide an explicit opt-out strictness control.
- Rationale: Security and review-blocking findings should fail fast by default while still allowing deliberate local opt-out when the developer needs a report without gating.
- Acceptance criteria:
  - `extfn scan` exits non-zero when error-severity findings exist in default mode.
  - `extfn scan --no-strict` returns success while preserving the same findings in the report.
  - `extfn package` inherits strict scan behavior by default.
  - `extfn package --no-strict` preserves report generation without blocking archive emission on scan findings.
- Test vectors: `TV-SCN-002`
- Notes: `--no-strict` does not suppress findings; it changes only exit behavior and packaging gates.

## SEC-001

- ID: `SEC-001`
- Priority: `P0`
- Statement: `extfn` MUST validate permissions, host permissions, handler reachability, and payload size before shipping or dispatching runtime traffic.
- Rationale: Extension frameworks must fail safely when security-sensitive configuration is invalid.
- Acceptance criteria:
  - Manifest permissions merge deterministically across config and plugins.
  - Duplicate or invalid permission declarations are rejected.
  - Oversized payloads fail with `E_PAYLOAD_TOO_LARGE`.
  - Requests to unavailable contexts fail with `E_CONTEXT_UNAVAILABLE`.
- Test vectors: `TV-SEC-001`
- Notes: Permission minimalism is a validation goal, but exact consumer permission choice remains application-specific.

## OBS-001

- ID: `OBS-001`
- Priority: `P1`
- Statement: `extfn` MUST emit structured, redacted observability logs for build failures, runtime protocol failures, and dev reload behavior.
- Rationale: Complex extension builds and cross-context behavior require debuggable but safe diagnostics.
- Acceptance criteria:
  - Build errors include target and config path.
  - Runtime failures include error code, namespace, method, and source context.
  - Sensitive payload fields are redacted by default.
  - Dev reload logs distinguish HMR, reinjection, and full reload.
- Test vectors: `TV-OBS-001`
- Notes: User opt-in verbose payload logging is undefined by this spec.

## EX-001

- ID: `EX-001`
- Priority: `P0`
- Statement: The repository MUST include example extensions under `extfn/examples/` that validate vanilla messaging, Svelte content/page mounts, multiple anchored content modules, and DataFn integration.
- Rationale: Validation for this spec must happen entirely inside this repository and not in external consumers.
- Acceptance criteria:
  - A vanilla example exists.
  - A Svelte multi-content example exists.
  - A Svelte DataFn example exists.
  - Phase verification commands build, scan, and package these examples locally through the canonical CLI workflow.
- Test vectors: `TV-EX-001`
- Notes: These examples are implementation artifacts, not only documentation.

## DOC-001

- ID: `DOC-001`
- Priority: `P1`
- Statement: The implementation MUST ship consumer-facing guidance for host abstraction, SvelteKit-coupled component migration, and extfn consumption without requiring changes outside this repository during implementation.
- Rationale: The reuse issue with `$app/*`-coupled shared components is a known adoption blocker for `nucleus`.
- Acceptance criteria:
  - Repository docs explain the host abstraction approach for consumers.
  - Docs explain how to migrate shared components away from direct `$app/*` imports.
  - Docs explain the canonical `extfn dev`, `extfn build`, `extfn scan`, and `extfn package` workflow for consumers.
  - Docs show how consumers use raw browser APIs, `extfn` runtime APIs, and `@datafn/extfn`.
- Test vectors: `TV-DOC-001`
- Notes: This spec bundle also includes an informational consumer migration document under the spec folder.

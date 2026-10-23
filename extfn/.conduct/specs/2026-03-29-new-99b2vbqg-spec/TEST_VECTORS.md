# TV-CFG-001

- Vector ID: `TV-CFG-001`
- Description: Minimal valid code-first extension config loads successfully.
- Input:

```ts
export default defineExtension({
  name: "Spec Demo",
  version: "0.1.0",
  targets: ["chromium-mv3"],
  background: { serviceWorker: "./src/background.ts" }
})
```

- Expected output:

```json
{
  "ok": true,
  "config": {
    "name": "Spec Demo",
    "version": "0.1.0",
    "targets": ["chromium-mv3"],
    "background": {
      "serviceWorker": "./src/background.ts"
    }
  }
}
```

- Negative variant(s):
  - Input: no default export.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_CONFIG_INVALID", "message": "Extension config file must default-export defineExtension(...)." }
}
```

# TV-CFG-002

- Vector ID: `TV-CFG-002`
- Description: Target validation rejects unsupported target scope.
- Input:

```ts
export default defineExtension({
  name: "Bad Sidepanel",
  version: "0.1.0",
  targets: ["chromium-mv3", "firefox-mv3"],
  background: { serviceWorker: "./src/background.ts" },
  sidepanel: { entry: "./src/sidepanel.html" }
})
```

- Expected output:

```json
{
  "ok": false,
  "error": {
    "code": "E_TARGET_UNSUPPORTED",
    "message": "sidepanel is not available for every configured target; scope the surface or remove unsupported targets."
  }
}
```

- Negative variant(s):
  - Input: `targets: ["safari-mv3"]`
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_CONFIG_INVALID", "message": "Unsupported target: safari-mv3" }
}
```

# TV-SURF-001

- Vector ID: `TV-SURF-001`
- Description: Popup and options pages generate manifest entries.
- Input:

```ts
export default defineExtension({
  name: "Pages Demo",
  version: "0.1.0",
  targets: ["chromium-mv3"],
  background: { serviceWorker: "./src/background.ts" },
  popup: { entry: "./src/popup.html", title: "Popup" },
  options: { entry: "./src/options.html", title: "Options" }
})
```

- Expected output:

```json
{
  "manifest": {
    "action": { "default_popup": "popup.html" },
    "options_ui": { "page": "options.html", "open_in_tab": true }
  }
}
```

- Negative variant(s):
  - Input: popup entry path missing.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_ENTRY_NOT_FOUND", "message": "Missing page entry: ./src/popup.html" }
}
```

# TV-SURF-002

- Vector ID: `TV-SURF-002`
- Description: Background service worker and modular message handlers load successfully.
- Input:

```ts
export default defineExtension({
  name: "Handlers Demo",
  version: "0.1.0",
  targets: ["chromium-mv3"],
  background: {
    serviceWorker: "./src/background/index.ts",
    messageHandlersDir: "./src/background/messages"
  }
})
```

Handler file:

```ts
export default defineBackgroundHandler({
  namespace: "upload",
  method: "start",
  handle: async () => ({ accepted: true })
})
```

- Expected output:

```json
{
  "handlers": [
    { "namespace": "upload", "method": "start" }
  ]
}
```

- Negative variant(s):
  - Input: two files register `upload/start`.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_MANIFEST_COLLISION", "message": "Duplicate background handler route: upload/start" }
}
```

# TV-SURF-003

- Vector ID: `TV-SURF-003`
- Description: Background service worker and modular port handlers load successfully.
- Input:

```ts
export default defineExtension({
  name: "Ports Demo",
  version: "0.1.0",
  targets: ["chromium-mv3"],
  background: {
    serviceWorker: "./src/background/index.ts",
    portHandlersDir: "./src/background/ports"
  }
})
```

Port handler file:

```ts
export default defineBackgroundPortHandler({
  channel: "flux",
  onMessage: async (_runtime, payload, _envelope, port) => {
    await port.send({ ok: true, echo: payload })
  }
})
```

- Expected output:

```json
{
  "portHandlers": [
    { "channel": "flux" }
  ]
}
```

- Negative variant(s):
  - Input: two files register `flux`.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_MANIFEST_COLLISION", "message": "Duplicate background port channel: flux" }
}
```

# TV-BLD-001

- Vector ID: `TV-BLD-001`
- Description: The build uses `extfnVite()` with standard Vite commands and no WXT dependency.
- Input:

```ts
import { defineConfig } from "vite"
import { extfnVite } from "@superfunctions/extfn-vite"

export default defineConfig({
  plugins: [...extfnVite()]
})
```

- Expected output:

```json
{
  "vitePluginPresent": true,
  "wxtDependencyPresent": false
}
```

- Negative variant(s):
  - Input: package graph contains `wxt`.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_CONFIG_INVALID", "message": "WXT dependency is forbidden by extfn v1." }
}
```

# TV-BLD-002

- Vector ID: `TV-BLD-002`
- Description: Target-specific deterministic production outputs are emitted.
- Input:

```ts
export default defineExtension({
  name: "Dual Target Demo",
  version: "0.1.0",
  targets: ["chromium-mv3", "firefox-mv3"],
  background: { serviceWorker: "./src/background.ts" }
})
```

- Expected output:

```json
{
  "outputs": [
    "dist/chromium-mv3/manifest.json",
    "dist/firefox-mv3/manifest.json"
  ]
}
```

- Negative variant(s):
  - Input: repeated builds with unchanged sources produce different manifest ordering.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_RUNTIME_PROTOCOL", "message": "Manifest output was not deterministic." }
}
```

# TV-BLD-003

- Vector ID: `TV-BLD-003`
- Description: Dev update policy distinguishes HMR, reinjection, and full reload.
- Input:

```json
[
  { "changedFile": "src/popup/App.svelte", "surface": "popup" },
  { "changedFile": "src/content/twitter.ts", "surface": "content" },
  { "changedFile": "src/background/index.ts", "surface": "background" }
]
```

- Expected output:

```json
[
  { "surface": "popup", "strategy": "hmr" },
  { "surface": "content", "strategy": "reinject" },
  { "surface": "background", "strategy": "full-reload" }
]
```

- Negative variant(s):
  - Input: content surface change reports HMR when adapter has not declared HMR safety.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_CONFIG_INVALID", "message": "Unsafe HMR strategy selected for content surface." }
}
```

# TV-CLI-001

- Vector ID: `TV-CLI-001`
- Description: The repository ships the canonical `extfn` CLI with the required command surface.
- Input:

```json
{
  "binary": "extfn",
  "commands": ["dev", "build", "package", "scan"]
}
```

- Expected output:

```json
{
  "binaryPresent": true,
  "commandsPresent": ["dev", "build", "package", "scan"],
  "usesExtfnVite": true,
  "supportsConfigFlag": true,
  "genericCliPrimitivesReusedFromClifn": true
}
```

- Negative variant(s):
  - Input: repository exposes only package-local scripts and no `extfn` binary.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_CONFIG_INVALID", "message": "extfn CLI binary is missing." }
}
```
  - Input: `extfn/cli` introduces its own generic action runner, diagnostics formatter, and config-loader despite equivalent `clifn` primitives being available.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_CONFIG_INVALID", "message": "extfn CLI duplicated generic CLI primitives instead of reusing clifn." }
}
```

# TV-CLI-002

- Vector ID: `TV-CLI-002`
- Description: `extfn dev` selects one target, emits the unpacked dev output, and applies the correct watch strategy.
- Input:

```json
{
  "command": "extfn dev --target chromium-mv3 --no-open",
  "configuredTargets": ["chromium-mv3", "firefox-mv3"]
}
```

- Expected output:

```json
{
  "watching": true,
  "target": "chromium-mv3",
  "devOutput": "dist/chromium-mv3-dev",
  "printedLoadPath": true
}
```

- Negative variant(s):
  - Input: `extfn dev` with both targets configured and no `--target`.
  - Expected error:

```json
{
  "exitCode": 2,
  "error": { "code": "E_CONFIG_INVALID", "message": "extfn dev requires --target when more than one target is configured." }
}
```

# TV-CLI-003

- Vector ID: `TV-CLI-003`
- Description: `extfn package` builds, scans, and emits deterministic store-uploadable archives.
- Input:

```json
{
  "command": "extfn package --out-dir dist/packages",
  "targets": ["chromium-mv3", "firefox-mv3"]
}
```

- Expected output:

```json
{
  "archives": [
    "dist/packages/spec-demo-0.1.0-chromium-mv3.zip",
    "dist/packages/spec-demo-0.1.0-firefox-mv3.xpi"
  ],
  "scanRun": true,
  "strict": true
}
```

- Negative variant(s):
  - Input: blocking scan findings exist and `--no-strict` is not supplied.
  - Expected output:

```json
{
  "exitCode": 1,
  "archivesEmitted": false,
  "scanReportPresent": true
}
```

# TV-CTX-001

- Vector ID: `TV-CTX-001`
- Description: Runtime context metadata is exposed.
- Input:

```json
{
  "executingContext": "content",
  "contentScriptId": "twitter-profile",
  "tabId": 42,
  "frameId": 0
}
```

- Expected output:

```json
{
  "address": {
    "context": "content",
    "contentScriptId": "twitter-profile",
    "tabId": 42,
    "frameId": 0
  }
}
```

- Negative variant(s):
  - Input: runtime cannot determine context.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_CONTEXT_UNAVAILABLE", "message": "Runtime context could not be resolved." }
}
```

# TV-CTX-002

- Vector ID: `TV-CTX-002`
- Description: Browser facade wraps callback-style APIs into Promises and exposes raw access.
- Input:

```json
{
  "path": "tabs.query",
  "args": [{ "active": true, "currentWindow": true }]
}
```

- Expected output:

```json
{
  "rawPresent": true,
  "promiseResultType": "array"
}
```

- Negative variant(s):
  - Input: `path = "sidePanel.open"` on `firefox-mv3`.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_TARGET_UNSUPPORTED", "message": "Browser method path is not supported on firefox-mv3: sidePanel.open" }
}
```

# TV-CTX-003

- Vector ID: `TV-CTX-003`
- Description: Capability registry reports target-specific features.
- Input:

```json
{ "target": "firefox-mv3" }
```

- Expected output:

```json
{
  "capabilities": {
    "target": "firefox-mv3",
    "sidepanel": false,
    "offscreen": false,
    "scripting": true
  }
}
```

- Negative variant(s):
  - Input: capability registry claims `sidepanel = true` on `firefox-mv3`.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_RUNTIME_PROTOCOL", "message": "Capability registry emitted an invalid target capability map." }
}
```

# TV-MSG-001

- Vector ID: `TV-MSG-001`
- Description: Canonical request and response envelopes are exchanged.
- Input:

```json
{
  "v": 1,
  "kind": "request",
  "requestId": "req_01",
  "namespace": "demo",
  "method": "ping",
  "source": { "context": "popup" },
  "target": { "context": "background" },
  "payload": { "value": "hello" }
}
```

- Expected output:

```json
{
  "v": 1,
  "kind": "response",
  "requestId": "req_01",
  "ok": true,
  "result": { "value": "hello" }
}
```

- Negative variant(s):
  - Input: request missing `namespace`.
  - Expected error:

```json
{
  "v": 1,
  "kind": "response",
  "requestId": "req_01",
  "ok": false,
  "error": {
    "code": "E_RUNTIME_PROTOCOL",
    "message": "Request envelope is missing required field: namespace",
    "status": 400,
    "retryable": false
  }
}
```

# TV-MSG-002

- Vector ID: `TV-MSG-002`
- Description: Unknown handler and timeout behavior are explicit.
- Input:

```json
{
  "namespace": "upload",
  "method": "missing",
  "payload": {}
}
```

- Expected output:

```json
{
  "ok": false,
  "error": { "code": "E_HANDLER_NOT_FOUND", "message": "No handler registered for upload/missing" }
}
```

- Negative variant(s):
  - Input: request with `timeoutMs = 10` and a handler that sleeps for `100 ms`.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_TIMEOUT", "message": "Request timed out after 10 ms." }
}
```

# TV-MSG-003

- Vector ID: `TV-MSG-003`
- Description: Background fanout event ordering is preserved.
- Input:

```json
[
  { "namespace": "datafn", "event": "mutation_applied", "payload": { "seq": 1 } },
  { "namespace": "datafn", "event": "mutation_applied", "payload": { "seq": 2 } }
]
```

- Expected output:

```json
[
  { "listener": "popup", "receivedSeq": [1, 2] },
  { "listener": "sidepanel", "receivedSeq": [1, 2] }
]
```

- Negative variant(s):
  - Input: one listener throws.
  - Expected outcome:

```json
{
  "remainingListenersReceiveEvents": true,
  "loggedErrorCode": "E_RUNTIME_PROTOCOL"
}
```

# TV-MSG-004

- Vector ID: `TV-MSG-004`
- Description: A typed long-lived port preserves ordered bidirectional delivery.
- Input:

```json
{
  "channel": "flux",
  "messages": [
    { "seq": 1, "payload": { "method": "start" } },
    { "seq": 2, "payload": { "method": "status" } }
  ]
}
```

- Expected output:

```json
{
  "port": {
    "channel": "flux",
    "state": "open"
  },
  "received": [
    { "seq": 1, "payload": { "method": "start" } },
    { "seq": 2, "payload": { "method": "status" } }
  ],
  "close": {
    "reason": "client-closed"
  }
}
```

- Negative variant(s):
  - Input: open unknown channel `missing-channel`.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_HANDLER_NOT_FOUND", "message": "Unknown port channel: missing-channel" }
}
```

# TV-MSG-005

- Vector ID: `TV-MSG-005`
- Description: Background suspension triggers reconnect and subscription recovery for a resumable port.
- Input:

```json
{
  "channel": "datafn-sync",
  "options": { "reconnect": "background-resume" },
  "lifecycle": ["open", "background-suspend", "background-resume"]
}
```

- Expected output:

```json
{
  "states": ["open", "reconnecting", "open"],
  "subscriptionsRestored": 1,
  "duplicateSubscriptions": 0
}
```

- Negative variant(s):
  - Input: background never resumes before timeout.
  - Expected output:

```json
{
  "states": ["open", "reconnecting", "closed"],
  "close": { "reason": "context-unavailable" }
}
```

# TV-CNT-001

- Vector ID: `TV-CNT-001`
- Description: Multiple content modules can coexist on the same page.
- Input:

```json
{
  "contentScripts": [
    { "id": "twitter-post", "matches": ["https://x.com/*"] },
    { "id": "twitter-profile", "matches": ["https://x.com/*"] }
  ],
  "url": "https://x.com/someone/status/1"
}
```

- Expected output:

```json
{
  "mountedRoots": [
    "extfn-root-twitter-post",
    "extfn-root-twitter-profile"
  ]
}
```

- Negative variant(s):
  - Input: two content modules share the same `id`.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_CONFIG_INVALID", "message": "Duplicate content script id: twitter-post" }
}
```

# TV-CNT-002

- Vector ID: `TV-CNT-002`
- Description: Selector-list and resolver anchors mount correctly and tolerate missing anchors.
- Input:

```json
{
  "anchors": [
    { "kind": "selector-list", "selector": ".tweet", "mountMode": "append" },
    { "kind": "resolver", "exportName": "getToolbarAnchors", "mountMode": "shadow" }
  ]
}
```

- Expected output:

```json
{
  "mountedAnchorCount": 3,
  "errors": []
}
```

- Negative variant(s):
  - Input: resolver throws `new Error("bad dom")`.
  - Expected outcome:

```json
{
  "mountedAnchorCount": 0,
  "loggedErrorCode": "E_ANCHOR_RESOLUTION",
  "otherContentModulesHealthy": true
}
```

# TV-CNT-003

- Vector ID: `TV-CNT-003`
- Description: Reinjection after SPA navigation is idempotent.
- Input:

```json
{
  "contentScriptId": "youtube-toolbar",
  "anchorKey": "player-1",
  "navigationEvents": 2
}
```

- Expected output:

```json
{
  "mountedInstances": 1,
  "reconnectedMessaging": true
}
```

- Negative variant(s):
  - Input: second reinjection creates duplicate mount for `player-1`.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_RUNTIME_PROTOCOL", "message": "Duplicate content mount detected for youtube-toolbar/player-1" }
}
```

# TV-CNT-004

- Vector ID: `TV-CNT-004`
- Description: Content style isolation and root normalization are applied deterministically.
- Input:

```ts
defineContentScript({
  id: "twitter-toolbar",
  entry: "./src/content/twitter.ts",
  matches: ["*://*.x.com/*"],
  anchors: [{ kind: "selector-list", selector: "[data-testid='bookmark']", mountMode: "shadow" }],
  css: ["./src/content/app.css"],
  styleIsolation: "shadow-root",
  normalizeRootStyles: true
})
```

- Expected output:

```json
{
  "styleTarget": "shadow-root",
  "styleTagsAttached": 1,
  "normalizedRootStyles": true
}
```

- Negative variant(s):
  - Input: `styleIsolation: "global"`
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_CONFIG_INVALID", "message": "Unsupported styleIsolation mode: global" }
}
```

# TV-PLG-001

- Vector ID: `TV-PLG-001`
- Description: A plugin contributes manifest entries and background handlers from its owning package.
- Input:

```json
{
  "pluginId": "datafn-extfn",
  "contributes": {
    "permissions": ["storage"],
    "handlers": ["datafn/query"]
  }
}
```

- Expected output:

```json
{
  "manifestPermissions": ["storage"],
  "routes": ["datafn/query"]
}
```

- Negative variant(s):
  - Input: plugin embeds core-owned hard-coded DataFn behavior inside `@superfunctions/extfn`.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_PLUGIN_CONFLICT", "message": "Domain integration ownership violated: datafn behavior must live outside extfn core." }
}
```

# TV-PLG-002

- Vector ID: `TV-PLG-002`
- Description: Plugin ordering and collisions are deterministic.
- Input:

```json
{
  "plugins": [
    { "id": "alpha", "dependsOn": [] },
    { "id": "beta", "dependsOn": ["alpha"] }
  ]
}
```

- Expected output:

```json
{
  "resolvedOrder": ["alpha", "beta"]
}
```

- Negative variant(s):
  - Input: two plugins both set the same single-owner field `background.serviceWorker`.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_PLUGIN_CONFLICT", "message": "Conflicting single-owner contribution: background.serviceWorker" }
}
```

# TV-PLG-003

- Vector ID: `TV-PLG-003`
- Description: Plugins bootstrap and tear down deterministic runtime services without moving domain logic into extfn core.
- Input:

```json
{
  "plugins": [
    { "id": "datafn-extfn", "hooks": ["setupBackground"] },
    { "id": "viewer-plugin", "hooks": ["setupContext"] }
  ],
  "contextSequence": ["background", "popup", "popup-reload"]
}
```

- Expected output:

```json
{
  "backgroundSetupCalls": ["datafn-extfn"],
  "contextSetupCalls": ["viewer-plugin", "viewer-plugin"],
  "teardownCalls": ["viewer-plugin"]
}
```

- Negative variant(s):
  - Input: plugin handlers are registered before its background bootstrap finishes.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_RUNTIME_PROTOCOL", "message": "Plugin handler registration started before background bootstrap completed." }
}
```

# TV-FWK-001

- Vector ID: `TV-FWK-001`
- Description: Core packages remain framework-agnostic.
- Input:

```json
{
  "packages": [
    "@superfunctions/extfn",
    "@superfunctions/extfn-vite"
  ]
}
```

- Expected output:

```json
{
  "svelteDependencyInCore": false,
  "vanillaExampleBuilds": true
}
```

- Negative variant(s):
  - Input: `@superfunctions/extfn` imports `svelte`.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_CONFIG_INVALID", "message": "Core framework package must remain frontend-framework-agnostic." }
}
```

# TV-FWK-002

- Vector ID: `TV-FWK-002`
- Description: Svelte adapter and vanilla path both exist.
- Input:

```json
{
  "packages": [
    "@superfunctions/extfn-svelte",
    "extfn/examples/vanilla-messaging-demo",
    "extfn/examples/svelte-multi-content-demo"
  ]
}
```

- Expected output:

```json
{
  "svelteAdapterPresent": true,
  "vanillaExamplePresent": true,
  "svelteExamplePresent": true
}
```

- Negative variant(s):
  - Input: no vanilla example package.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_ENTRY_NOT_FOUND", "message": "Required example extension missing: extfn/examples/vanilla-messaging-demo" }
}
```

# TV-DFX-001

- Vector ID: `TV-DFX-001`
- Description: `datafn/extfn` package exports plugin and proxy client.
- Input:

```json
{
  "package": "@datafn/extfn"
}
```

- Expected output:

```json
{
  "exports": [
    "datafnExtfn",
    "createDatafnExtfnProxyClient"
  ]
}
```

- Negative variant(s):
  - Input: package created under `extfn/datafn`.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_CONFIG_INVALID", "message": "DataFn extfn integration must live under datafn/." }
}
```

# TV-DFX-002

- Vector ID: `TV-DFX-002`
- Description: Background authority owns durable storage and sync lifecycle.
- Input:

```json
{
  "authorityContext": "background",
  "proxyContext": "content"
}
```

- Expected output:

```json
{
  "backgroundAuthorityStarted": true,
  "contentAuthorityStarted": false
}
```

- Negative variant(s):
  - Input: content context attempts `authorityMode = true`.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_CONTEXT_UNAVAILABLE", "message": "DataFn authority mode is only available in background context." }
}
```

# TV-DFX-003

- Vector ID: `TV-DFX-003`
- Description: Proxy clients issue DataFn operations and receive subscriptions through extfn envelopes.
- Input:

```json
{
  "request": {
    "namespace": "datafn",
    "method": "query",
    "payload": { "resource": "clips", "filters": { "site": "youtube" } }
  }
}
```

- Expected output:

```json
{
  "ok": true,
  "result": {
    "data": [
      { "id": "clip:1", "site": "youtube" }
    ]
  },
  "subscriptionRecovery": "reconnected"
}
```

- Negative variant(s):
  - Input: background subscription cleanup never runs after proxy unsubscribe.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_RUNTIME_PROTOCOL", "message": "Leaked DataFn remote subscription detected." }
}
```
  - Input: background restarts and proxy client silently duplicates one live subscription into two.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_RUNTIME_PROTOCOL", "message": "Duplicate DataFn subscription registration detected after reconnect." }
}
```

# TV-DFX-004

- Vector ID: `TV-DFX-004`
- Description: `@datafn/extfn` aligns its public options and proxy surface with the current public `@datafn/client` API.
- Input:

```json
{
  "options": {
    "schema": "schemaRef",
    "clientId": "client-123",
    "namespace": "tenant:user-1",
    "sync": { "mode": "sync" },
    "requestTimeoutMs": 15000
  }
}
```

- Expected output:

```json
{
  "acceptedKeys": ["schema", "clientId", "namespace", "sync", "storage", "plugins", "searchProvider", "requestTimeoutMs"],
  "proxyClientType": "DatafnClient"
}
```

- Negative variant(s):
  - Input: `DatafnExtfnOptions` includes `authContext`.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_CONFIG_INVALID", "message": "@datafn/extfn option authContext is not part of the current public @datafn/client API." }
}
```

# TV-REUSE-001

- Vector ID: `TV-REUSE-001`
- Description: The implementation reuses or extracts existing repository-local helpers instead of duplicating equivalent logic.
- Input:

```json
{
  "expectedReuse": {
    "genericCliToolkit": "clifn",
    "cliConfigLoader": "packages/cli",
    "datafnExtensionTransport": "@datafn/client",
    "datafnSubscriptionManager": "@datafn/client",
    "datafnIndexedDbStorage": "@datafn/client"
  }
}
```

- Expected output:

```json
{
  "extfnCliUsesClifnGenericPrimitives": true,
  "cliConfigLoaderReusedOrExtracted": true,
  "datafnExtfnUsesExistingTransportPrimitives": true,
  "hostfnCliDirectDependency": false
}
```

- Negative variant(s):
  - Input: `extfn/cli` implements a second unrelated Jiti-based TypeScript config loader while `packages/cli` still has its own loader.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_CONFIG_INVALID", "message": "Duplicate repository-local TypeScript config loaders detected." }
}
```
  - Input: `extfn/cli` ships local runner, output, exec, or scaffold helpers that duplicate `clifn` primitives without extraction or reuse.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_CONFIG_INVALID", "message": "extfn CLI duplicated generic CLI primitives instead of reusing clifn." }
}
```
  - Input: `@datafn/extfn` introduces a new extension transport and subscription manager that duplicate existing `@datafn/client` behavior without extraction or reuse.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_PLUGIN_CONFLICT", "message": "DataFn extfn duplicated existing extension primitives instead of reusing or extracting them." }
}
```

# TV-REUSE-002

- Vector ID: `TV-REUSE-002`
- Description: Shared Superfunctions primitives are reused for config, errors, metrics, and future package-owned contracts instead of being redefined locally in extfn.
- Input:

```json
{
  "expectedSharedPackages": [
    "@superfunctions/config",
    "@superfunctions/errors",
    "@superfunctions/envelope",
    "@superfunctions/metrics",
    "@searchfn/adapter-contracts",
    "@filefn/client",
    "@filefn/viewer",
    "@superfunctions/files",
    "@superfunctions/storage"
  ]
}
```

- Expected output:

```json
{
  "envParsingReused": true,
  "errorRegistryReusedOrExtracted": true,
  "envelopeSemanticsCompatible": true,
  "metricsEmitterCompatible": true,
  "futurePluginContractsDocumented": true
}
```

- Negative variant(s):
  - Input: extfn introduces a standalone error registry and omits `status`/`retryable` from runtime error envelopes.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_CONFIG_INVALID", "message": "extfn error model diverged from shared repository error and envelope semantics." }
}
```

# TV-SCN-001

- Vector ID: `TV-SCN-001`
- Description: `extfn scan` emits a structured review report with enforceable and manual-review findings.
- Input:

```json
{
  "manifest": {
    "manifest_version": 3,
    "host_permissions": ["<all_urls>"]
  },
  "bundleSnippets": [
    "fetch('http://api.example.test/upload')",
    "eval(userSuppliedCode)",
    "import('https://cdn.example.test/remote.js')"
  ]
}
```

- Expected output:

```json
{
  "findings": [
    {
      "ruleId": "SCAN-RHC-001",
      "severity": "error",
      "category": "security",
      "actionability": "enforceable"
    },
    {
      "ruleId": "SCAN-HTTP-001",
      "severity": "error",
      "category": "security",
      "actionability": "enforceable"
    },
    {
      "ruleId": "SCAN-PERM-001",
      "severity": "warning",
      "category": "permissions",
      "actionability": "enforceable"
    },
    {
      "ruleId": "SCAN-PRIVACY-001",
      "severity": "warning",
      "category": "privacy",
      "actionability": "manual-review"
    }
  ]
}
```

- Negative variant(s):
  - Input: report omits `ruleId` or `actionability` for a finding.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_RUNTIME_PROTOCOL", "message": "Scan finding is missing required reporting fields." }
}
```

# TV-SCN-002

- Vector ID: `TV-SCN-002`
- Description: Scan is strict by default and can be explicitly made non-blocking.
- Input:

```json
[
  { "command": "extfn scan", "findings": [{ "severity": "error" }] },
  { "command": "extfn scan --no-strict", "findings": [{ "severity": "error" }] }
]
```

- Expected output:

```json
[
  { "command": "extfn scan", "exitCode": 1, "reportPresent": true, "strict": true },
  { "command": "extfn scan --no-strict", "exitCode": 0, "reportPresent": true, "strict": false }
]
```

- Negative variant(s):
  - Input: `--no-strict` suppresses error findings from the emitted report.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_RUNTIME_PROTOCOL", "message": "Non-strict mode changed findings instead of only changing exit behavior." }
}
```

# TV-SEC-001

- Vector ID: `TV-SEC-001`
- Description: Permission and payload validation happen before runtime dispatch.
- Input:

```json
{
  "permissions": ["storage"],
  "payloadBytes": 1024
}
```

- Expected output:

```json
{
  "permissionsAccepted": true,
  "payloadAccepted": true
}
```

- Negative variant(s):
  - Input: payload size `9437185` bytes.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_PAYLOAD_TOO_LARGE", "message": "Payload exceeds 8 MiB limit." }
}
```

# TV-OBS-001

- Vector ID: `TV-OBS-001`
- Description: Structured logs are emitted with redaction.
- Input:

```json
{
  "error": {
    "code": "E_TIMEOUT",
    "namespace": "auth",
    "method": "refresh",
    "payload": { "token": "secret-token", "userId": "u1" }
  }
}
```

- Expected output:

```json
{
  "log": {
    "code": "E_TIMEOUT",
    "namespace": "auth",
    "method": "refresh",
    "payload": { "token": "[REDACTED]", "userId": "u1" }
  }
}
```

- Negative variant(s):
  - Input: raw token printed unredacted in default logs.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_RUNTIME_PROTOCOL", "message": "Sensitive payload data was logged without redaction." }
}
```

# TV-EX-001

- Vector ID: `TV-EX-001`
- Description: Required example extensions exist and are buildable.
- Input:

```json
{
  "examples": [
    "extfn/examples/vanilla-messaging-demo",
    "extfn/examples/svelte-multi-content-demo",
    "extfn/examples/svelte-datafn-demo"
  ]
}
```

- Expected output:

```json
{
  "allExamplesBuild": true,
  "allExamplesHaveExtfnConfig": true,
  "allExamplesPassCliBuildAndScan": true
}
```

- Negative variant(s):
  - Input: one example exists only as docs and not as a buildable package.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_ENTRY_NOT_FOUND", "message": "Example extension is not buildable." }
}
```

# TV-DOC-001

- Vector ID: `TV-DOC-001`
- Description: Consumer guidance covers host abstraction and migration from SvelteKit-coupled shared components.
- Input:

```json
{
  "docs": [
    "consumer host abstraction",
    "migration away from $app imports",
    "using extfn runtime and @datafn/extfn",
    "using extfn dev/build/scan/package"
  ]
}
```

- Expected output:

```json
{
  "coveredTopics": [
    "host abstraction",
    "SvelteKit migration",
    "consumer usage",
    "datafn integration",
    "CLI workflow"
  ]
}
```

- Negative variant(s):
  - Input: guide omits the `$app/*` migration problem.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "E_CONFIG_INVALID", "message": "Consumer migration guide does not address SvelteKit-coupled shared components." }
}
```

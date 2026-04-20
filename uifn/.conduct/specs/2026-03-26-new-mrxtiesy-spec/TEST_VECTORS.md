# TV-WS-001

- Description: Root workspace discovery includes the example hub and nested example workspaces while keeping them private.
- Input:

```json
{
  "rootWorkspaces": ["uifn/*", "uifn/examples/*"],
  "expectedPackages": [
    "@uifn/examples",
    "@uifn/examples-shared",
    "@uifn/example-react-playground",
    "@uifn/example-svelte-playground",
    "@uifn/example-vue-playground"
  ]
}
```

- Expected output:

```json
{
  "discoveredPackages": [
    "@uifn/examples",
    "@uifn/examples-shared",
    "@uifn/example-react-playground",
    "@uifn/example-svelte-playground",
    "@uifn/example-vue-playground"
  ],
  "allPrivate": true,
  "releaseGateUnchanged": true
}
```

- Negative variant(s):

```json
{
  "error": {
    "code": "EXAMPLE_WORKSPACE_MISSING",
    "message": "root workspaces do not include uifn/examples/*"
  }
}
```

# TV-HUB-001

- Description: The example hub exposes the canonical runner scripts and README command contract.
- Input:

```json
{
  "package": "@uifn/examples",
  "scripts": ["dev:react", "dev:svelte", "dev:vue", "build", "verify"],
  "rootScript": "verify:uifn-examples"
}
```

- Expected output:

```json
{
  "ok": true,
  "missingScripts": [],
  "readmeCommandsPresent": true
}
```

- Negative variant(s):

```json
{
  "ok": false,
  "failures": [
    {
      "code": "EXAMPLE_SCRIPT_MISSING",
      "workspace": "@uifn/examples",
      "detail": "missing required script verify"
    }
  ]
}
```

# TV-SHARED-001

- Description: The shared package exports the canonical scenario registry and deterministic fixture metadata.
- Input:

```json
{
  "scenarios": [
    "settings-console",
    "team-directory",
    "command-center",
    "virtualized-results"
  ],
  "ports": {
    "react": 6111,
    "svelte": 6112,
    "vue": 6113
  }
}
```

- Expected output:

```json
{
  "orderedScenarioIds": [
    "settings-console",
    "team-directory",
    "command-center",
    "virtualized-results"
  ],
  "fixtureKeys": ["settings", "team", "commands", "results"],
  "containsRandomizedIds": false,
  "containsTimestamps": false
}
```

- Negative variant(s):

```json
{
  "ok": false,
  "failures": [
    {
      "code": "EXAMPLE_CONFIG_ERROR",
      "workspace": "@uifn/examples-shared",
      "detail": "duplicate scenario id command-center"
    }
  ]
}
```

# TV-ROUTE-001

- Description: Every playground normalizes route hashes consistently and handles unsupported routes without crashing.
- Input:

```json
{
  "routes": ["", "#/unknown-scenario", "#/settings-console", "#/virtualized-results"]
}
```

- Expected output:

```json
{
  "defaultedRoute": "#/settings-console",
  "unknownRouteNormalizedTo": "#/settings-console",
  "reactVirtualizedRoute": "scenario-rendered",
  "svelteVirtualizedRoute": "scenario-rendered",
  "vueVirtualizedRoute": "unsupported-view-rendered"
}
```

- Negative variant(s):

```json
{
  "ok": false,
  "failures": [
    {
      "code": "EXAMPLE_CAPABILITY_MISMATCH",
      "workspace": "@uifn/example-vue-playground",
      "detail": "valid unsupported route attempted to crash instead of rendering unsupported view"
    }
  ]
}
```

# TV-REACT-001

- Description: The React playground renders all four scenarios using the shared data set and React adapter primitives.
- Input:

```json
{
  "workspace": "@uifn/example-react-playground",
  "routes": [
    "#/settings-console",
    "#/team-directory",
    "#/command-center",
    "#/virtualized-results"
  ]
}
```

- Expected output:

```json
{
  "built": true,
  "adapterBadge": "React",
  "renderedScenarioCount": 4,
  "virtualizedResultsUsesVirtualizedList": true
}
```

- Negative variant(s):

```json
{
  "ok": false,
  "failures": [
    {
      "code": "EXAMPLE_BUILD_ERROR",
      "workspace": "@uifn/example-react-playground",
      "detail": "build succeeded but virtualized-results mounted a plain mapped list instead of VirtualizedList"
    }
  ]
}
```

# TV-SVELTE-001

- Description: The Svelte playground renders all four scenarios using the shared data set and Svelte adapter primitives.
- Input:

```json
{
  "workspace": "@uifn/example-svelte-playground",
  "routes": [
    "#/settings-console",
    "#/team-directory",
    "#/command-center",
    "#/virtualized-results"
  ]
}
```

- Expected output:

```json
{
  "built": true,
  "adapterBadge": "Svelte",
  "renderedScenarioCount": 4,
  "virtualizedResultsUsesVirtualizedList": true
}
```

- Negative variant(s):

```json
{
  "ok": false,
  "failures": [
    {
      "code": "EXAMPLE_BUILD_ERROR",
      "workspace": "@uifn/example-svelte-playground",
      "detail": "shared scenario registry was not imported; local scenario copy diverged"
    }
  ]
}
```

# TV-VUE-001

- Description: The Vue playground renders supported scenarios, stays experimental, and shows a truthful unsupported state for `virtualized-results`.
- Input:

```json
{
  "workspace": "@uifn/example-vue-playground",
  "routes": [
    "#/settings-console",
    "#/team-directory",
    "#/command-center",
    "#/virtualized-results"
  ]
}
```

- Expected output:

```json
{
  "built": true,
  "adapterBadge": "Vue Experimental",
  "renderedScenarioCount": 3,
  "virtualizedResultsState": {
    "mode": "unsupported",
    "note": "VirtualizedList is not exported by @uifn/vue"
  }
}
```

- Negative variant(s):

```json
{
  "ok": false,
  "failures": [
    {
      "code": "EXAMPLE_CAPABILITY_MISMATCH",
      "workspace": "@uifn/example-vue-playground",
      "detail": "Vue playground claimed support for virtualized-list"
    }
  ]
}
```

# TV-CAP-001

- Description: The capability matrix truthfully reports support by adapter and is sourced from shared metadata.
- Input:

```json
{
  "capability": "virtualized-list",
  "adapters": ["react", "svelte", "vue"]
}
```

- Expected output:

```json
{
  "support": [
    { "adapter": "react", "status": "supported" },
    { "adapter": "svelte", "status": "supported" },
    {
      "adapter": "vue",
      "status": "unsupported",
      "note": "VirtualizedList is not exported by @uifn/vue"
    }
  ]
}
```

- Negative variant(s):

```json
{
  "ok": false,
  "failures": [
    {
      "code": "EXAMPLE_CAPABILITY_MISMATCH",
      "workspace": "@uifn/examples-shared",
      "detail": "capability matrix disagreed with playground behavior"
    }
  ]
}
```

# TV-VERIFY-001

- Description: The example verification command succeeds with the canonical JSON envelope.
- Input:

```json
{
  "command": "npm run verify:uifn-examples"
}
```

- Expected output:

```json
{
  "ok": true,
  "command": "verify:uifn-examples",
  "checks": ["workspace", "manifest", "build", "docs", "offline"],
  "workspaces": [
    { "name": "@uifn/examples", "adapter": "hub", "ok": true, "notes": [] },
    { "name": "@uifn/examples-shared", "adapter": "shared", "ok": true, "notes": [] },
    { "name": "@uifn/example-react-playground", "adapter": "react", "ok": true, "notes": [] },
    { "name": "@uifn/example-svelte-playground", "adapter": "svelte", "ok": true, "notes": [] },
    { "name": "@uifn/example-vue-playground", "adapter": "vue", "ok": true, "notes": ["experimental"] }
  ],
  "failures": []
}
```

- Negative variant(s):

```json
{
  "ok": false,
  "command": "verify:uifn-examples",
  "checks": ["workspace", "manifest", "build", "docs", "offline"],
  "workspaces": [
    { "name": "@uifn/example-react-playground", "adapter": "react", "ok": false, "notes": [] }
  ],
  "failures": [
    {
      "code": "EXAMPLE_BUILD_ERROR",
      "workspace": "@uifn/example-react-playground",
      "detail": "vite build failed"
    }
  ]
}
```

# TV-VERIFY-002

- Description: The verification command emits canonical failure codes for missing scripts or bad manifests.
- Input:

```json
{
  "mutations": [
    "remove build script from @uifn/example-svelte-playground",
    "change vue virtualized-list status to supported"
  ]
}
```

- Expected output:

```json
{
  "ok": false,
  "failures": [
    {
      "code": "EXAMPLE_SCRIPT_MISSING",
      "workspace": "@uifn/example-svelte-playground",
      "detail": "missing required script build"
    },
    {
      "code": "EXAMPLE_CAPABILITY_MISMATCH",
      "workspace": "@uifn/example-vue-playground",
      "detail": "virtualized-list is marked supported but unsupported view is required"
    }
  ]
}
```

- Negative variant(s):

```json
{
  "error": {
    "code": "EXAMPLE_CONFIG_ERROR",
    "message": "verification script emitted non-canonical output keys"
  }
}
```

# TV-DOC-001

- Description: The documentation points developers from `uifn` package docs to the examples hub and preserves truthful adapter status labels.
- Input:

```json
{
  "docs": [
    "uifn/README.md",
    "uifn/react/README.md",
    "uifn/svelte/README.md",
    "uifn/vue/README.md",
    "uifn/examples/README.md"
  ]
}
```

- Expected output:

```json
{
  "rootReadmeLinksExampleHub": true,
  "reactReadmeLinksReactPlayground": true,
  "svelteReadmeLinksSveltePlayground": true,
  "vueReadmeLinksVuePlayground": true,
  "vueReadmeRetainsExperimentalLabel": true
}
```

- Negative variant(s):

```json
{
  "ok": false,
  "failures": [
    {
      "code": "EXAMPLE_DOC_LINK_MISSING",
      "workspace": "@uifn/example-vue-playground",
      "detail": "Vue README linked the playground but omitted the experimental label"
    }
  ]
}
```

# TV-DET-001

- Description: The example bundle remains offline-safe and deterministic.
- Input:

```json
{
  "scanPatterns": [
    "fetch(",
    "XMLHttpRequest",
    "WebSocket(",
    "navigator.sendBeacon"
  ],
  "sourceRoot": "uifn/examples"
}
```

- Expected output:

```json
{
  "matches": [],
  "requiresEnvFile": false,
  "fixedPorts": {
    "react": 6111,
    "svelte": 6112,
    "vue": 6113
  }
}
```

- Negative variant(s):

```json
{
  "ok": false,
  "failures": [
    {
      "code": "EXAMPLE_NETWORK_FORBIDDEN",
      "workspace": "@uifn/example-react-playground",
      "detail": "found forbidden network primitive fetch( in src/App.tsx"
    }
  ]
}
```

# TV-A11Y-001

- Description: Scenario navigation and key interactive elements remain keyboard reachable and labeled in every playground.
- Input:

```json
{
  "checks": [
    "tab to scenario navigation",
    "activate settings dialog trigger",
    "move through tabs",
    "toggle switch or checkbox",
    "open command-center controls",
    "navigate virtualized-results in React and Svelte"
  ]
}
```

- Expected output:

```json
{
  "react": "pass",
  "svelte": "pass",
  "vue": "pass",
  "vueUnsupportedViewNamed": true
}
```

- Negative variant(s):

```json
{
  "ok": false,
  "failures": [
    {
      "code": "EXAMPLE_BUILD_ERROR",
      "workspace": "@uifn/example-svelte-playground",
      "detail": "scenario navigation rendered unlabeled buttons"
    }
  ]
}
```


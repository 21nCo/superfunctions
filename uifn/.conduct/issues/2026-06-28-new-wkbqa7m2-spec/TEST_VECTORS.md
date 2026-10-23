# Test Vectors

## TV-WB-001

- Description: All five Workbench packages exist and are private.
- Input:
```json
{
  "workspaces": [
    "@uifn/example-react-workbench",
    "@uifn/example-svelte-workbench",
    "@uifn/example-vue-workbench",
    "@uifn/example-solid-workbench",
    "@uifn/example-angular-workbench"
  ]
}
```
- Expected output:
```json
{ "ok": true, "frameworkCount": 5, "private": true }
```
- Negative variant TV-WB-001-N:
```json
{
  "error": {
    "code": "UIFN_WORKBENCH_FRAMEWORK_MISSING",
    "message": "missing workbench package for angular"
  }
}
```

## TV-COMP-001

- Description: Component route inventory matches registry inventory.
- Input:
```json
{
  "registryComponents": ["accordion", "alert-dialog", "aspect-ratio", "avatar", "badge", "breadcrumb", "button", "calendar", "card", "checkbox", "collapsible", "command", "context-menu", "data-table", "date-picker", "dialog", "dropdown-menu", "form", "hover-card", "input", "input-otp", "label", "menubar", "pagination", "popover", "progress", "radio-group", "resizable", "scroll-area", "select", "separator", "sheet", "sidebar", "skeleton", "slider", "sonner", "switch", "table", "tabs", "textarea", "toast", "toggle", "toggle-group", "tooltip", "typography"],
  "framework": "react"
}
```
- Expected output:
```json
{ "ok": true, "componentCount": 45, "missing": [] }
```
- Negative variant TV-COMP-001-N:
```json
{
  "error": {
    "code": "UIFN_WORKBENCH_COMPONENT_ROUTE_MISSING",
    "message": "missing route /components/tooltip for react"
  }
}
```

## TV-FW-001

- Description: Framework route parity is enforced.
- Input:
```json
{
  "route": "/components/dropdown-menu/qa/edge-bottom-right",
  "frameworks": ["react", "svelte", "vue", "solid", "angular"]
}
```
- Expected output:
```json
{ "ok": true, "routeExistsInAllFrameworks": true }
```
- Negative variant TV-FW-001-N:
```json
{
  "error": {
    "code": "UIFN_WORKBENCH_ROUTE_DRIFT",
    "message": "route exists in react but not solid"
  }
}
```

## TV-WB-002

- Description: Product scenarios link to deterministic QA routes.
- Input:
```json
{
  "scenario": "/scenarios/settings-console",
  "component": "switch"
}
```
- Expected output:
```json
{
  "ok": true,
  "usesComponent": true,
  "linkedQaRoute": "/components/switch/qa"
}
```
- Negative variant TV-WB-002-N:
```json
{
  "error": {
    "code": "UIFN_WORKBENCH_SCENARIO_QA_LINK_MISSING",
    "message": "settings-console uses switch without a QA route link"
  }
}
```

## TV-QA-001

- Description: QA contract validates required fields.
- Input:
```json
{
  "schemaVersion": 1,
  "family": "component",
  "slug": "button",
  "frameworks": ["react", "svelte", "vue", "solid", "angular"],
  "qaProfile": "control",
  "requiredRoutes": ["/components/button", "/components/button/qa"],
  "requiredStates": ["default", "disabled", "loading"],
  "requiredInteractions": ["click", "keyboard-enter", "keyboard-space"]
}
```
- Expected output:
```json
{ "ok": true, "slug": "button" }
```
- Negative variant TV-QA-001-N:
```json
{
  "error": {
    "code": "UIFN_QA_CONTRACT_INVALID",
    "message": "unknown component slug buttonish"
  }
}
```

## TV-BROWSER-001

- Description: Browser QA navigates to a real Workbench URL.
- Input:
```json
{
  "framework": "svelte",
  "url": "http://127.0.0.1:6122/components/checkbox/qa"
}
```
- Expected output:
```json
{
  "ok": true,
  "routeLoaded": true,
  "componentRoot": "[data-uifn-component=\"checkbox\"]"
}
```
- Negative variant TV-BROWSER-001-N:
```json
{
  "error": {
    "code": "UIFN_BROWSER_ROUTE_BLANK",
    "message": "route rendered no component root"
  }
}
```

## TV-OVERLAY-001

- Description: Dropdown menu edge placement remains visible and aligned.
- Input:
```json
{
  "framework": "react",
  "slug": "dropdown-menu",
  "route": "/components/dropdown-menu/qa/edge-bottom-right",
  "action": "click trigger"
}
```
- Expected output:
```json
{
  "ok": true,
  "contentVisible": true,
  "insideViewport": true,
  "triggerAssociation": "aria-controls",
  "alignmentTolerancePx": 8
}
```
- Negative variant TV-OVERLAY-001-N:
```json
{
  "error": {
    "code": "UIFN_OVERLAY_OUT_OF_VIEWPORT",
    "message": "dropdown-menu content extends beyond viewport on bottom-right edge case"
  }
}
```

## TV-FORM-001

- Description: Form controls update value and submitted data.
- Input:
```json
{
  "framework": "vue",
  "slug": "input-otp",
  "route": "/components/input-otp/qa/form-submit",
  "typed": "123456"
}
```
- Expected output:
```json
{
  "ok": true,
  "domValue": "123456",
  "submittedValue": "123456",
  "ariaInvalid": false
}
```
- Negative variant TV-FORM-001-N:
```json
{
  "error": {
    "code": "UIFN_FORM_DISABLED_MUTATED",
    "message": "disabled input-otp accepted typing"
  }
}
```

## TV-DATA-001

- Description: Data-rich large-list behavior works in browser.
- Input:
```json
{
  "framework": "solid",
  "slug": "data-table",
  "route": "/components/data-table/qa/large-data",
  "actions": ["sort score desc", "filter Row 42", "select row-42"]
}
```
- Expected output:
```json
{
  "ok": true,
  "filteredRows": 1,
  "selectedRow": "row-42",
  "virtualizedBlankSpace": false
}
```
- Negative variant TV-DATA-001-N:
```json
{
  "error": {
    "code": "UIFN_DATA_RICH_STATE_MISMATCH",
    "message": "selected row was lost after filtering"
  }
}
```

## TV-STATIC-001

- Description: Static component renders stable semantics and theme tokens.
- Input:
```json
{
  "framework": "angular",
  "slug": "typography",
  "route": "/components/typography/qa/themes",
  "theme": "high-contrast-dark"
}
```
- Expected output:
```json
{
  "ok": true,
  "nonblank": true,
  "textReadable": true,
  "tokenVarsApplied": true
}
```
- Negative variant TV-STATIC-001-N:
```json
{
  "error": {
    "code": "UIFN_STATIC_VISUAL_BLANK",
    "message": "typography route produced blank screenshot"
  }
}
```

## TV-A11Y-001

- Description: Axe and keyboard checks pass for dialog.
- Input:
```json
{
  "framework": "react",
  "slug": "dialog",
  "route": "/components/dialog/qa/focus-trap"
}
```
- Expected output:
```json
{
  "ok": true,
  "axeViolations": [],
  "focusTrapped": true,
  "focusReturnedToTrigger": true
}
```
- Negative variant TV-A11Y-001-N:
```json
{
  "error": {
    "code": "UIFN_A11Y_FOCUS_ESCAPE",
    "message": "focus escaped dialog while open"
  }
}
```

## TV-VISUAL-001

- Description: Visual matrix captures deterministic states.
- Input:
```json
{
  "framework": "svelte",
  "slug": "calendar",
  "themes": ["light", "dark", "high-contrast-light", "high-contrast-dark"],
  "viewports": ["mobile", "tablet", "desktop"]
}
```
- Expected output:
```json
{
  "ok": true,
  "screenshotCount": 12,
  "blankScreenshots": 0,
  "textOverlap": false
}
```
- Negative variant TV-VISUAL-001-N:
```json
{
  "error": {
    "code": "UIFN_VISUAL_BASELINE_DRIFT",
    "message": "calendar dark desktop screenshot exceeded threshold"
  }
}
```

## TV-PATTERN-001

- Description: Controlled pattern route renders and responds.
- Input:
```json
{
  "framework": "vue",
  "slug": "api-key-table",
  "route": "/patterns/api-key-table/qa/success"
}
```
- Expected output:
```json
{
  "ok": true,
  "rowCount": 3,
  "actionsVisible": true,
  "noBackendImports": true
}
```
- Negative variant:
```json
{
  "error": {
    "code": "UIFN_PATTERN_BACKEND_IMPORT",
    "message": "controlled pattern imported a Superfunction client"
  }
}
```

## TV-SF-001

- Description: SF panel route uses injected fake client and state matrix.
- Input:
```json
{
  "framework": "angular",
  "slug": "authfn-api-key-table",
  "route": "/sf/authfn-api-key-table/qa/degraded-network"
}
```
- Expected output:
```json
{
  "ok": true,
  "clientType": "fake",
  "state": "degraded-network",
  "liveNetworkCalls": 0
}
```
- Negative variant TV-SF-001-N:
```json
{
  "error": {
    "code": "UIFN_SF_GLOBAL_CLIENT_READ",
    "message": "SF panel attempted to read a global client"
  }
}
```

## TV-REPORT-001

- Description: Browser QA emits structured evidence.
- Input:
```json
{
  "command": "verify:uifn-browser",
  "filter": { "framework": "react", "slug": "popover" }
}
```
- Expected output:
```json
{
  "ok": true,
  "schemaVersion": 1,
  "checks": [{ "slug": "popover", "framework": "react", "status": "passed" }],
  "failures": []
}
```
- Negative variant TV-REPORT-001-N:
```json
{
  "error": {
    "code": "UIFN_QA_RESULT_SCHEMA_INVALID",
    "message": "missing failures array"
  }
}
```

## TV-SEC-001

- Description: Examples are offline and secret-free.
- Input:
```json
{
  "scanRoot": "uifn/examples",
  "forbidden": ["fetch(", "XMLHttpRequest", "WebSocket(", "sendBeacon", ".env"]
}
```
- Expected output:
```json
{ "ok": true, "forbiddenMatches": [] }
```
- Negative variant TV-SEC-001-N:
```json
{
  "error": {
    "code": "UIFN_EXAMPLE_NETWORK_FORBIDDEN",
    "message": "found fetch( in Workbench route source"
  }
}
```

## TV-REL-001

- Description: Release gate includes Workbench browser evidence.
- Input:
```json
{
  "releaseChecks": ["examples", "browser", "overlays"]
}
```
- Expected output:
```json
{
  "ok": true,
  "examplesIncluded": true,
  "browserIncluded": true,
  "overlaysIncluded": true
}
```
- Negative variant TV-REL-001-N:
```json
{
  "error": {
    "code": "UIFN_RELEASE_BROWSER_GATE_MISSING",
    "message": "verify:uifn-release does not include required browser QA"
  }
}
```

## TV-DOC-001

- Description: Docs link to Workbench and QA commands.
- Input:
```json
{
  "docs": ["uifn/README.md", "uifn/react/README.md", "uifn/svelte/README.md", "uifn/vue/README.md", "uifn/solid/README.md", "uifn/angular/README.md"]
}
```
- Expected output:
```json
{
  "ok": true,
  "linksPresent": true,
  "qaCommandsPresent": true
}
```
- Negative variant TV-DOC-001-N:
```json
{
  "error": {
    "code": "UIFN_WORKBENCH_DOC_LINK_MISSING",
    "message": "uifn/solid/README.md does not link to the Solid Workbench"
  }
}
```

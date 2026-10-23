# SFN-15 Test Vectors

## TV-ARCH-001

Description: Valid package graph.

Input:

```json
{
  "packages": {
    "@uifn/core": [],
    "@uifn/adapter-kit": ["@uifn/core"],
    "@uifn/react": ["@uifn/core", "@uifn/adapter-kit"],
    "@uifn/tokens": [],
    "@uifn/theme": ["@uifn/tokens"],
    "@uifn/theme-tailwind": ["@uifn/tokens", "@uifn/theme"],
    "@uifn/recipes": ["@uifn/tokens", "@uifn/theme"],
    "@uifn/components": ["@uifn/react", "@uifn/recipes"],
    "@uifn/patterns": ["@uifn/components"],
    "@uifn/sf": ["@uifn/patterns"],
    "@uifn/registry": [],
    "@uifn/storybook": ["@uifn/registry", "@uifn/theme"]
  }
}
```

Expected output:

```json
{ "ok": true, "cycles": [], "upwardLayerImports": [] }
```

Negative variant:

```json
{
  "packages": {
    "@uifn/core": ["@uifn/react"]
  }
}
```

Expected error: `UIFN_RELEASE_PACKAGE_LAYER_VIOLATION`.

## TV-ARCH-002

Description: Package manifest includes required scripts and status.

Input:

```json
{
  "name": "@uifn/react",
  "uifn": { "status": "ga-candidate", "layer": "adapter" },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint ."
  },
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.mjs" } }
}
```

Expected output:

```json
{ "ok": true, "missing": [] }
```

Negative variant expected error: `UIFN_RELEASE_MANIFEST_INCOMPLETE` when `uifn.status` is missing.

## TV-ARCH-003

Description: Clean-room source policy validation.

Input:

```json
{
  "manifest": { "name": "Button", "sourcePolicy": "clean-room" },
  "scan": { "copiedExternalSourceMatches": 0, "externalAssetMatches": 0, "copiedDocsMatches": 0 }
}
```

Expected output:

```json
{ "ok": true }
```

Negative variant expected error: `UIFN_SOURCE_PROVENANCE_VIOLATION` when any match count is greater than `0`.

## TV-CORE-001

Description: Dialog controller returns deterministic part props.

Input:

```json
{
  "controller": "dialog",
  "config": { "defaultOpen": false, "modal": true },
  "env": { "generateId": "fixed" },
  "event": { "part": "trigger", "type": "click" }
}
```

Expected output:

```json
{
  "state": { "open": true, "modal": true },
  "parts": {
    "trigger": {
      "aria": { "haspopup": "dialog", "expanded": true, "controls": "dialog-content-fixed" },
      "data": { "state": "open" }
    },
    "content": {
      "role": "dialog",
      "id": "dialog-content-fixed",
      "aria": { "modal": true },
      "data": { "state": "open" }
    }
  }
}
```

Negative variant expected error: `UIFN_CORE_ENVIRONMENT_INVALID` when `env.generateId` returns duplicate ids in a single controller.

## TV-CORE-002

Description: Disabled checkbox ignores state-changing input.

Input:

```json
{
  "controller": "checkbox",
  "config": { "defaultChecked": false, "disabled": true },
  "event": { "part": "root", "type": "click" }
}
```

Expected output:

```json
{
  "state": { "checked": false, "disabled": true },
  "error": {
    "code": "UIFN_ERR_DISABLED_INTERACTION",
    "recoverable": true
  }
}
```

Negative variant expected error: `UIFN_CORE_DISABLED_MUTATED` if checked changes to `true`.

## TV-CORE-003

Description: Required accessibility props cannot be removed by user props.

Input:

```json
{
  "part": "tabs.trigger",
  "generated": { "role": "tab", "aria": { "selected": true } },
  "userProps": { "role": "button", "aria": { "selected": null } }
}
```

Expected output:

```json
{
  "role": "tab",
  "aria": { "selected": true },
  "warnings": ["UIFN_REQUIRED_A11Y_PROP_OVERRIDDEN"]
}
```

Negative variant expected error: `UIFN_REQUIRED_A11Y_PROP_MISSING` when merge result removes `role`.

## TV-ADAPT-001

Description: Shared conformance run covers every framework.

Input:

```json
{
  "primitive": "select",
  "frameworks": ["react", "svelte", "vue", "solid", "angular"],
  "vectors": ["keyboard-open", "typeahead", "controlled-value", "disabled-item"]
}
```

Expected output:

```json
{
  "ok": true,
  "frameworksPassed": ["react", "svelte", "vue", "solid", "angular"]
}
```

Negative variant expected error: `UIFN_ADAPTER_COVERAGE_MISSING` when `angular` is absent.

## TV-ADAPT-002

Description: React hook and compound APIs expose the same behavior.

Input:

```json
{
  "framework": "react",
  "primitive": "dialog",
  "apis": ["useDialog", "Dialog.Root"],
  "event": "trigger.click"
}
```

Expected output:

```json
{ "openFromHook": true, "openFromComponent": true, "behaviorEquivalent": true }
```

Negative variant expected error: `UIFN_ADAPTER_BEHAVIOR_DRIFT`.

## TV-ADAPT-003

Description: Svelte action and component APIs expose the same behavior.

Input:

```json
{
  "framework": "svelte",
  "primitive": "popover",
  "apis": ["component", "action"],
  "event": "trigger.click"
}
```

Expected output:

```json
{ "openFromAction": true, "openFromComponent": true, "behaviorEquivalent": true }
```

Negative variant expected error: `UIFN_ADAPTER_CONTEXT_MISSING` when content renders outside root.

## TV-ADAPT-004

Description: Vue composable and component APIs expose the same behavior.

Input:

```json
{
  "framework": "vue",
  "primitive": "tabs",
  "apis": ["useTabs", "TabsRoot"],
  "event": "trigger.select:security"
}
```

Expected output:

```json
{ "valueFromComposable": "security", "valueFromComponent": "security", "behaviorEquivalent": true }
```

Negative variant expected error: `UIFN_ADAPTER_PROVIDE_INJECT_MISSING`.

## TV-ADAPT-005

Description: Solid prop getters are reactive.

Input:

```json
{
  "framework": "solid",
  "primitive": "switch",
  "initialChecked": false,
  "event": "root.click"
}
```

Expected output:

```json
{ "checkedBefore": false, "checkedAfter": true, "dataStateAfter": "checked" }
```

Negative variant expected error: `UIFN_ADAPTER_SIGNAL_STALE`.

## TV-ADAPT-006

Description: Angular directive API supports two-way binding.

Input:

```json
{
  "framework": "angular",
  "primitive": "dialog",
  "template": "<uifn-dialog [(open)]=\"open\"><button uifnDialogTrigger>Open</button></uifn-dialog>",
  "event": "trigger.click"
}
```

Expected output:

```json
{ "componentOpen": true, "hostOpen": true }
```

Negative variant expected error: `UIFN_ADAPTER_DIRECTIVE_CONTEXT_MISSING`.

## TV-STYLE-001

Description: Semantic design token schema validates.

Input:

```json
{
  "name": "uifn-light",
  "tokens": {
    "color": {
      "surface": { "canvas": { "$type": "color", "$value": "oklch(98% 0.01 250)" } },
      "text": { "primary": { "$type": "color", "$value": "oklch(20% 0.02 250)" } },
      "accent": { "solid": { "$type": "color", "$value": "oklch(55% 0.18 250)" } }
    }
  }
}
```

Expected output:

```json
{ "ok": true, "publicNames": ["surface.canvas", "text.primary", "accent.solid"] }
```

Negative variant expected error: `UIFN_TOKEN_PUBLIC_NAME_INVALID` for public-only names such as `bgs1`, `fgs1`, or `aps1`.

## TV-STYLE-002

Description: Theme mounts scoped CSS variables.

Input:

```json
{
  "theme": "uifn-dark",
  "scope": "[data-uifn-theme=\"uifn-dark\"]",
  "tokens": ["color.surface.canvas", "color.text.primary"]
}
```

Expected output:

```json
{
  "css": "[data-uifn-theme=\"uifn-dark\"]{--uifn-color-surface-canvas:oklch(...);--uifn-color-text-primary:oklch(...);}"
}
```

Negative variant expected error: `UIFN_THEME_SCOPE_INVALID` for selectors that target `html body *`.

## TV-STYLE-003

Description: OKLCH custom hue passes contrast validation.

Input:

```json
{
  "customSurface": { "hue": 260, "contrast": "auto" },
  "theme": "uifn-light",
  "pair": ["custom.solid", "custom.contrast"]
}
```

Expected output:

```json
{ "ok": true, "contrastRatio": 4.5, "minimum": 4.5 }
```

Negative variant expected error: `UIFN_TOKEN_CONTRAST_FAILED`.

## TV-STYLE-004

Description: Semantic surface and numeric depth both resolve.

Input:

```json
{
  "calls": [
    { "surface": "raised" },
    { "depth": 2 }
  ]
}
```

Expected output:

```json
{
  "results": [
    { "vars": { "--uifn-surface": "var(--uifn-color-surface-raised)" } },
    { "vars": { "--uifn-surface": "var(--uifn-color-surface-depth-2)" } }
  ]
}
```

Negative variant expected error: `UIFN_SURFACE_DEPTH_OUT_OF_RANGE` for depth `99`.

## TV-STYLE-005

Description: Tailwind output uses static classes and CSS variables.

Input:

```json
{
  "recipe": "button",
  "variant": "primary",
  "hoverEffect": "tint"
}
```

Expected output:

```json
{
  "className": "uifn-button uifn-button--primary uifn-hover--tint",
  "usesCssVars": true,
  "tailwindDynamicClassFragments": []
}
```

Negative variant expected error: `UIFN_TAILWIND_DYNAMIC_CLASS_UNSAFE` for `hover:${computedClass}`.

## TV-STYLE-006

Description: Recipe returns all output targets.

Input:

```json
{
  "recipe": "button",
  "props": { "variant": "secondary", "size": "md", "surface": "raised" }
}
```

Expected output:

```json
{
  "className": "uifn-button uifn-button--secondary uifn-button--md",
  "style": {},
  "vars": { "--uifn-button-surface": "var(--uifn-color-surface-raised)" },
  "data": { "variant": "secondary", "size": "md" }
}
```

Negative variant expected error: `UIFN_RECIPE_UNKNOWN_VARIANT`.

## TV-CATALOG-001

Description: Coss capability catalog snapshot is fully represented.

Input:

```json
{
  "components": [
    "Accordion", "Alert Dialog", "Aspect Ratio", "Avatar", "Badge", "Breadcrumb", "Button", "Calendar", "Card", "Checkbox", "Collapsible", "Command", "Context Menu", "Data Table", "Date Picker", "Dialog", "Dropdown Menu", "Form", "Hover Card", "Input", "Input OTP", "Label", "Menubar", "Pagination", "Popover", "Progress", "Radio Group", "Resizable", "Scroll Area", "Select", "Separator", "Sheet", "Sidebar", "Skeleton", "Slider", "Sonner", "Switch", "Table", "Tabs", "Textarea", "Toast", "Toggle", "Toggle Group", "Tooltip", "Typography"
  ],
  "hooks": ["useMediaQuery", "useCopyToClipboard"]
}
```

Expected output:

```json
{ "ok": true, "componentCount": 45, "hookCount": 2, "missing": [] }
```

Negative variant expected error: `UIFN_CATALOG_ENTRY_MISSING` when `Sidebar` or `useCopyToClipboard` is absent.

## TV-COMP-001

Description: Styled component contract validation.

Input:

```json
{
  "component": "Button",
  "framework": "react",
  "props": ["variant", "size", "surface", "surfaceDepth", "unstyled", "className"],
  "stories": ["default", "variants", "states", "accessibility", "theming"],
  "tests": ["render", "a11y", "visual"]
}
```

Expected output:

```json
{ "ok": true }
```

Negative variant expected error: `UIFN_COMPONENT_UNSTYLED_ESCAPE_MISSING`.

## TV-COMP-002

Description: Data Table large-data behavior.

Input:

```json
{
  "component": "Data Table",
  "rows": 10000,
  "features": ["sort", "filter", "selection", "pagination", "virtualization"],
  "event": "sort:name"
}
```

Expected output:

```json
{ "visibleRowsStable": true, "selectedRowsPreserved": true, "sort": { "column": "name", "direction": "asc" } }
```

Negative variant expected error: `UIFN_DATA_TABLE_SELECTION_LOST_ON_SORT`.

## TV-HOOK-001

Description: Hook equivalents are SSR safe and clean up listeners.

Input:

```json
{
  "hook": "useMediaQuery",
  "frameworks": ["react", "svelte", "vue", "solid", "angular"],
  "query": "(min-width: 768px)",
  "environment": "ssr"
}
```

Expected output:

```json
{ "ssrValue": false, "subscribesOnClient": true, "cleansUp": true }
```

Negative variant expected error: `UIFN_HOOK_WINDOW_ACCESSED_DURING_SSR`.

## TV-REG-001

Description: Registry manifest validates lifecycle metadata.

Input:

```json
{
  "schemaVersion": 1,
  "name": "AuthPanel",
  "kind": "sf-pattern",
  "status": "beta",
  "frameworks": ["react", "svelte", "vue", "solid", "angular"],
  "backing": ["authfn"],
  "owners": ["platform-ui"],
  "dependencies": ["Dialog", "Form", "Input", "Button"],
  "tests": ["render", "a11y", "interaction", "visual"],
  "sourcePolicy": "clean-room"
}
```

Expected output:

```json
{ "ok": true }
```

Negative variant expected error: `UIFN_REGISTRY_OWNER_MISSING`.

## TV-REG-002

Description: CLI source install writes files and lock entry.

Input:

```json
{
  "command": "uifn add button --framework react",
  "repo": { "framework": "react", "style": "tailwind" }
}
```

Expected output:

```json
{
  "written": [
    "components/ui/button.tsx",
    "components/ui/button.stories.tsx",
    "components/ui/button.fixtures.ts",
    "components/ui/button.test.tsx",
    "components/ui/button.manifest.json"
  ],
  "lockUpdated": true
}
```

Negative variant expected error: `UIFN_REGISTRY_UNSUPPORTED_FRAMEWORK` for `--framework ember`.

## TV-STORY-001

Description: Storybook preset supplies decorators and compatibility panel.

Input:

```json
{
  "storybook": {
    "preset": "@uifn/storybook",
    "decorators": ["theme", "density", "locale", "viewport", "a11y", "sf-mocks"]
  },
  "component": "Button"
}
```

Expected output:

```json
{
  "compatibilityPanel": {
    "name": "Button",
    "status": "stable",
    "dependencies": ["@uifn/recipes"],
    "frameworks": ["react", "svelte", "vue", "solid", "angular"]
  }
}
```

Negative variant expected error: `UIFN_STORYBOOK_METADATA_MISSING`.

## TV-STORY-002

Description: Story states run as tests.

Input:

```json
{
  "story": "Dialog/KeyboardFlow",
  "checks": ["interaction", "a11y", "visual"],
  "themeMatrix": ["uifn-light", "uifn-dark", "uifn-high-contrast-light", "uifn-high-contrast-dark"]
}
```

Expected output:

```json
{ "interaction": "passed", "a11y": "passed", "visual": "passed" }
```

Negative variant expected error: `UIFN_STORY_A11Y_FAILED`.

## TV-PAT-001

Description: Controlled pattern has no backend binding.

Input:

```json
{
  "pattern": "ApiKeyTable",
  "props": ["keys", "onCreate", "onRevoke", "status"],
  "imports": ["@uifn/components/react"]
}
```

Expected output:

```json
{ "backendImports": [], "states": ["loading", "empty", "error", "partial", "success"] }
```

Negative variant expected error: `UIFN_PATTERN_BACKEND_IMPORT_FORBIDDEN` when it imports `authfn`.

## TV-SF-001

Description: Superfunction-backed pattern uses injected client.

Input:

```json
  {
    "pattern": "AuthFnApiKeyTable",
    "props": ["authClient"],
    "forbiddenReads": ["global auth client singleton", "browser persisted auth token", "ambient AUTHFN token environment value"]
  }
```

Expected output:

```json
{ "usesInjectedClient": true, "forbiddenReads": [] }
```

Negative variant expected error: `UIFN_SF_GLOBAL_CLIENT_FORBIDDEN`.

## TV-SF-002

Description: Phase-one Superfunction panels exist with controlled counterparts.

Input:

```json
{
  "panels": {
    "authfn": ["AuthPanel", "ApiKeyTable"],
    "plugfn": ["ProviderPicker", "OAuthConnectionsPanel"],
    "filefn": ["FileDropzonePanel"],
    "billfn": ["BillingPlanCards", "SubscriptionStatusPanel"]
  }
}
```

Expected output:

```json
{ "ok": true, "controlledCounterparts": true, "sfBackedVariants": true }
```

Negative variant expected error: `UIFN_SF_PANEL_COUNTERPART_MISSING`.

## TV-RELEASE-001

Description: Production release gate passes complete surface.

Input:

```json
{
  "command": "npm run verify:uifn-release",
  "checks": ["build", "lint", "typecheck", "unit", "conformance", "a11y", "interaction", "visual", "ssr", "pack", "exports", "manifest", "docs"]
}
```

Expected output:

```json
{ "ok": true, "failures": [] }
```

Negative variant expected error: `UIFN_RELEASE_GATE_FAILED` with structured failure entries.

## TV-RELEASE-002

Description: Accessibility and visual failures block release.

Input:

```json
{
  "component": "Select",
  "story": "Select/Keyboard",
  "framework": "angular",
  "a11yViolations": 1,
  "visualDiffPixels": 0
}
```

Expected output:

```json
{ "ok": false, "blocking": true, "code": "UIFN_STORY_A11Y_FAILED" }
```

Negative variant expected error: `UIFN_RELEASE_FALSE_PASS` if the gate returns success.

## TV-DOCS-001

Description: Docs are generated without absolute local paths.

Input:

```json
{
  "docs": "Button docs generated from manifest and stories",
  "paths": ["uifn/components/button", "uifn/.conduct/SFN-15"]
}
```

Expected output:

```json
{ "ok": true, "absoluteLocalPaths": [] }
```

Negative variant expected error: `UIFN_DOCS_ABSOLUTE_PATH_FORBIDDEN` when a path starts with `<absolute-local-path>`.

## TV-SEC-001

Description: Logs redact secrets and local machine data.

Input:

```json
{
    "log": {
      "token": "sk_test_fake_secret",
      "path": "<absolute-local-path>",
      "tenantEmail": "person@example.invalid",
      "message": "install failed"
    }
}
```

Expected output:

```json
{
  "message": "install failed",
  "token": "[REDACTED]",
  "path": "[REDACTED_LOCAL_PATH]",
  "tenantEmail": "[REDACTED_PII]"
}
```

Negative variant expected error: `UIFN_LOG_SECRET_LEAK`.

## TV-VER-001

Description: Pre-GA legacy scaffolding is removed.

Input:

```json
{
  "api": "TooltipProvider",
  "status": "legacy-unimplemented",
  "docsMentioned": false,
  "exported": false
}
```

Expected output:

```json
{ "ok": true, "legacySurfaceRemoved": true }
```

Negative variant expected error: `UIFN_DOCS_EXPORT_DRIFT` when an unsupported legacy API is documented as available or exported.

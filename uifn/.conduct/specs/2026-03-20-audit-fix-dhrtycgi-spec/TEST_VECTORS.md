# TV-REL-001

Description: Canonical package names and export-map surface resolve from a fresh consumer smoke workspace.

Input:

```json
{
  "workspace": "temp-consumer",
  "dependencies": {
    "@uifn/core": "file:../uifn/core",
    "@uifn/react": "file:../uifn/react",
    "@uifn/svelte": "file:../uifn/svelte"
  },
  "entry": [
    "import { K } from '@uifn/core/aria/keys';",
    "import { createDialog } from '@uifn/core/primitives/dialog';",
    "import { Dialog } from '@uifn/react';",
    "import { Dialog as SvelteDialog } from '@uifn/svelte';"
  ]
}
```

Expected output:

```json
{
  "install": "success",
  "typecheck": "success",
  "bundle": "success",
  "unsupportedClaims": []
}
```

Negative variant(s):

```json
{
  "input": {
    "docsClaim": "Solid adapter is GA",
    "actualPackage": "missing"
  },
  "expectedError": {
    "code": "UIFN_ERR_UNSUPPORTED_PUBLIC_CLAIM",
    "message": "Unsupported adapters MUST NOT be advertised as supported."
  }
}
```

# TV-REL-002

Description: Public tarballs contain types and release-safe contents only.

Input:

```json
{
  "commands": [
    "cd uifn/core && npm pack --dry-run",
    "cd uifn/react && npm pack --dry-run",
    "cd uifn/svelte && npm pack --dry-run",
    "cd uifn/files && npm pack --dry-run"
  ]
}
```

Expected output:

```json
{
  "requiredFiles": [
    "README.md",
    "package.json",
    "dist/index.d.ts"
  ],
  "forbiddenPatterns": [
    "src/**/*.test.*",
    "dist/**/*.test.*",
    ".turbo/**"
  ]
}
```

Negative variant(s):

```json
{
  "input": {
    "package": "@uifn/svelte",
    "packedFiles": [
      "src/accordion.test.ts",
      "src/test/setup.ts"
    ]
  },
  "expectedError": {
    "code": "UIFN_ERR_PACK_ARTIFACT_LEAK",
    "message": "Public tarballs MUST NOT leak tests or internal-only files."
  }
}
```

# TV-REL-003

Description: Local release-gate suite verifies all required packages from one entry point.

Input:

```json
{
  "command": "npm run verify:uifn-release",
  "expectedPackages": [
    "@uifn/core",
    "@uifn/react",
    "@uifn/svelte"
  ]
}
```

Expected output:

```json
{
  "exitCode": 0,
  "checks": {
    "build": "pass",
    "lint": "pass",
    "test": "pass",
    "pack": "pass"
  }
}
```

Negative variant(s):

```json
{
  "input": {
    "package": "@uifn/core",
    "lintConfig": "missing"
  },
  "expectedError": {
    "code": "UIFN_ERR_TOOLCHAIN_MISCONFIG",
    "message": "Release verification MUST fail when any required quality gate is misconfigured."
  }
}
```

# TV-CORE-001

Description: Core owns shared selection semantics and adapters match the same golden behavior.

Input:

```json
{
  "family": "Tabs",
  "scenario": {
    "mode": "controlled",
    "value": "tab-2",
    "orientation": "horizontal",
    "activationMode": "automatic"
  }
}
```

Expected output:

```json
{
  "coreState": {
    "value": "tab-2"
  },
  "reactState": {
    "value": "tab-2"
  },
  "svelteState": {
    "value": "tab-2"
  }
}
```

Negative variant(s):

```json
{
  "input": {
    "reactState": "tab-2",
    "svelteState": "tab-1"
  },
  "expectedError": {
    "code": "UIFN_ERR_CONTROLLED_STATE_DIVERGENCE",
    "message": "Adapters MUST NOT diverge from core-owned semantics."
  }
}
```

# TV-CORE-002

Description: Deterministic IDs and stable utility exports work across SSR and hydration.

Input:

```json
{
  "scenario": {
    "serverRender": ["DialogTitle", "DialogDescription"],
    "clientHydrate": ["DialogTitle", "DialogDescription"]
  }
}
```

Expected output:

```json
{
  "serverIds": ["uifn-dialog-title-1", "uifn-dialog-description-1"],
  "clientIds": ["uifn-dialog-title-1", "uifn-dialog-description-1"]
}
```

Negative variant(s):

```json
{
  "input": {
    "idStrategy": "Math.random()"
  },
  "expectedError": {
    "code": "UIFN_ERR_DETERMINISTIC_ID_MISMATCH",
    "message": "Public IDs MUST be deterministic across server, client, and tests."
  }
}
```

# TV-CORE-003

Description: Canonical runtime errors and production-safe observability.

Input:

```json
{
  "scenario": "Render DialogTrigger outside Dialog provider",
  "environment": "production"
}
```

Expected output:

```json
{
  "thrownError": {
    "name": "UIFnError",
    "code": "UIFN_ERR_CONTEXT_MISSING",
    "recoverable": false
  },
  "consoleOutput": []
}
```

Negative variant(s):

```json
{
  "input": {
    "bundleContains": "console.log('Presence check')"
  },
  "expectedError": {
    "code": "UIFN_ERR_TOOLCHAIN_MISCONFIG",
    "message": "Production bundles MUST NOT include ad hoc debug logging."
  }
}
```

# TV-CORE-004

Description: Representative accessibility baseline for popup, collection, and form families.

Input:

```json
{
  "families": [
    "Dialog",
    "Tabs",
    "Checkbox",
    "Select"
  ],
  "checks": [
    "keyboard navigation",
    "aria roles",
    "focus management",
    "reduced-motion cleanup"
  ]
}
```

Expected output:

```json
{
  "axe": "pass",
  "keyboard": "pass",
  "focus": "pass",
  "reducedMotion": "pass"
}
```

Negative variant(s):

```json
{
  "input": {
    "tooltip": {
      "role": "missing"
    }
  },
  "expectedError": {
    "code": "UIFN_ERR_A11Y_GATE_FAILURE",
    "message": "GA primitives MUST meet the documented accessibility contract."
  }
}
```

# TV-DISC-001

Description: Disclosure-family controlled/uncontrolled and roving-focus behavior.

Input:

```json
{
  "family": "Accordion",
  "scenario": {
    "type": "single",
    "collapsible": true,
    "defaultValue": "item-1",
    "keyboard": ["ArrowDown", "Enter", "Enter"]
  }
}
```

Expected output:

```json
{
  "stateSequence": [
    "item-1",
    "item-2",
    ""
  ],
  "focusSequence": [
    "trigger-item-1",
    "trigger-item-2",
    "trigger-item-2"
  ]
}
```

Negative variant(s):

```json
{
  "input": {
    "controlledValue": "item-9",
    "registeredItems": ["item-1", "item-2"]
  },
  "expectedError": {
    "code": "UIFN_ERR_INVALID_VALUE",
    "message": "Invalid external values MUST be handled deterministically."
  }
}
```

# TV-FORM-001

Description: Form-control serialization and ARIA behavior.

Input:

```json
{
  "family": "Checkbox",
  "scenario": {
    "name": "terms",
    "defaultChecked": "indeterminate",
    "keyboard": ["Space"]
  }
}
```

Expected output:

```json
{
  "ariaCheckedBefore": "mixed",
  "ariaCheckedAfter": "true",
  "submittedFormValue": {
    "terms": "on"
  }
}
```

Negative variant(s):

```json
{
  "input": {
    "disabled": true,
    "keyboard": ["Space"]
  },
  "expectedError": {
    "code": "UIFN_ERR_DISABLED_INTERACTION",
    "message": "Disabled controls MUST ignore state-changing input."
  }
}
```

# TV-DLG-001

Description: Dialog and alert-dialog modal lifecycle.

Input:

```json
{
  "family": "Dialog",
  "scenario": {
    "openVia": "trigger-click",
    "closeVia": "Escape"
  }
}
```

Expected output:

```json
{
  "focusAfterOpen": "dialog-content",
  "focusAfterClose": "dialog-trigger",
  "closeReason": "close-escape",
  "bodyScrollLockedWhileOpen": true,
  "bodyScrollLockedAfterClose": false
}
```

Negative variant(s):

```json
{
  "input": {
    "family": "AlertDialog",
    "outsideClick": true,
    "policy": "disallow"
  },
  "expectedError": {
    "code": "UIFN_ERR_INVALID_VALUE",
    "message": "AlertDialog outside-click behavior MUST follow documented policy."
  }
}
```

# TV-POP-001

Description: Popover-family positioning and cleanup.

Input:

```json
{
  "family": "Tooltip",
  "scenario": {
    "delayDuration": 700,
    "anchorRect": {
      "top": 10,
      "left": 10,
      "width": 40,
      "height": 20
    },
    "viewport": {
      "width": 320,
      "height": 200
    }
  }
}
```

Expected output:

```json
{
  "openAfterDelayMs": 700,
  "computedSide": "bottom",
  "cleanupAfterClose": {
    "timers": 0,
    "listeners": 0
  }
}
```

Negative variant(s):

```json
{
  "input": {
    "anchorRect": {
      "top": 190,
      "left": 290,
      "width": 40,
      "height": 20
    },
    "positioning": "no collision handling"
  },
  "expectedError": {
    "code": "UIFN_ERR_POSITIONING_OVERFLOW",
    "message": "Popup families MUST resolve collisions deterministically."
  }
}
```

# TV-MENU-001

Description: Menu-family nested navigation and disabled-item behavior.

Input:

```json
{
  "family": "DropdownMenu",
  "scenario": {
    "items": [
      "open",
      "share",
      "disabled-delete",
      "more-submenu"
    ],
    "keyboard": ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowRight", "Escape"]
  }
}
```

Expected output:

```json
{
  "focusSequence": [
    "open",
    "share",
    "more-submenu",
    "submenu-first-item",
    "more-submenu"
  ],
  "disabledItemsSkipped": true
}
```

Negative variant(s):

```json
{
  "input": {
    "submenuDepth": 2,
    "escapeResult": "root menu remains stuck open"
  },
  "expectedError": {
    "code": "UIFN_ERR_MENU_NAVIGATION",
    "message": "Nested menus MUST restore focus and close deterministically."
  }
}
```

# TV-SEL-001

Description: Select controlled state, grouping, and typeahead.

Input:

```json
{
  "scenario": {
    "groups": {
      "Fruits": ["Apple", "Apricot"],
      "Vegetables": ["Beet"]
    },
    "defaultValue": "Apple",
    "keyboard": ["ArrowDown", "A", "Enter"]
  }
}
```

Expected output:

```json
{
  "highlightedItem": "Apricot",
  "selectedItem": "Apricot",
  "hiddenInputValue": "Apricot"
}
```

Negative variant(s):

```json
{
  "input": {
    "controlledValue": "Dragonfruit",
    "items": ["Apple", "Apricot", "Beet"]
  },
  "expectedError": {
    "code": "UIFN_ERR_INVALID_VALUE",
    "message": "Select MUST not silently select an arbitrary fallback item."
  }
}
```

# TV-CMB-001

Description: Combobox filtering, highlight state, and empty state.

Input:

```json
{
  "scenario": {
    "items": ["Alpha", "Beta", "Gamma"],
    "inputValue": "ga",
    "keyboard": ["ArrowDown", "Enter"]
  }
}
```

Expected output:

```json
{
  "filteredItems": ["Gamma"],
  "highlightedItem": "Gamma",
  "selectedValue": "Gamma",
  "emptyStateShown": false
}
```

Negative variant(s):

```json
{
  "input": {
    "inputValue": "zz",
    "selectedValueAfterEnter": "Alpha"
  },
  "expectedError": {
    "code": "UIFN_ERR_COMBOBOX_FILTER_STATE",
    "message": "Combobox MUST not select an item that is not in the filtered result set."
  }
}
```

# TV-RANGE-001

Description: Slider clamping, multi-thumb behavior, and indeterminate progress.

Input:

```json
{
  "slider": {
    "defaultValue": [20, 80],
    "min": 0,
    "max": 100,
    "step": 10,
    "keyboard": ["ArrowRight"]
  },
  "progress": {
    "value": null,
    "max": 100
  }
}
```

Expected output:

```json
{
  "sliderValueAfterKey": [30, 80],
  "sliderThumbOrderStable": true,
  "progressAriaNow": null,
  "progressMode": "indeterminate"
}
```

Negative variant(s):

```json
{
  "input": {
    "sliderSetValue": [-5, 135]
  },
  "expectedError": {
    "code": "UIFN_ERR_RANGE_OUT_OF_BOUNDS",
    "message": "Slider values MUST clamp and preserve deterministic thumb ordering."
  }
}
```

# TV-SCROLL-001

Description: Scroll-area viewport and thumb synchronization.

Input:

```json
{
  "scenario": {
    "viewport": {
      "scrollHeight": 2000,
      "clientHeight": 200
    },
    "userAction": "drag-thumb-to-50-percent"
  }
}
```

Expected output:

```json
{
  "viewportScrollTop": 900,
  "thumbPositionPercent": 50,
  "cornerVisible": false
}
```

Negative variant(s):

```json
{
  "input": {
    "thumbPositionPercent": 50,
    "viewportScrollTop": 0
  },
  "expectedError": {
    "code": "UIFN_ERR_SCROLL_SYNC",
    "message": "ScrollArea viewport and thumb state MUST remain synchronized."
  }
}
```

# TV-SIMPLE-001

Description: Display-helper surfaces are truthful, deterministic, and documented.

Input:

```json
{
  "surfaces": [
    "Avatar",
    "Badge",
    "Label",
    "Separator",
    "VirtualizedList"
  ],
  "scenario": {
    "avatarImageError": true,
    "virtualizedItemCount": 10000
  }
}
```

Expected output:

```json
{
  "avatarFallbackVisible": true,
  "badgeContractDocumented": true,
  "virtualizedRenderedNodesLessThan": 200
}
```

Negative variant(s):

```json
{
  "input": {
    "READMEClaims": ["VirtualizedList"],
    "exportMissing": true
  },
  "expectedError": {
    "code": "UIFN_ERR_PUBLIC_SURFACE_DRIFT",
    "message": "Public display helpers MUST be documented and actually exported."
  }
}
```

# TV-REACT-001

Description: React `asChild`, ref forwarding, and typed exports.

Input:

```json
{
  "scenario": {
    "component": "DialogTrigger",
    "asChild": true,
    "child": "<a href='/docs'>Open</a>"
  }
}
```

Expected output:

```json
{
  "renderedTag": "A",
  "behavior": "opens-dialog",
  "forwardedRefTarget": "A"
}
```

Negative variant(s):

```json
{
  "input": {
    "asChild": true,
    "behaviorLost": true
  },
  "expectedError": {
    "code": "UIFN_ERR_ASCHILD_CONTRACT",
    "message": "Polymorphic React host components MUST preserve semantics and refs."
  }
}
```

# TV-REACT-002

Description: React SSR/hydration and local verification.

Input:

```json
{
  "commands": [
    "cd uifn/react && npm test -- --run",
    "cd uifn/react && npm run build",
    "cd uifn/react && npm run lint",
    "cd uifn/react && npm pack --dry-run"
  ],
  "scenario": "SSR render and hydrate a Dialog with generated ids"
}
```

Expected output:

```json
{
  "commandsExitCode": 0,
  "hydrationWarnings": [],
  "idMismatch": false
}
```

Negative variant(s):

```json
{
  "input": {
    "importPath": "@uifn/core/aria/keys",
    "resolution": "missing export map entry"
  },
  "expectedError": {
    "code": "UIFN_ERR_EXPORT_SURFACE_MISMATCH",
    "message": "React GA verification MUST fail when required core imports are not publicly resolvable."
  }
}
```

# TV-SVELTE-001

Description: Svelte controlled prop reactivity and declaration presence.

Input:

```json
{
  "scenario": {
    "component": "Accordion",
    "initialPropValue": "item-1",
    "updatedPropValue": "item-2"
  }
}
```

Expected output:

```json
{
  "renderedOpenItemAfterUpdate": "item-2",
  "declarationsPresent": true,
  "buildWarnings": []
}
```

Negative variant(s):

```json
{
  "input": {
    "component": "Accordion",
    "behavior": "still renders item-1 after prop update"
  },
  "expectedError": {
    "code": "UIFN_ERR_SVELTE_REACTIVITY_SNAPSHOT",
    "message": "Svelte GA components MUST not freeze initial controlled props."
  }
}
```

# TV-SVELTE-002

Description: Svelte toolchain compatibility and tarball cleanliness.

Input:

```json
{
  "commands": [
    "cd uifn/svelte && npm test -- --run",
    "cd uifn/svelte && npm run build",
    "cd uifn/svelte && npm run lint",
    "cd uifn/svelte && npm pack --dry-run"
  ]
}
```

Expected output:

```json
{
  "commandsExitCode": 0,
  "types": "present",
  "packedTests": []
}
```

Negative variant(s):

```json
{
  "input": {
    "dependencyGraph": {
      "@sveltejs/vite-plugin-svelte": "^5.1.1",
      "vite": "5.4.21"
    }
  },
  "expectedError": {
    "code": "UIFN_ERR_TOOLCHAIN_MISCONFIG",
    "message": "Svelte verification MUST fail when the declared toolchain matrix is invalid."
  }
}
```

# TV-DOCS-001

Description: Docs and manifests agree on public API, support matrix, and license.

Input:

```json
{
  "files": [
    "uifn/.conduct/SPEC.md",
    "uifn/core/README.md",
    "uifn/react/README.md",
    "uifn/svelte/README.md",
    "uifn/vue/README.md",
    "uifn/core/package.json",
    "uifn/react/package.json",
    "uifn/svelte/package.json",
    "uifn/vue/package.json"
  ]
}
```

Expected output:

```json
{
  "packageNamesAligned": true,
  "licenseAligned": true,
  "supportMatrixAligned": true,
  "componentCatalogAligned": true
}
```

Negative variant(s):

```json
{
  "input": {
    "vueReadmeApi": "useCheckbox composable",
    "actualExports": "component exports only"
  },
  "expectedError": {
    "code": "UIFN_ERR_DOCS_DRIFT",
    "message": "Public docs MUST match the shipped API shape."
  }
}
```

# TV-FILES-001

Description: `@uifn/files` is either in-scope and documented or removed from `uifn` claims.

Input:

```json
{
  "package": "@uifn/files",
  "decision": "keep-public"
}
```

Expected output:

```json
{
  "readmePresent": true,
  "supportMatrixLabel": "experimental",
  "packedTests": []
}
```

Negative variant(s):

```json
{
  "input": {
    "package": "@uifn/files",
    "decision": "keep-public",
    "packedFiles": ["dist/index.test.js"]
  },
  "expectedError": {
    "code": "UIFN_ERR_FILES_SCOPE_DRIFT",
    "message": "Public files package MUST be documented and pack-clean if it remains in `uifn`."
  }
}
```

# TV-QA-001

Description: Automated coverage exists for every GA family in core, React, and Svelte.

Input:

```json
{
  "gaFamilies": [
    "Accordion",
    "Dialog",
    "Checkbox",
    "Select",
    "Combobox",
    "DropdownMenu",
    "Tooltip"
  ]
}
```

Expected output:

```json
{
  "coreUnitCoverage": "present",
  "reactIntegrationCoverage": "present",
  "svelteIntegrationCoverage": "present"
}
```

Negative variant(s):

```json
{
  "input": {
    "family": "Dialog",
    "coreTests": 0
  },
  "expectedError": {
    "code": "UIFN_ERR_TEST_MATRIX_GAP",
    "message": "Every GA family MUST have layer-appropriate automated coverage."
  }
}
```

# TV-QA-002

Description: Automated and manual accessibility verification gate.

Input:

```json
{
  "releaseCandidate": "uifn-rc",
  "manualChecklistFamilies": [
    "Dialog",
    "Select",
    "Combobox",
    "Toast"
  ]
}
```

Expected output:

```json
{
  "axeSmoke": "pass",
  "keyboardChecklist": "recorded",
  "screenReaderChecklist": "recorded"
}
```

Negative variant(s):

```json
{
  "input": {
    "screenReaderChecklist": "missing"
  },
  "expectedError": {
    "code": "UIFN_ERR_A11Y_GATE_FAILURE",
    "message": "GA release requires manual accessibility verification records."
  }
}
```

# TV-COMPAT-001

Description: Supported environment matrix is explicit and enforced.

Input:

```json
{
  "matrix": {
    "node": ["18", "20", "22"],
    "react": "18.2+",
    "svelte": "5.x"
  }
}
```

Expected output:

```json
{
  "manifestPeerRangesAligned": true,
  "docsAligned": true,
  "supportedMatrixSmokeInstall": "success"
}
```

Negative variant(s):

```json
{
  "input": {
    "package": "@uifn/svelte",
    "peerRange": ">=5.0.0",
    "actualToolchain": "requires Vite 6 but installs Vite 5"
  },
  "expectedError": {
    "code": "UIFN_ERR_UNSUPPORTED_ENVIRONMENT",
    "message": "Package support ranges MUST match the actually verified toolchain matrix."
  }
}
```

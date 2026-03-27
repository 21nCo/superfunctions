# TV-REL-001

Description: Canonical package names, status labels, and public symbol claims are aligned across docs and shipped exports.

Input:

```json
{
  "files": [
    "uifn/README.md",
    "uifn/.conduct/SPEC.md",
    "uifn/react/README.md",
    "uifn/svelte/README.md",
    "uifn/vue/README.md",
    "uifn/files/README.md",
    "uifn/react/src/index.ts",
    "uifn/svelte/src/index.ts"
  ]
}
```

Expected output:

```json
{
  "packageNamesAligned": true,
  "statusLabelsAligned": true,
  "publicClaimsMatchExports": true
}
```

Negative variant(s):

```json
{
  "input": {
    "rootSpecClaim": "TooltipProvider is public",
    "actualExport": "missing"
  },
  "expectedError": {
    "code": "UIFN_ERR_PUBLIC_SURFACE_DRIFT",
    "message": "Public docs MUST NOT claim symbols that are not exported."
  }
}
```

# TV-REL-002

Description: Public tarballs remain clean and typed.

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
  "requiredFilesPresent": true,
  "typesPresent": true,
  "leakedTests": []
}
```

Negative variant(s):

```json
{
  "input": {
    "package": "@uifn/svelte",
    "packedFiles": [
      "src/dialog.test.ts"
    ]
  },
  "expectedError": {
    "code": "UIFN_ERR_PACK_ARTIFACT_LEAK",
    "message": "Public tarballs MUST NOT leak tests or internal-only files."
  }
}
```

# TV-REL-003

Description: The release gate validates package checks and consumer smoke verification.

Input:

```json
{
  "command": "npm run verify:uifn-release",
  "requiredPackages": [
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
  "manifestPresent": true,
  "consumerSmoke": "pass"
}
```

Negative variant(s):

```json
{
  "input": {
    "consumerSmoke": "not-run"
  },
  "expectedError": {
    "code": "UIFN_ERR_CONSUMER_SMOKE_FAILURE",
    "message": "GA release verification MUST fail when consumer smoke checks are missing or failing."
  }
}
```

# TV-CORE-001

Description: Shared GA semantics are owned by core and reflected consistently by adapters.

Input:

```json
{
  "family": "Tabs",
  "scenario": {
    "value": "tab-2",
    "orientation": "horizontal",
    "activationMode": "automatic"
  }
}
```

Expected output:

```json
{
  "coreState": "tab-2",
  "reactState": "tab-2",
  "svelteState": "tab-2"
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

Description: Public IDs and ARIA relationships are deterministic and unique across SSR, hydration, and multiple instances.

Input:

```json
{
  "scenario": {
    "instances": 3,
    "families": ["Dialog", "Select"],
    "renderModes": ["server", "hydrate", "client"]
  }
}
```

Expected output:

```json
{
  "randomIdsDetected": false,
  "duplicateIdsDetected": false,
  "ariaTargetsResolved": true
}
```

Negative variant(s):

```json
{
  "input": {
    "dialogIds": ["dialog-content", "dialog-content"]
  },
  "expectedError": {
    "code": "UIFN_ERR_DUPLICATE_PUBLIC_ID",
    "message": "GA surfaces MUST NOT share fixed instance-scoped IDs."
  }
}
```

# TV-CORE-003

Description: Public misuse throws canonical `UIFnError` payloads.

Input:

```json
{
  "scenario": "Render DialogTrigger outside Dialog provider"
}
```

Expected output:

```json
{
  "error": {
    "name": "UIFnError",
    "code": "UIFN_ERR_CONTEXT_MISSING"
  }
}
```

Negative variant(s):

```json
{
  "input": {
    "thrownError": "Error: Dialog components must be used within a Dialog"
  },
  "expectedError": {
    "code": "UIFN_ERR_CONTEXT_MISSING",
    "message": "Adapter context failures MUST throw canonical UIFN errors."
  }
}
```

# TV-CORE-004

Description: Representative accessibility baseline remains intact.

Input:

```json
{
  "families": ["Dialog", "Tabs", "Checkbox", "Select"],
  "checks": ["axe", "keyboard", "focus", "reducedMotion"]
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
    "reducedMotionCleanup": "broken"
  },
  "expectedError": {
    "code": "UIFN_ERR_A11Y_GATE_FAILURE",
    "message": "Reduced-motion handling MUST NOT break cleanup or behavior."
  }
}
```

# TV-DISC-001

Description: Disclosure and collection families satisfy documented keyboard semantics.

Input:

```json
{
  "family": "Tabs",
  "keyboard": ["ArrowRight", "Home", "End"]
}
```

Expected output:

```json
{
  "focusMoves": true,
  "activationModeRespected": true
}
```

Negative variant(s):

```json
{
  "input": {
    "svelteTabsArrowRight": "no-op"
  },
  "expectedError": {
    "code": "UIFN_ERR_TEST_MATRIX_GAP",
    "message": "Disclosure and collection families MUST implement the documented keyboard contract."
  }
}
```

# TV-FORM-001

Description: Form controls expose correct ARIA and serialization behavior.

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
  "serializedValue": {
    "terms": "on"
  }
}
```

Negative variant(s):

```json
{
  "input": {
    "disabled": true,
    "stateChanged": true
  },
  "expectedError": {
    "code": "UIFN_ERR_INVALID_VALUE",
    "message": "Disabled form controls MUST ignore state-changing input."
  }
}
```

# TV-DLG-001

Description: Modal dialogs satisfy focus, scroll lock, and close-policy semantics.

Input:

```json
{
  "families": ["Dialog", "AlertDialog"],
  "scenario": {
    "openVia": "trigger-click",
    "closeVia": "Escape"
  }
}
```

Expected output:

```json
{
  "focusTrap": "pass",
  "returnFocus": "pass",
  "scrollLockWhileOpen": true,
  "scrollLockAfterClose": false
}
```

Negative variant(s):

```json
{
  "input": {
    "framework": "svelte",
    "bodyScrollLock": "missing"
  },
  "expectedError": {
    "code": "UIFN_ERR_DIALOG_MODAL_INCOMPLETE",
    "message": "Modal dialog implementations MUST lock and restore body scrolling correctly."
  }
}
```

# TV-POP-001

Description: Popup families remain collision-aware and clean up listeners/timers.

Input:

```json
{
  "family": "Tooltip",
  "scenario": {
    "delayDuration": 500,
    "viewportCollision": true
  }
}
```

Expected output:

```json
{
  "positionResolved": true,
  "delayRespected": true,
  "cleanup": {
    "timers": 0,
    "listeners": 0
  }
}
```

Negative variant(s):

```json
{
  "input": {
    "cleanup": {
      "timers": 2
    }
  },
  "expectedError": {
    "code": "UIFN_ERR_POSITIONING_OVERFLOW",
    "message": "Popup implementations MUST clean up stale timers and listeners."
  }
}
```

# TV-MENU-001

Description: Menu families support deterministic navigation and submenu depth.

Input:

```json
{
  "family": "DropdownMenu",
  "scenario": {
    "submenuDepth": 3,
    "keyboard": ["ArrowDown", "ArrowRight", "Escape"]
  }
}
```

Expected output:

```json
{
  "navigationPass": true,
  "submenuDepthPass": true,
  "disabledItemsSkipped": true
}
```

Negative variant(s):

```json
{
  "input": {
    "submenuDepth": 2,
    "escapeLeavesMenuStuckOpen": true
  },
  "expectedError": {
    "code": "UIFN_ERR_MENU_NAVIGATION",
    "message": "Nested menus MUST close and restore focus deterministically."
  }
}
```

# TV-SEL-001

Description: Select supports unique IDs, keyboard control, and grouped item semantics.

Input:

```json
{
  "instances": 2,
  "scenario": {
    "defaultValue": "Apple",
    "keyboard": ["ArrowDown", "Enter"]
  }
}
```

Expected output:

```json
{
  "selectedItem": "Apricot",
  "ariaRelationshipsUnique": true,
  "hiddenInputValue": "Apricot"
}
```

Negative variant(s):

```json
{
  "input": {
    "selectIds": ["select-content", "select-content"]
  },
  "expectedError": {
    "code": "UIFN_ERR_DUPLICATE_PUBLIC_ID",
    "message": "Select instances MUST NOT share public listbox IDs."
  }
}
```

# TV-CMB-001

Description: Combobox filtering and selection remain constrained to the filtered result set.

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
  "selectedValue": "Gamma",
  "ariaRelationshipsUnique": true
}
```

Negative variant(s):

```json
{
  "input": {
    "rootSpecClaim": "multiple selection",
    "actualImplementation": "single only"
  },
  "expectedError": {
    "code": "UIFN_ERR_DOCS_DRIFT",
    "message": "Combobox public claims MUST match the shipped GA selection model."
  }
}
```

# TV-RANGE-001

Description: Slider and progress satisfy clamping and indeterminate semantics.

Input:

```json
{
  "slider": {
    "defaultValue": [20, 80],
    "min": 0,
    "max": 100,
    "step": 10
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
  "sliderValueAfterStep": [30, 80],
  "thumbOrderStable": true,
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
    "message": "Slider values MUST clamp and preserve deterministic ordering."
  }
}
```

# TV-SCROLL-001

Description: Scroll area synchronizes viewport and thumb state.

Input:

```json
{
  "scenario": {
    "viewportScrollTop": 900,
    "clientHeight": 200,
    "scrollHeight": 2000
  }
}
```

Expected output:

```json
{
  "thumbPositionPercent": 50,
  "viewportSync": "pass"
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
    "message": "ScrollArea thumb and viewport state MUST remain synchronized."
  }
}
```

# TV-SIMPLE-001

Description: Display helpers remain truthful and bounded.

Input:

```json
{
  "scenario": {
    "avatarImageError": true,
    "virtualizedItemCount": 10000,
    "overscan": 3
  }
}
```

Expected output:

```json
{
  "avatarFallbackVisible": true,
  "virtualizedMountedNodesLessThan": 200,
  "docsMatchAdapterOnlyStatus": true
}
```

Negative variant(s):

```json
{
  "input": {
    "virtualizedMountedNodes": 10000
  },
  "expectedError": {
    "code": "UIFN_ERR_TEST_MATRIX_GAP",
    "message": "VirtualizedList scale claims MUST be backed by bounded rendering behavior."
  }
}
```

# TV-REACT-001

Description: React public API preserves typed exports, `asChild`, refs, and core-owned semantics.

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
  "forwardedRefTarget": "A",
  "semanticParityWithCore": true
}
```

Negative variant(s):

```json
{
  "input": {
    "thrownError": "Error"
  },
  "expectedError": {
    "code": "UIFN_ERR_CONTEXT_MISSING",
    "message": "React adapter misuse MUST surface canonical UIFN errors."
  }
}
```

# TV-REACT-002

Description: React remains SSR-safe and multi-instance safe.

Input:

```json
{
  "scenario": {
    "renderModes": ["server", "hydrate"],
    "instances": 3,
    "families": ["Dialog", "Select", "Combobox"]
  }
}
```

Expected output:

```json
{
  "hydrationWarnings": [],
  "duplicateIdsDetected": false,
  "packageVerification": "pass"
}
```

Negative variant(s):

```json
{
  "input": {
    "reactIds": ["dialog-content", "dialog-content"]
  },
  "expectedError": {
    "code": "UIFN_ERR_HYDRATION_MISMATCH",
    "message": "React GA surfaces MUST be SSR-safe and collision-free across multiple instances."
  }
}
```

# TV-SVELTE-001

Description: Svelte uses deterministic IDs and reflects controlled prop changes after mount.

Input:

```json
{
  "scenario": {
    "component": "Dialog",
    "instances": 2,
    "controlledUpdate": {
      "family": "Accordion",
      "from": "item-1",
      "to": "item-2"
    }
  }
}
```

Expected output:

```json
{
  "randomIdsDetected": false,
  "duplicateIdsDetected": false,
  "controlledUpdateReflected": true
}
```

Negative variant(s):

```json
{
  "input": {
    "sourceContains": "Math.random()"
  },
  "expectedError": {
    "code": "UIFN_ERR_DETERMINISTIC_ID_MISMATCH",
    "message": "Svelte GA surfaces MUST NOT generate public IDs from randomness."
  }
}
```

# TV-SVELTE-002

Description: Svelte builds warning-free and satisfies modal and keyboard semantics.

Input:

```json
{
  "commands": [
    "cd uifn/svelte && npm run build",
    "cd uifn/svelte && npm test -- --run"
  ],
  "scenario": {
    "families": ["Dialog", "AlertDialog", "Tabs"]
  }
}
```

Expected output:

```json
{
  "buildWarnings": [],
  "scrollLock": "pass",
  "tabsKeyboard": "pass"
}
```

Negative variant(s):

```json
{
  "input": {
    "buildConfig": "warningFilter suppresses state_referenced_locally"
  },
  "expectedError": {
    "code": "UIFN_ERR_WARNING_SUPPRESSED",
    "message": "GA Svelte builds MUST NOT suppress compiler warnings to pass verification."
  }
}
```

# TV-DOCS-001

Description: Root docs and package docs match the shipped API and release policy.

Input:

```json
{
  "files": [
    "uifn/.conduct/SPEC.md",
    "uifn/README.md",
    "uifn/react/README.md",
    "uifn/svelte/README.md",
    "uifn/vue/README.md",
    "uifn/files/README.md"
  ]
}
```

Expected output:

```json
{
  "surfaceClaimsAligned": true,
  "statusClaimsAligned": true,
  "manualA11yPolicyAligned": true
}
```

Negative variant(s):

```json
{
  "input": {
    "rootSpecClaim": "TooltipArrow is public",
    "packageExports": "missing"
  },
  "expectedError": {
    "code": "UIFN_ERR_DOCS_DRIFT",
    "message": "Root and package documentation MUST match the shipped public API."
  }
}
```

# TV-FILES-001

Description: `@uifn/files` remains explicitly Experimental and pack-clean.

Input:

```json
{
  "package": "@uifn/files"
}
```

Expected output:

```json
{
  "status": "Experimental",
  "readmeMatchesExports": true,
  "packedTests": []
}
```

Negative variant(s):

```json
{
  "input": {
    "supportMatrixLabel": "GA"
  },
  "expectedError": {
    "code": "UIFN_ERR_FILES_SCOPE_DRIFT",
    "message": "The files package MUST remain explicitly Experimental unless its product boundary changes intentionally."
  }
}
```

# TV-QA-001

Description: Automated coverage includes the production-readiness regressions found by the latest audit.

Input:

```json
{
  "requiredCoverage": [
    "duplicate-instance IDs",
    "Svelte Tabs keyboard navigation",
    "Svelte modal scroll lock",
    "consumer smoke imports",
    "virtualized-list scale",
    "menu depth"
  ]
}
```

Expected output:

```json
{
  "coveragePresent": true,
  "criticalRegressionGaps": []
}
```

Negative variant(s):

```json
{
  "input": {
    "missingCoverage": ["Svelte modal scroll lock"]
  },
  "expectedError": {
    "code": "UIFN_ERR_TEST_MATRIX_GAP",
    "message": "Automated coverage MUST include regressions for every release-blocking audit finding."
  }
}
```

# TV-QA-002

Description: Manual accessibility evidence is recorded from real browsers and assistive technologies.

Input:

```json
{
  "evidence": {
    "frameworks": ["react", "svelte"],
    "families": ["Dialog", "Select", "Combobox", "Toast"],
    "assistiveTech": ["VoiceOver", "NVDA"]
  }
}
```

Expected output:

```json
{
  "manualEvidenceValid": true,
  "jsdomOnly": false
}
```

Negative variant(s):

```json
{
  "input": {
    "environment": "JSDOM via Vitest + Testing Library"
  },
  "expectedError": {
    "code": "UIFN_ERR_MANUAL_EVIDENCE_INVALID",
    "message": "Manual accessibility evidence MUST come from real browser and assistive-technology runs."
  }
}
```

# TV-COMPAT-001

Description: Supported environment claims are enforced and resolvable in a clean consumer workspace.

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
  "docsAligned": true,
  "manifestAligned": true,
  "consumerSmoke": "pass"
}
```

Negative variant(s):

```json
{
  "input": {
    "declaredSvelteSupport": "5.x",
    "actualBuildRequiresSuppression": true
  },
  "expectedError": {
    "code": "UIFN_ERR_UNSUPPORTED_ENVIRONMENT",
    "message": "Declared compatibility MUST match what the packages can verify without hidden exceptions."
  }
}
```


# Test Vectors

## TV-BOUNDARY-001

- Description: Node-related public type and option shapes remain unchanged after the fix bundle.
- Input:

```json
{
  "files": [
    "drawfn/core/src/types.ts",
    "drawfn/core/src/tools/node-tool.ts"
  ],
  "assert": {
    "nodeElementFields": ["type", "nodeId", "nodeType", "variant", "preview"],
    "nodeToolOptionFields": ["nodeId", "nodeType", "variant", "preview"]
  }
}
```

- Expected output:

```json
{
  "ok": true,
  "changedNodeFields": []
}
```

- Negative variant(s):
  - If a node field is added, removed, or renamed, expected error:

```json
{
  "ok": false,
  "error": {
    "code": "BOUNDARY_VIOLATION",
    "message": "Node-related public surface changed outside scope."
  }
}
```

## TV-BOUNDARY-002

- Description: No new node/Nucleus callbacks or migration hooks are introduced.
- Input:

```json
{
  "grep": [
    "registerNodePreviewFetcher",
    "onNodeClick",
    "getNodePreview"
  ],
  "scope": [
    "drawfn/core/src",
    "drawfn/drawfn-react/src",
    "drawfn/drawfn-svelte/src"
  ]
}
```

- Expected output:

```json
{
  "ok": true,
  "allowedOccurrences": "existing backward-compatible declarations only"
}
```

- Negative variant(s):
  - New node-specific exported hooks, migration helpers, or changed signatures MUST fail with `BOUNDARY_VIOLATION`.

## TV-SURFACE-001

- Description: Package manifests, README install commands, and import examples use the canonical drawfn identifiers and MIT license.
- Input:

```json
{
  "files": [
    "drawfn/core/package.json",
    "drawfn/drawfn-react/package.json",
    "drawfn/drawfn-svelte/package.json",
    "drawfn/core/README.md",
    "drawfn/drawfn-react/README.md",
    "drawfn/drawfn-svelte/README.md"
  ]
}
```

- Expected output:

```json
{
  "packages": ["drawfn", "@drawfn/react", "@drawfn/svelte"],
  "license": "MIT",
  "legacyMentions": []
}
```

- Negative variant(s):
  - Any `@21n/drawfn` or `Apache-2.0` mention in drawfn package docs after the fix MUST fail with:

```json
{
  "ok": false,
  "error": {
    "code": "SURFACE_MISMATCH",
    "message": "Documentation and package metadata disagree."
  }
}
```

## TV-SURFACE-002

- Description: Source imports and re-exports use the canonical core package name.
- Input:

```json
{
  "scope": [
    "drawfn/drawfn-react/src",
    "drawfn/drawfn-svelte/src"
  ],
  "grep": [
    "from 'drawfn'",
    "from '@21n/drawfn'",
    "from 'drawfn';",
    "from '@21n/drawfn';"
  ]
}
```

- Expected output:

```json
{
  "ok": true,
  "requiredImports": ["drawfn"],
  "forbiddenImports": ["@21n/drawfn"]
}
```

- Negative variant(s):
  - Any adapter import from `@21n/drawfn` MUST fail with `SURFACE_MISMATCH`.

## TV-SURFACE-003

- Description: Package-local build, lint, and test scripts exist for every drawfn package.
- Input:

```json
{
  "packages": [
    "drawfn",
    "@drawfn/react",
    "@drawfn/svelte"
  ],
  "requiredScripts": ["build", "lint", "test"]
}
```

- Expected output:

```json
{
  "ok": true,
  "missingScripts": []
}
```

- Negative variant(s):
  - Missing `test` in either adapter package MUST fail with `SURFACE_MISMATCH`.

## TV-SURFACE-004

- Description: Svelte component subpath exports resolve to shipped files and compile.
- Input:

```json
{
  "package": "@drawfn/svelte",
  "subpaths": ["./Canvas.svelte", "./DrawfnCanvas.svelte"]
}
```

- Expected output:

```json
{
  "ok": true,
  "compiled": ["./Canvas.svelte", "./DrawfnCanvas.svelte"]
}
```

- Negative variant(s):
  - Any unresolved or uncompiled subpath MUST fail with `SURFACE_MISMATCH`.

## TV-SCENE-001

- Description: Tolerant scene loading accepts a valid version-1 scene and normalizes it.
- Input:

```json
{
  "sceneData": {
    "version": 1,
    "id": "scene_ok",
    "camera": { "x": 0, "y": 0, "zoom": 9 },
    "background": { "color": "#ffffff" },
    "elements": []
  }
}
```

- Expected output:

```json
{
  "ok": true,
  "data": {
    "version": 1,
    "id": "scene_ok",
    "camera": { "x": 0, "y": 0, "zoom": 5 },
    "background": { "color": "#ffffff" },
    "elements": []
  }
}
```

- Negative variant(s):
  - None in this vector; see `TV-SCENE-002`.

## TV-SCENE-002

- Description: Tolerant scene loading rejects unsupported versions, malformed shapes, and cap violations without mutating active scene state.
- Input:

```json
{
  "sceneData": {
    "version": 2,
    "id": "scene_bad",
    "elements": []
  }
}
```

- Expected output:

```json
{
  "ok": false,
  "error": {
    "code": "UNSUPPORTED_SCENE_VERSION",
    "message": "Scene version 2 is not supported.",
    "recoverable": true
  }
}
```

- Negative variant(s):
  - `elements` length above `2000` MUST fail with `SCENE_LIMIT_EXCEEDED`.
  - malformed `camera.zoom: "abc"` MUST fail with `INVALID_SCENE`.

## TV-SCENE-003

- Description: Newly created freedraw strokes use element-local points.
- Input:

```json
{
  "gesture": [
    { "type": "pointerdown", "canvas": { "x": 100, "y": 120 }, "pressure": 0.3 },
    { "type": "pointermove", "canvas": { "x": 110, "y": 125 }, "pressure": 0.5 },
    { "type": "pointerup", "canvas": { "x": 110, "y": 125 }, "pressure": 0.5 }
  ]
}
```

- Expected output:

```json
{
  "element": {
    "type": "freedraw",
    "x": 100,
    "y": 120,
    "points": [
      [0, 0, 0.3],
      [10, 5, 0.5]
    ]
  }
}
```

- Negative variant(s):
  - None in this vector; see `TV-SCENE-004`.

## TV-SCENE-004

- Description: Irreparable mixed-basis freedraw points are rejected.
- Input:

```json
{
  "sceneData": {
    "version": 1,
    "id": "scene_mixed",
    "camera": { "x": 0, "y": 0, "zoom": 1 },
    "background": { "color": "#ffffff" },
    "elements": [
      {
        "id": "fd1",
        "type": "freedraw",
        "x": 100,
        "y": 120,
        "w": 20,
        "h": 10,
        "rotation": 0,
        "stroke": "#000000",
        "fill": "transparent",
        "strokeWidth": 2,
        "opacity": 1,
        "points": [[100, 120], [10, 5], [140, 160]]
      }
    ]
  }
}
```

- Expected output:

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_SCENE",
    "message": "Freedraw points use an unsupported coordinate basis.",
    "recoverable": true
  }
}
```

- Negative variant(s):
  - A repairable legacy pattern with first point `[100,120]` and all remaining points local MUST normalize instead of failing.

## TV-HISTORY-001

- Description: A drag gesture creates exactly one undo snapshot.
- Input:

```json
{
  "initialScene": {
    "version": 1,
    "id": "scene_hist",
    "camera": { "x": 0, "y": 0, "zoom": 1 },
    "background": { "color": "#ffffff" },
    "elements": [
      {
        "id": "rect1",
        "type": "rectangle",
        "x": 10,
        "y": 20,
        "w": 100,
        "h": 50,
        "rotation": 0,
        "stroke": "#000000",
        "fill": "transparent",
        "strokeWidth": 2,
        "opacity": 1
      }
    ]
  },
  "gesture": "select-drag rect1 by +20,+10"
}
```

- Expected output:

```json
{
  "historyDepthDelta": 1,
  "undoRestores": { "x": 10, "y": 20 }
}
```

- Negative variant(s):
  - None in this vector; see `TV-HISTORY-002`.

## TV-HISTORY-002

- Description: Per-move history spam is forbidden.
- Input:

```json
{
  "gesture": "select-drag rect1 through 10 pointermove events"
}
```

- Expected output:

```json
{
  "historyDepthDelta": 1
}
```

- Negative variant(s):
  - `historyDepthDelta > 1` MUST fail with:

```json
{
  "ok": false,
  "error": {
    "code": "HISTORY_GRANULARITY_FAILURE",
    "message": "Gesture created multiple undo snapshots."
  }
}
```

## TV-EVENTS-001

- Description: Content mutations emit element, history, and scene events in the required order.
- Input:

```json
{
  "operation": "add rectangle"
}
```

- Expected output:

```json
{
  "events": [
    "elementAdded",
    "historyChanged",
    "sceneChanged"
  ]
}
```

- Negative variant(s):
  - None in this vector; see `TV-EVENTS-002`.

## TV-EVENTS-002

- Description: Pointer selection changes emit `selectionChanged` and do not rely on direct set mutation.
- Input:

```json
{
  "gesture": "click selectable rectangle in select mode"
}
```

- Expected output:

```json
{
  "selectionChanged": ["rect1"],
  "sceneChanged": null
}
```

- Negative variant(s):
  - No `selectionChanged` emission MUST fail with `EVENT_ORDER_FAILURE`.

## TV-INPUT-001

- Description: Marquee selection uses bounds intersection rather than center-point-only heuristics.
- Input:

```json
{
  "elements": [
    { "id": "a", "x": 0, "y": 0, "w": 100, "h": 100 },
    { "id": "b", "x": 200, "y": 0, "w": 100, "h": 100 }
  ],
  "marquee": { "x": 90, "y": -10, "w": 30, "h": 30 }
}
```

- Expected output:

```json
{
  "selectedIds": ["a"]
}
```

- Negative variant(s):
  - Center-point-only logic selecting nothing MUST fail with `INVALID_SELECTION_GEOMETRY`.

## TV-INPUT-002

- Description: Pointer release outside the canvas still completes the active drag.
- Input:

```json
{
  "gesture": [
    "pointerdown on rect1",
    "pointermove outside canvas",
    "window pointerup outside canvas"
  ]
}
```

- Expected output:

```json
{
  "gestureCommitted": true,
  "dragStateCleared": true
}
```

- Negative variant(s):
  - Stuck drag state after external pointerup MUST fail with `INPUT_COMPLETION_FAILURE`.

## TV-INPUT-003

- Description: Wheel zoom keeps the pre-zoom canvas point under the cursor stable.
- Input:

```json
{
  "cameraBefore": { "x": 50, "y": 20, "zoom": 2 },
  "cursorScreenPoint": { "x": 100, "y": 120 },
  "wheelDeltaY": -100
}
```

- Expected output:

```json
{
  "canvasPointBefore": { "x": 25, "y": 50 },
  "canvasPointAfter": { "x": 25, "y": 50 }
}
```

- Negative variant(s):
  - Any drift above tolerance MUST fail with `ZOOM_ANCHOR_FAILURE`.

## TV-INPUT-004

- Description: Delete/Backspace is ignored while a text overlay is active.
- Input:

```json
{
  "activeTarget": "drawfn text overlay textarea",
  "selectedIds": ["rect1"],
  "key": "Backspace"
}
```

- Expected output:

```json
{
  "sceneElementsRemoved": [],
  "textareaReceivesKey": true
}
```

- Negative variant(s):
  - Removing `rect1` while editing text MUST fail with `UNSAFE_SHORTCUT_CONTEXT`.

## TV-TEXT-001

- Description: Re-editing an existing text element commits through the standard update pipeline.
- Input:

```json
{
  "initialText": "hello",
  "editedText": "hello world"
}
```

- Expected output:

```json
{
  "events": ["elementUpdated", "historyChanged", "sceneChanged"],
  "finalText": "hello world",
  "historyDepthDelta": 1
}
```

- Negative variant(s):
  - None in this vector; see `TV-TEXT-002`.

## TV-TEXT-002

- Description: Empty provisional text is removed and editing cleanup occurs on destroy.
- Input:

```json
{
  "gesture": "create text then commit empty string"
}
```

- Expected output:

```json
{
  "elementExists": false,
  "overlayRemoved": true
}
```

- Negative variant(s):
  - Overlay listener leak after `destroy()` MUST fail with `EDIT_CONTEXT_CONFLICT`.

## TV-RENDER-001

- Description: Locked elements still render but are not selectable.
- Input:

```json
{
  "element": {
    "id": "rect_locked",
    "type": "rectangle",
    "locked": true
  }
}
```

- Expected output:

```json
{
  "rendered": true,
  "selectable": false
}
```

- Negative variant(s):
  - Hidden locked elements MUST fail with `RENDER_INVARIANT_FAILURE`.

## TV-RENDER-002

- Description: Rotated selection visuals use oriented bounds and zoom-normalized handles.
- Input:

```json
{
  "element": {
    "rotation": 0.7853981634,
    "x": 100,
    "y": 100,
    "w": 120,
    "h": 60
  },
  "camera": { "x": 0, "y": 0, "zoom": 2 }
}
```

- Expected output:

```json
{
  "selectionUsesOrientedBounds": true,
  "handleScreenSizePx": "constant-within-tolerance"
}
```

- Negative variant(s):
  - Axis-aligned selection box for rotated elements MUST fail with `RENDER_INVARIANT_FAILURE`.

## TV-EXPORT-001

- Description: Async image load completion repaints and exportPNG uses the host image loader.
- Input:

```json
{
  "imageElement": {
    "id": "img1",
    "type": "image",
    "src": "secure://image"
  },
  "getImageBitmap": "mock host loader"
}
```

- Expected output:

```json
{
  "runtimeLoaderCalls": 1,
  "exportLoaderCalls": 1,
  "rerenderAfterLoad": true
}
```

- Negative variant(s):
  - Missing export loader usage MUST fail with `EXPORT_IMAGE_LOAD_FAILED`.

## TV-EXPORT-002

- Description: Export with `selectedOnly: true` and no selection fails deterministically.
- Input:

```json
{
  "selection": [],
  "exportOptions": {
    "selectedOnly": true,
    "fitContent": true
  }
}
```

- Expected output:

```json
{
  "ok": false,
  "error": {
    "code": "EXPORT_EMPTY_SELECTION",
    "message": "Cannot export an empty selection.",
    "recoverable": true
  }
}
```

- Negative variant(s):
  - Returning a blank success image here MUST fail with `EXPORT_EMPTY_SELECTION`.

## TV-REACT-001

- Description: React controlled mode does not reload deep-equal echoed scenes.
- Input:

```json
{
  "wrapper": "DrawfnCanvas",
  "initialScene": "sceneA",
  "parentEchoesOnSceneChange": true
}
```

- Expected output:

```json
{
  "loadCallCount": 1,
  "historyPreservedAfterEcho": true
}
```

- Negative variant(s):
  - Additional `load()` on deep-equal echo MUST fail with `CONTROLLED_MODE_LOOP`.

## TV-REACT-002

- Description: React wrapper `onSceneChange` fires for camera and undo/redo changes through `sceneChanged`.
- Input:

```json
{
  "operations": ["setCamera", "undo", "redo"]
}
```

- Expected output:

```json
{
  "callbacks": [
    { "reason": "camera" },
    { "reason": "undo" },
    { "reason": "redo" }
  ]
}
```

- Negative variant(s):
  - Missing callbacks for any listed reason MUST fail with `WRAPPER_SYNC_FAILURE`.

## TV-SVELTE-001

- Description: Svelte `Canvas.svelte` and `DrawfnCanvas.svelte` compile with the shipped API surface.
- Input:

```json
{
  "files": [
    "drawfn/drawfn-svelte/src/Canvas.svelte",
    "drawfn/drawfn-svelte/src/DrawfnCanvas.svelte"
  ]
}
```

- Expected output:

```json
{
  "ok": true,
  "compileErrors": []
}
```

- Negative variant(s):
  - Invalid child DOM binding or missing exported prop MUST fail with `SVELTE_COMPILE_FAILURE`.

## TV-SVELTE-002

- Description: Svelte action/component/store stay in sync through `sceneChanged`, `selectionChanged`, and `historyChanged`.
- Input:

```json
{
  "operations": ["add rectangle", "setCamera", "undo", "select rectangle"]
}
```

- Expected output:

```json
{
  "store": {
    "elementCount": 1,
    "camera": "updated",
    "canUndo": true,
    "selectedIds": ["rect1"]
  }
}
```

- Negative variant(s):
  - Stale `elementCount`, `camera`, or `selectedIds` after these operations MUST fail with `WRAPPER_SYNC_FAILURE`.

## TV-OBS-001

- Description: Recoverable loadScene failure returns structured error and emits `error` without console dependence.
- Input:

```json
{
  "sceneData": null
}
```

- Expected output:

```json
{
  "result": {
    "ok": false,
    "error": {
      "code": "INVALID_SCENE",
      "recoverable": true
    }
  },
  "errorEventEmitted": true
}
```

- Negative variant(s):
  - `console.error` as the only failure path MUST fail with `OBSERVABILITY_FAILURE`.

## TV-OBS-002

- Description: Export image failure emits structured error.
- Input:

```json
{
  "imageLoader": "rejects",
  "export": "exportPNG"
}
```

- Expected output:

```json
{
  "promiseRejected": true,
  "error": {
    "code": "EXPORT_IMAGE_LOAD_FAILED",
    "recoverable": true
  },
  "errorEventEmitted": true
}
```

- Negative variant(s):
  - Silent placeholder-only export success MUST fail with `OBSERVABILITY_FAILURE`.

## TV-QA-001

- Description: Repo-root verification gate passes after the bundle is implemented.
- Input:

```json
{
  "commands": [
    "npm -w drawfn run lint",
    "npm -w drawfn run test -- --run",
    "npm -w drawfn run build",
    "npm -w @drawfn/react run lint",
    "npm -w @drawfn/react run test -- --run",
    "npm -w @drawfn/react run build",
    "npm -w @drawfn/svelte run lint",
    "npm -w @drawfn/svelte run test -- --run",
    "npm -w @drawfn/svelte run build"
  ]
}
```

- Expected output:

```json
{
  "exitCodes": [0, 0, 0, 0, 0, 0, 0, 0, 0]
}
```

- Negative variant(s):
  - Missing script or non-zero exit code MUST fail with `RELEASE_GATE_FAILURE`.

## TV-QA-002

- Description: Docs/examples align with the canonical package surface after the fix.
- Input:

```json
{
  "files": [
    "drawfn/core/README.md",
    "drawfn/drawfn-react/README.md",
    "drawfn/drawfn-svelte/README.md",
    "drawfn/core/example.html"
  ]
}
```

- Expected output:

```json
{
  "ok": true,
  "legacyPackageMentions": [],
  "undocumentedPublicOptions": []
}
```

- Negative variant(s):
  - README/example references to removed package names or undocumented export options MUST fail with `RELEASE_GATE_FAILURE`.


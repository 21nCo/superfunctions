# Metadata

- timestamp: 2026-03-27T02:48:03Z
- agent_name: spec
- model: unknown
- launcher: Codex Desktop
- workspace/project path: repo root
- os: Darwin arm64
- shell: zsh
- git: branch `HEAD (detached)`; commit `50929162a8547f6f55db27bdc51c47289c0bc2af`; dirty status `modified: .conduct/logs.csv; untracked: drawfn/.conduct/`
- spec_folder: `2026-03-27-audit-fix-ph067aw9-spec`
- spec_folder path: `drawfn/.conduct/specs/2026-03-27-audit-fix-ph067aw9-spec`
- spec_type: `audit-fix`
- spec_id: `ph067aw9`
- input paths:
  - external user intent (sanitized): create a detailed fix spec for drawfn in `drawfn/.conduct`; only fix drawfn; do not touch Nucleus migration or anything related to Nucleus
  - `drawfn/.conduct/audits/2026-03-26-srwfzazr-full-audit.md`
  - `drawfn/core/SPEC.md`
  - `drawfn/core/README.md`
  - `drawfn/drawfn-react/README.md`
  - `drawfn/drawfn-svelte/README.md`
  - `drawfn/core/package.json`
  - `drawfn/drawfn-react/package.json`
  - `drawfn/drawfn-svelte/package.json`
  - thread-provided repository guidance (sanitized): monorepo naming and artifact placement rules from `AGENTS.md`
- audit reference:
  - path: `drawfn/.conduct/audits/2026-03-26-srwfzazr-full-audit.md`
  - related audited spec_id/spec_folder: `none`

# Overview

## Project name

`drawfn`

## One-sentence goal

`drawfn` MUST become a production-ready single-user drawing library and wrapper set by fixing its packaging, scene semantics, interaction determinism, export correctness, adapter behavior, and release verification, without changing Nucleus- or node-specific behavior.

## Target users

- Frontend engineers embedding `drawfn` into browser-based products.
- Maintainers of the `drawfn` core, React adapter, and Svelte adapter.

## Target environments

- Runtime: modern browsers with Canvas 2D and Pointer Events.
- Build/test: Node.js `>=18.18.0`.
- Framework targets: React `18/19`, Svelte `4/5`, vanilla browser usage.
- Connectivity: offline-capable for drawing and scene persistence; online only when host-supplied image loaders require it.

## Languages/packages required

- TypeScript for core and React adapter.
- Svelte for the Svelte adapter.
- Existing runtime dependency: `perfect-freehand`.

## Existing systems it must integrate with

- Browser host applications embedding a `<canvas>`.
- Host-provided image loaders via `getImageBitmap`.
- Existing serialized `drawfn` scene data already produced by current releases.

## Data model summary

- `Scene`
  - `version`
  - `id`
  - `elements[]`
  - `camera`
  - `background`
- `Element`
  - `freedraw`
  - `rectangle`
  - `ellipse`
  - `arrow`
  - `text`
  - `image`
  - `node`
- `selection`
  - runtime-only set of element ids; not persisted in `Scene`
- `history`
  - runtime-only undo/redo snapshots; not persisted in `Scene`

## Security model

- No authn/authz is performed inside `drawfn`.
- `drawfn` MUST NOT introduce remote code execution, dynamic evaluation, or host-global side effects beyond explicit event listeners on the provided canvas and window.
- Image fetching MUST remain delegated to the host when a host loader is provided.
- Scene content MAY contain arbitrary user-authored text and URLs; `drawfn` MUST treat them as data only.

## Performance constraints

Unless the host provides stricter requirements, this spec assumes:

- common sessions of up to `2,000` elements MUST remain interactive on current desktop browsers
- a single `freedraw` element MUST support up to `16,384` points
- history depth MUST be capped at `50` committed snapshots
- export output MUST reject dimensions above `8192 x 8192` pixels after padding and scale are applied

Behavior outside these limits is Undefined unless explicitly specified below.

## Assumptions

- Canonical package identifiers MUST follow current monorepo conventions:
  - core package: `drawfn`
  - React adapter: `@drawfn/react`
  - Svelte adapter: `@drawfn/svelte`
- Canonical license metadata MUST remain `MIT`, because the package manifests already publish that value; docs/spec text MUST be aligned to the manifests instead of changing legal metadata implicitly.
- Existing node-related runtime behavior MUST remain backward compatible and out of scope for functional change in this spec.

# Glossary

- `committed mutation`: a state change that MUST produce at most one new undo snapshot and a stable event emission.
- `gesture`: a pointer- or keyboard-driven user interaction spanning start, transient updates, and completion.
- `legacy scene`: persisted scene data created before this audit-fix implementation.
- `normalized scene`: a validated `Scene` object using canonical field defaults, canonical point encoding, and numeric `version: 1`.
- `scene equality`: deep equality across `version`, `id`, `elements`, `camera`, and `background`.
- `selection state`: runtime-only selected element ids; not part of serialized scene JSON.
- `tool preview`: transient, not-yet-committed in-memory updates during a gesture.
- `wrapper controlled mode`: React/Svelte mode where a parent passes `scene` and receives `onSceneChange`.
- `wrapper uncontrolled mode`: React/Svelte mode where the wrapper owns the internal `Drawfn` instance state.
- `node-related API`: any type, field, option, callback, or documentation specifically describing `node`, `NodeElement`, Nucleus, or node preview/click behavior.

# Goals / Non-goals

## Goals

1. Packaging, docs, and source imports MUST agree on the same public package identifiers.
2. Scene loading, mutation, and serialization MUST be deterministic and validation-backed.
3. Gesture handling MUST produce action-level history, correct selection events, and reliable off-canvas completion behavior.
4. Text editing MUST be fully commit-safe for create and re-edit flows.
5. Rendering MUST remain visually correct for locked elements, rotated selections, async images, and exports.
6. React and Svelte wrappers MUST compile, behave correctly in controlled/uncontrolled mode, and expose stable package surfaces.
7. Release readiness MUST be backed by repeatable repo-root verification commands.

## Non-goals

1. No collaboration, multiplayer, CRDT, OT, or presence features.
2. No new drawing tools, brushes, rough/sketch mode, grouping, or clipboard features.
3. No node/Nucleus behavior expansion, migration, or API redesign.
4. No changes to host-side storage systems.

# Public API

## Canonical package identifiers

- Core package MUST be published as `drawfn`.
- React adapter MUST be published as `@drawfn/react`.
- Svelte adapter MUST be published as `@drawfn/svelte`.
- Documentation MUST NOT reference `@21n/drawfn*` after this fix bundle.

## Core exported types

```ts
export type ElementType =
  | "freedraw"
  | "rectangle"
  | "ellipse"
  | "arrow"
  | "text"
  | "image"
  | "node";

export type Point = { x: number; y: number };

export type Camera = {
  x: number;
  y: number;
  zoom: number;
};

export type Background = {
  color: string;
  grid?: {
    size: number;
    color: string;
    alpha: number;
  };
};

export type BaseElement = {
  id: string;
  type: ElementType;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  stroke: string;
  fill: string | "transparent";
  strokeWidth: number;
  opacity: number;
  locked?: boolean;
  meta?: Record<string, unknown>;
};

export type FreeDrawElement = BaseElement & {
  type: "freedraw";
  points: [number, number, number?][];
  style?: {
    size?: number;
    thinning?: number;
    smoothing?: number;
    streamline?: number;
    taperStart?: number;
    taperEnd?: number;
  };
};

export type RectangleElement = BaseElement & { type: "rectangle" };
export type EllipseElement = BaseElement & { type: "ellipse" };
export type TextElement = BaseElement & {
  type: "text";
  text: string;
  fontFamily: string;
  fontSize: number;
  align: "left" | "center" | "right";
};
export type ImageElement = BaseElement & {
  type: "image";
  src: string;
  naturalW?: number;
  naturalH?: number;
};
export type ArrowElement = BaseElement & {
  type: "arrow";
  points: [number, number][];
  head: "triangle" | "none";
};
export type NodeElement = BaseElement & {
  type: "node";
  nodeId: string;
  nodeType?: string;
  variant?: "bookmark" | "embed" | "card";
  preview?: {
    title?: string;
    icon?: string;
    excerpt?: string;
  };
};

export type Element =
  | FreeDrawElement
  | RectangleElement
  | EllipseElement
  | TextElement
  | ImageElement
  | ArrowElement
  | NodeElement;

export type Scene = {
  version: 1;
  id: string;
  elements: Element[];
  camera: Camera;
  background: Background;
};

export type ToolName =
  | "select"
  | "pan"
  | "pen"
  | "rectangle"
  | "ellipse"
  | "arrow"
  | "text"
  | "image"
  | "node";
```

## Canonical error and result envelopes

```ts
export type DrawfnErrorCode =
  | "INVALID_SCENE"
  | "UNSUPPORTED_SCENE_VERSION"
  | "SCENE_LIMIT_EXCEEDED"
  | "ELEMENT_NOT_FOUND"
  | "EDIT_CONTEXT_CONFLICT"
  | "EXPORT_EMPTY_SELECTION"
  | "EXPORT_IMAGE_LOAD_FAILED"
  | "EXPORT_RENDER_FAILED";

export type DrawfnError = {
  code: DrawfnErrorCode;
  message: string;
  details?: Record<string, unknown>;
  recoverable: boolean;
};

export type DrawfnResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: DrawfnError };
```

## Core events

```ts
export type SceneChangeReason =
  | "load"
  | "clear"
  | "add"
  | "update"
  | "remove"
  | "reorder"
  | "camera"
  | "undo"
  | "redo"
  | "text-commit";

export type SceneChangedEvent = {
  reason: SceneChangeReason;
  scene: Scene;
  changedElementIds: string[];
  canUndo: boolean;
  canRedo: boolean;
};

export type HistoryChangedEvent = {
  canUndo: boolean;
  canRedo: boolean;
  depth: number;
};

export type DrawfnEventMap = {
  pointerDown: [PointerEvent];
  pointerMove: [PointerEvent];
  pointerUp: [PointerEvent];
  elementAdded: [Element];
  elementUpdated: [Element];
  elementRemoved: [string];
  selectionChanged: [string[]];
  historyChanged: [HistoryChangedEvent];
  cameraChanged: [Camera];
  sceneChanged: [SceneChangedEvent];
  error: [DrawfnError];
};
```

## Core class

```ts
export type DrawfnOptions = {
  canvas: HTMLCanvasElement;
  overlayRoot?: HTMLElement;
  getImageBitmap?: (src: string) => Promise<ImageBitmap>;
};

export type ExportPNGOptions = {
  padding?: number;
  scale?: number;
  transparent?: boolean;
  selectedOnly?: boolean;
  fitContent?: boolean;
};

export type ExportSVGOptions = {
  padding?: number;
  scale?: number;
  selectedOnly?: boolean;
  fitContent?: boolean;
};

export class Drawfn {
  constructor(options: DrawfnOptions);

  load(scene: Scene): void;
  loadScene(sceneData: unknown): DrawfnResult<Scene>;
  getScene(): Scene;
  clear(): void;

  add(element: Element): string;
  update(id: string, patch: Partial<Element>): void;
  remove(id: string): void;
  bringToFront(id: string): void;
  sendToBack(id: string): void;

  setTool(tool: ToolName, opts?: unknown): void;
  getTool(): ToolName;

  setSelection(ids: string[]): void;
  getSelectedIds(): string[];

  setCamera(camera: Partial<Camera>): void;
  getCamera(): Camera;
  screenToCanvas(point: Point): Point;

  undo(): void;
  redo(): void;

  exportPNG(options?: ExportPNGOptions): Promise<Blob>;
  exportSVG(options?: ExportSVGOptions): Promise<string>;

  on<E extends keyof DrawfnEventMap>(
    event: E,
    handler: (...args: DrawfnEventMap[E]) => void
  ): () => void;

  destroy(): void;
}
```

## React adapter API

```ts
export type UseDrawfnOptions = Omit<DrawfnOptions, "canvas"> & {
  scene?: Scene;
  onSceneChange?: (scene: Scene, meta?: SceneChangedEvent) => void;
};

export type UseDrawfnResult = {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  drawfn: Drawfn | null;
  isReady: boolean;
  setTool(tool: ToolName, opts?: unknown): void;
  getScene(): Scene | undefined;
  undo(): void;
  redo(): void;
  clear(): void;
  exportPNG(options?: ExportPNGOptions): Promise<Blob | undefined>;
  exportSVG(options?: ExportSVGOptions): Promise<string | undefined>;
  on<E extends keyof DrawfnEventMap>(
    event: E,
    handler: (...args: DrawfnEventMap[E]) => void
  ): (() => void) | undefined;
};

export function useDrawfn(options?: UseDrawfnOptions): UseDrawfnResult;
```

`DrawfnCanvas` MUST keep the same prop names already documented:

```ts
type DrawfnCanvasProps = React.CanvasHTMLAttributes<HTMLCanvasElement> &
  UseDrawfnOptions & {
    onReady?: (value: UseDrawfnResult) => void;
  };
```

## Svelte adapter API

```ts
export type DrawfnActionOptions = Omit<DrawfnOptions, "canvas"> & {
  scene?: Scene;
  onReady?: (drawfn: Drawfn) => void;
  onSceneChange?: (scene: Scene, meta?: SceneChangedEvent) => void;
};

export function drawfn(
  canvas: HTMLCanvasElement,
  options?: DrawfnActionOptions
): {
  update(next: DrawfnActionOptions): void;
  destroy(): void;
};
```

`DrawfnCanvas.svelte` MUST keep the currently documented props and methods:

- props
  - `width`
  - `height`
  - `scene`
  - `overlayRoot`
  - `getImageBitmap`
  - `onReady`
  - `onSceneChange`
- exported methods
  - `getDrawfn()`
  - `setTool()`
  - `undo()`
  - `redo()`
  - `clear()`
  - `exportPNG()`
  - `exportSVG()`

`Canvas.svelte` MUST compile as a thin presentational component. Any child DOM-binding mechanism used by `DrawfnCanvas.svelte` is implementation-defined unless explicitly exported in package docs.

# Data formats / protocol

## Normalized scene format

1. `Scene.version` MUST normalize to numeric literal `1`.
2. `Scene.id` MUST be a non-empty string.
3. `Scene.elements` MUST preserve z-order.
4. `Scene.camera.zoom` MUST clamp to `[0.1, 5]`.
5. Unknown top-level scene fields MUST be dropped during tolerant load.
6. Unknown element fields outside `meta` MUST be dropped during tolerant load.
7. `meta` MUST be preserved verbatim if present.

## Canonical freedraw format

1. `FreeDrawElement.points` MUST be element-local coordinates relative to `element.x` and `element.y`.
2. The first point in a newly created freedraw stroke MUST be `[0, 0, pressure?]`.
3. Width and height MUST reflect the bounding box of the local points after normalization.
4. Legacy scenes MAY be normalized if they match the known pre-fix corruption pattern:
   - first point equals the scene-space element origin
   - remaining points are already local to the element
5. Mixed or irreparable freedraw coordinate bases MUST return `INVALID_SCENE`.

## Export option semantics

- `padding`
  - default `20`
  - MUST add empty space around fit-to-content exports
- `scale`
  - PNG default `2`
  - SVG default `1`
- `transparent`
  - PNG-only
  - default `false`
- `selectedOnly`
  - default `false`
  - MUST restrict export to selected elements only
- `fitContent`
  - default `false`
  - MUST fit export bounds to the exported elements rather than the current viewport

# Semantics

## Scene loading

1. `load(scene)` MUST accept already-valid `Scene` objects, deep-clone them, normalize clamped numeric fields, clear selection, preserve current event listeners, and emit:
   - `selectionChanged([])` if selection was non-empty
   - `historyChanged({ canUndo: false, canRedo: false, depth: 0 })`
   - `sceneChanged({ reason: "load", ... })`
2. `loadScene(sceneData)` MUST perform tolerant runtime validation and return a `DrawfnResult<Scene>`.
3. On `loadScene(...).ok === true`, the normalized scene MUST become the active scene and MUST emit the same side effects as `load(scene)`.
4. On `loadScene(...).ok === false`, active scene state MUST remain unchanged and an `error` event MUST be emitted.

## Mutation and history model

1. Direct public API mutations (`add`, `update`, `remove`, `bringToFront`, `sendToBack`, `clear`) MUST be committed mutations.
2. A gesture-driven tool mutation MUST create at most one new undo snapshot per committed gesture.
3. Transient pointer-move previews MUST NOT create additional undo snapshots.
4. Undo/redo MUST restore scene, selection-empty state, and history bookkeeping deterministically.
5. Camera changes MUST update the scene and emit `sceneChanged`, but camera-only changes MUST NOT create undo snapshots.

## Event ordering

For a committed content mutation without a selection change:

1. element-specific event (`elementAdded`, `elementUpdated`, or `elementRemoved`)
2. `historyChanged`
3. `sceneChanged`
4. render scheduling

For a committed content mutation that also changes selection:

1. element-specific event (`elementAdded`, `elementUpdated`, or `elementRemoved`)
2. `selectionChanged`
3. `historyChanged`
4. `sceneChanged`
5. render scheduling

For selection-only changes:

1. `selectionChanged`
2. render scheduling

For camera-only changes:

1. `cameraChanged`
2. `sceneChanged`
3. render scheduling

## Selection semantics

1. Any selection change, whether driven by pointer hit-testing, marquee, keyboard delete cleanup, `undo`, `redo`, or `setSelection`, MUST emit `selectionChanged`.
2. Clicking empty canvas in select mode MUST clear selection unless the gesture is additive.
3. Marquee selection MUST select elements by intersection with normalized bounds, not center-point-only heuristics.
4. Locked elements MUST remain renderable but MUST NOT become selectable or transformable.

## Input semantics

1. Canvas gestures MUST complete correctly even if the pointer leaves the canvas before `pointerup`.
2. Space-to-pan MUST activate only while the canvas interaction context is active and MUST revert to the prior tool on key release.
3. Delete/Backspace shortcuts MUST NOT delete scene elements while a textarea overlay or other text-entry target is active.
4. Wheel zoom MUST keep the pre-zoom canvas point under the cursor invariant within floating-point tolerance.

## Text editing semantics

1. Creating a text element MUST insert a provisional text element and open the overlay immediately.
2. Re-editing an existing text element MUST use the same commit pipeline as new text.
3. Empty committed text MUST remove a newly created text element and MUST leave existing non-empty text unchanged unless the user explicitly clears and commits it.
4. `destroy()` MUST clean up any active text overlay and any event listeners created for that overlay.

## Rendering and export semantics

1. Locked elements MUST be drawn using normal rendering rules.
2. Culling MUST use rotation-aware bounds for rotated elements.
3. Selection visuals MUST use rotation-aware bounds and zoom-normalized handle sizes.
4. Async image load completion MUST trigger a redraw if the image is still present in the active scene.
5. Exports MUST use the same image-loading strategy as on-screen rendering.
6. `selectedOnly === true` with no selected elements MUST fail with `EXPORT_EMPTY_SELECTION`.

## Wrapper semantics

1. React and Svelte wrappers MUST subscribe to `sceneChanged` instead of inferring scene changes from element-only events.
2. Controlled wrappers MUST compare incoming `scene` props against the current internal scene and MUST NOT call `load()` for deep-equal echoes.
3. Uncontrolled wrappers MUST not reload internal state after initial mount unless explicitly instructed by a changed controlled `scene` prop.
4. Wrapper helper stores/hooks MUST unsubscribe cleanly on destroy/unmount.

# Invariants

1. Scene serialization MUST be deterministic:
   - element order preserved
   - normalized defaults applied consistently
   - numeric `version: 1`
2. A single gesture MUST produce deterministic history depth changes:
   - one committed gesture => `+1` undo snapshot maximum
   - cancelled gesture => `+0`
3. `getScene()` MUST return a deep clone safe for external mutation without affecting internal state.
4. All recoverable runtime failures covered by this spec MUST surface through:
   - `DrawfnResult<T>` for tolerant scene loading
   - `error` event and/or rejected export promises for export/runtime failures
5. Node-related public types and runtime behavior MUST remain backward compatible and unchanged by this fix bundle, except for transitive improvements inherited from shared event/render infrastructure.

# Security

1. `drawfn` MUST NOT evaluate scene data or text content as code.
2. `drawfn` MUST NOT log full scene payloads, image URLs, or user text to `console.*` for recoverable errors.
3. Host-provided image loaders MUST remain the only supported path for authenticated or custom image fetching.
4. Validation MUST reject malformed scene shapes, unsupported versions, and scenes exceeding explicit caps.

# Limits/caps

1. `camera.zoom` clamp: `0.1` to `5`
2. history depth: `50`
3. max elements per scene: `2,000`
4. max points per freedraw element: `16,384`
5. max export dimension after padding/scale: `8192` per side
6. max image cache entries: `64`

Behavior above these caps MUST fail deterministically with `SCENE_LIMIT_EXCEEDED` or `EXPORT_RENDER_FAILED` as appropriate.

# Observability

1. The runtime MUST emit `sceneChanged`, `selectionChanged`, `historyChanged`, `cameraChanged`, and `error` events as defined above.
2. The runtime MUST NOT use `console.log`, `console.warn`, or `console.error` for recoverable library behavior once this fix bundle is complete.
3. Verification commands in this spec MUST be runnable from `repo root`.

# Compatibility / versioning strategy

1. This fix bundle MUST preserve existing public method names and wrapper prop names unless an additive compatibility shim is provided.
2. `drawfn`, `@drawfn/react`, and `@drawfn/svelte` are the canonical package identifiers after this bundle.
3. Documentation-only identifiers `@21n/drawfn*` are unsupported and MUST be removed rather than preserved with aliases.
4. `NodeElement` fields and `node` tool option shapes MUST remain unchanged.
5. The persisted scene version remains `1`.
6. Legacy scene normalization is limited to the cases defined in this spec. Any other migration behavior is Undefined.

# Undefined / Explicitly user-deferred only

- Nucleus migration work
- changes to node/Nucleus-specific callbacks, preview fetching, or route-opening behavior
- changes to `NodeElement` serialized shape beyond compatibility preservation

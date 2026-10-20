# drawfn

Cross-framework drawing canvas library for brainstorming and simple sketching.

## Features

- 🎨 Framework-agnostic core (works with React, Svelte, Vue, vanilla JS)
- ✏️ Multiple drawing tools: pen, shapes, text, images, and more
- 📐 Element-based retained-mode architecture
- 💾 Full scene serialization to JSON
- ⏮️ Undo/redo support
- 📤 Export to PNG and SVG
- 🔍 Pan and zoom with viewport culling
- 🎯 Selection and transformation tools

## Installation

```bash
npm install drawfn perfect-freehand
```

## Quick Start

```typescript
import { Drawfn } from 'drawfn';

const canvas = document.querySelector('canvas');
const drawfn = new Drawfn({ canvas });

// Set a tool
drawfn.setTool('pen');

// Listen to scene changes
drawfn.on('sceneChanged', ({ scene, reason }) => {
  console.log('Scene changed because of', reason, scene);
});

// Export the scene
const scene = drawfn.getScene();
console.log(scene);
```

## Tools

- **select**: Select, move, resize, and rotate elements with handles
- **pan**: Pan the canvas with mouse/trackpad
- **pen**: Freehand drawing with pressure support (perfect-freehand)
- **rectangle**: Draw rectangles (hold Shift for squares)
- **ellipse**: Draw ellipses (hold Shift for circles)
- **arrow**: Draw arrows with arrowhead
- **text**: Add text with inline editing overlay
- **image**: Add images programmatically
- **node**: Add Nucleus node bookmarks (for integrations)

## API

### Constructor

```typescript
const drawfn = new Drawfn({
  canvas: HTMLCanvasElement,
  overlayRoot?: HTMLElement,  // For text editing overlay
  getImageBitmap?: (src: string) => Promise<ImageBitmap>  // Custom image loader
});
```

### Methods

**Scene Management**
- `load(scene: Scene)`: Load a scene from JSON
- `loadScene(sceneData: unknown): DrawfnResult<Scene>`: Tolerantly validate and load a serialized scene
- `getScene(): Scene`: Get current scene as JSON
- `clear()`: Clear the canvas as one undoable content mutation (an empty clear is a no-op)
- `resetHistory()`: Discard undo/redo history without changing scene content

**Element Operations**
- `add(element: Element): string`: Add an element, returns ID
- `update(id: string, patch: Partial<Element>)`: Update an element
- `remove(id: string)`: Remove an element
- `bringToFront(id: string)`: Move element to top layer
- `sendToBack(id: string)`: Move element to bottom layer
- `getElements(): Element[]`: Get all elements
- `getElementById(id: string): Element | undefined`: Get element by ID

**Tool Management**
- `setTool(tool: ToolName, opts?)`: Set active tool
  - For `image` tool: `setTool('image', { src: 'url', naturalW: 200, naturalH: 150 })`
  - For `node` tool: `setTool('node', { nodeId: 'abc', preview: { title: 'Note' } })`
- `getTool(): ToolName`: Get current tool

**Camera & View**
- `setCamera(camera: Partial<Camera>)`: Update camera position/zoom
- `getCamera(): Camera`: Get camera state
- `screenToCanvas(point: Point): Point`: Convert screen to canvas coordinates

**History**
- `undo()`: Undo last action
- `redo()`: Redo last undone action
- `getHistoryState()`: Read `{ canUndo, canRedo, depth }` for the current instance

**Selection**
- `setSelection(ids: string[])`: Set selected element IDs
- `getSelectedIds(): string[]`: Get selected element IDs

**Export**
- `exportPNG(opts?): Promise<Blob>`: Export as PNG
  - Options: `{ padding?: number; scale?: number; transparent?: boolean; selectedOnly?: boolean; fitContent?: boolean }`
- `exportSVG(opts?): Promise<string>`: Export as SVG (includes freedraw, arrows, images)
  - Options: `{ padding?: number; scale?: number; selectedOnly?: boolean; fitContent?: boolean }`

**Events**
- `on(event, handler): () => void`: Subscribe to events, returns unsubscribe function
  - Events: `pointerDown`, `pointerMove`, `pointerUp`, `elementAdded`, `elementUpdated`, `elementRemoved`, `selectionChanged`, `historyChanged`, `cameraChanged`, `sceneChanged`, `error`

**Cleanup**
- `destroy()`: Cleanup and remove event listeners

## Examples

See `example.html` for a vanilla JS toolbar example. From the repository root, run `npm run build --workspace ./drawfn/core`, then `python3 -m http.server 8000` and open `http://localhost:8000/drawfn/core/example.html`. Its import map loads the installed workspace dependency without a bundler. Image and node insertion use the programmatic tool options documented above.

For React examples, see the `@drawfn/react` package.

## Keyboard Shortcuts

- **Delete/Backspace**: Delete selected elements
- **Cmd/Ctrl+Z**: Undo
- **Cmd/Ctrl+Shift+Z** or **Cmd/Ctrl+Y**: Redo
- **Space+Drag**: Pan (when not in pan tool mode)
- **Shift+Drag**: Constrain aspect ratio for shapes

## Mouse/Touch Interactions

- **Wheel**: Zoom at cursor position
- **Click+Drag**: Tool-specific interaction
- **Shift+Click**: Multi-select (in select tool)

## License

MIT

### Input ownership and cleanup

The canvas receives focus on pointer interaction and is keyboard-focusable by default. Delete, undo/redo, and space-to-pan apply to the focused canvas; typing in another input or editor does not change drawings. Multiple instances can coexist. Call `destroy()` when unmounting; repeated calls are safe, pending image completions cannot schedule another render, and cached image bitmaps are closed.

Custom `getImageBitmap` loaders transfer bitmap ownership to the renderer. Return a fresh bitmap per invocation (or a fresh clone of an application-cached bitmap); an export creates its own temporary renderer and closes its assets after rendering.

### Export coordinates

PNG and SVG export the current viewport by default, including its camera transform. With `fitContent: true`, exports use world-space element bounds and ignore the viewing camera. Padding is measured in world units for fitted output; `scale` changes output dimensions. PNG supports transparent backgrounds. SVG backgrounds cover the full fitted viewBox, and text/style strings are XML-escaped. Export `scale` must be finite and positive, and `padding` finite and non-negative.

Image URLs embedded in SVG remain external references. PNG waits for image loading and requires browser canvas access to those images (for example, a same-origin URL, a CORS-enabled remote URL, or a host bitmap loader).

### Node integration hooks

`onNodeClick(nodeId, element)` runs for a primary-button click on the topmost node while the select tool is active; dragging does not invoke it. `getNodePreview(nodeId)` asynchronously fills a missing preview when a node is added or a scene is loaded. Its `description` becomes the node preview's `excerpt`. Existing previews are retained; results for removed, replaced, edited, or destroyed nodes are ignored. Current request failures emit a recoverable `NODE_PREVIEW_FAILED` error. Preview updates follow the normal update/event/history pipeline.

Canvas `width`/`height` attribute changes repaint the current scene without history or scene-change events. CSS dimensions may differ from the backing bitmap: pointer coordinates, pan deltas, wheel anchors, and text overlays account for that scaling. The core does not change backing dimensions automatically.

Canceled pointer gestures restore their pre-gesture content and selection without adding undo steps. Undo/redo applies to content and preserves the current camera. Pen taps produce dots; supplied pressure and taper settings apply consistently to canvas and SVG strokes.

Packed acceptance scripts require `NPM_CLI` set to the absolute path of your trusted `npm/bin/npm-cli.js`. They invoke it through the current Node executable rather than searching `PATH`.

### Runtime bounds and image ownership

Scenes accept up to 2,000 elements and stored pen strokes up to 16,384 points. Grid spacing must be positive. PNG and SVG output dimensions, including padding and scale, must be between 1 and 8192 pixels per side; invalid dimensions reject with `EXPORT_RENDER_FAILED`. Native PNG encoding failures also emit an `error` event and reject with that code.

Each renderer admits at most 64 distinct cached or pending image sources. Repeated URLs share a request. Excess sources report `SCENE_LIMIT_EXCEEDED`; an export needing more than 64 sources fails before loading. Existing images are retained rather than repeatedly evicted. Removing sources from the rendered scene releases their cached bitmaps; in-flight loaders keep their slot until completion, and late unused bitmaps are closed. Host loaders should return assets owned by that renderer, not shared with unrelated consumers. This is an entry-count limit, not a limit on individual image bytes.

See [requirement evidence and remaining qualifications](../.conduct/requirement-readiness.md) for the complete original requirement mapping, including hosted verification, Svelte version support and performance limits.

### Clear and text event migration

`clear()` now preserves one undo step, emits removal events followed by selection/history/scene changes, and closes pending text editors. Call `clear(); resetHistory();` when the intended action is to clear content and permanently discard prior undo/redo history. `resetHistory()` alone leaves the scene intact. Both React's hook result and the Svelte component/store expose this method. Repeated empty clears do not emit scene/history events.

Committed text creation and editing now use `sceneChanged.reason === "text-commit"`; direct `add()` and `update()` calls retain their existing reasons. Update consumers that previously inferred text commits from the generic add/update reason.

### Portable SVG images

`exportSVG()` now loads image assets with the same configured `getImageBitmap` callback as PNG and embeds their pixels as PNG data URLs. Duplicate sources load and encode once per export. Exported SVGs no longer retain remote/private image URLs or depend on the consumer's authentication. Image-loading or encoding failure rejects instead of producing an external-link fallback.

SVG embedding permits up to 64 unique sources, native dimensions up to 8192 per side, and at most 67,108,864 native pixels across those sources. Bounds are checked before allocating encoding canvases. Tainted, oversized or unencodable assets reject with `EXPORT_RENDER_FAILED`; loader rejection uses `EXPORT_IMAGE_LOAD_FAILED`. The export snapshots scene/camera/background before awaiting the loader and disposes temporary image resources after completion.

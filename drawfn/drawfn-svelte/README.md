# @drawfn/svelte

Svelte adapter for the `drawfn` drawing canvas library. Requires Svelte 5.57.2 or later in the 5.x series and Node 18.18 or later.

This package is ESM-only, matching the Svelte runtime. Use `import` or dynamic `import()` from CommonJS; `require("@drawfn/svelte")` is not supported. Core `drawfn` and `@drawfn/react` continue to provide both ESM and CommonJS entrypoints.

Svelte 4 is no longer in the supported peer range: it has no patched release for the upstream SSR and DOM-clobbering advisories covered by the current Svelte 5 baseline.

## Installation

```bash
npm install @drawfn/svelte drawfn perfect-freehand svelte@^5.57.2
```

## Quick Start

### Using the DrawfnCanvas Component

```svelte
<script>
  import DrawfnCanvas from '@drawfn/svelte/DrawfnCanvas.svelte';

  let drawfnCanvas;

  function handlePen() {
    drawfnCanvas?.setTool('pen');
  }

  function handleUndo() {
    drawfnCanvas?.undo();
  }
</script>

<button on:click={handlePen}>Pen</button>
<button on:click={() => drawfnCanvas?.setTool('rectangle')}>Rectangle</button>
<button on:click={handleUndo}>Undo</button>
<button on:click={() => drawfnCanvas?.redo()}>Redo</button>

<DrawfnCanvas bind:this={drawfnCanvas} width={1200} height={800} />
```

### Using the Svelte Action

```svelte
<script>
  import { drawfn } from '@drawfn/svelte';

  let instance;
  let canvas;

  function handleReady(drawfn) {
    instance = drawfn;
  }
</script>

<button on:click={() => instance?.setTool('pen')}>Pen</button>
<button on:click={() => instance?.setTool('select')}>Select</button>
<button on:click={() => instance?.undo()}>Undo</button>

<canvas
  bind:this={canvas}
  use:drawfn={{ onReady: handleReady }}
  width={1200}
  height={800}
  style="display: block; touch-action: none;"
/>
```

### Using with Svelte Stores

```svelte
<script>
  import { drawfn, createDrawfnStore } from '@drawfn/svelte';

  const store = createDrawfnStore();
  let canvas;

  function handleReady(instance) {
    store.setInstance(instance);
  }
</script>

<button on:click={() => store.setTool('pen')} disabled={!$store.isReady}>
  Pen {$store.currentTool === 'pen' ? '✓' : ''}
</button>
<button on:click={() => store.setTool('rectangle')} disabled={!$store.isReady}>
  Rectangle {$store.currentTool === 'rectangle' ? '✓' : ''}
</button>
<button on:click={() => $store.instance?.undo()} disabled={!$store.canUndo}>
  Undo
</button>
<button on:click={() => $store.instance?.redo()} disabled={!$store.canRedo}>
  Redo
</button>

<div>Elements: {$store.elementCount}</div>
<div>Zoom: {Math.round($store.camera.zoom * 100)}%</div>

<canvas
  bind:this={canvas}
  use:drawfn={{ onReady: handleReady }}
  width={1200}
  height={800}
  style="display: block; touch-action: none;"
/>
```

### Controlled Scene

```svelte
<script>
  import DrawfnCanvas from '@drawfn/svelte/DrawfnCanvas.svelte';

  let scene = null;

  function handleSceneChange(newScene, meta) {
    scene = newScene;
    console.log('Scene updated:', meta?.reason, scene);
  }
</script>

<DrawfnCanvas
  width={1200}
  height={800}
  {scene}
  onSceneChange={handleSceneChange}
/>
```

### Export Canvas

```svelte
<script>
  import DrawfnCanvas from '@drawfn/svelte/DrawfnCanvas.svelte';

  let drawfnCanvas;

  async function handleExportPNG() {
    const blob = await drawfnCanvas?.exportPNG({ scale: 2 });
    if (!blob) return;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'drawing.png';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleExportSVG() {
    const svg = await drawfnCanvas?.exportSVG();
    if (!svg) return;

    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'drawing.svg';
    a.click();
    URL.revokeObjectURL(url);
  }
</script>

<button on:click={handleExportPNG}>Export PNG</button>
<button on:click={handleExportSVG}>Export SVG</button>

<DrawfnCanvas bind:this={drawfnCanvas} width={1200} height={800} />
```

### Complete Example with Toolbar

```svelte
<script>
  import DrawfnCanvas from '@drawfn/svelte/DrawfnCanvas.svelte';

  let drawfnCanvas;
  let currentTool = 'select';

  const tools = [
    { id: 'select', label: 'Select' },
    { id: 'pan', label: 'Pan' },
    { id: 'pen', label: 'Pen' },
    { id: 'rectangle', label: 'Rectangle' },
    { id: 'ellipse', label: 'Ellipse' },
    { id: 'arrow', label: 'Arrow' },
    { id: 'text', label: 'Text' },
  ];

  function setTool(tool) {
    drawfnCanvas?.setTool(tool);
    currentTool = tool;
  }
</script>

<div class="toolbar">
  {#each tools as tool}
    <button
      on:click={() => setTool(tool.id)}
      class:active={currentTool === tool.id}
    >
      {tool.label}
    </button>
  {/each}

  <div class="separator" />

  <button on:click={() => drawfnCanvas?.undo()}>Undo</button>
  <button on:click={() => drawfnCanvas?.redo()}>Redo</button>
  <button on:click={() => drawfnCanvas?.clear()}>Clear</button>
</div>

<DrawfnCanvas bind:this={drawfnCanvas} width={1200} height={800} />

<style>
  .toolbar {
    display: flex;
    gap: 8px;
    padding: 12px;
    background: white;
    border-bottom: 1px solid #e5e7eb;
  }

  button {
    padding: 8px 16px;
    border: 1px solid #d1d5db;
    background: white;
    border-radius: 4px;
    cursor: pointer;
  }

  button:hover {
    background: #f9fafb;
  }

  button.active {
    background: #3b82f6;
    color: white;
    border-color: #3b82f6;
  }

  .separator {
    width: 1px;
    background: #e5e7eb;
  }
</style>
```

## API

### DrawfnCanvas Component

**Props:**
- `width?: number` - Canvas width (default: 800)
- `height?: number` - Canvas height (default: 600)
- `scene?: Scene` - Initial or controlled scene
- `overlayRoot?: HTMLElement` - Root element for text editing overlay
- `getImageBitmap?: (src: string) => Promise<ImageBitmap>` - Custom image loader
- `onReady?: (drawfn: Drawfn) => void` - Callback when drawfn is initialized
- `onSceneChange?: (scene: Scene, meta?: SceneChangedEvent) => void` - Callback when scene changes
- `class?: string` - CSS class for canvas element

**Methods (via bind:this):**
- `getDrawfn(): Drawfn | null` - Get drawfn instance
- `setTool(tool: ToolName, opts?)` - Set active tool
- `undo()` - Undo last action
- `redo()` - Redo last undone action
- `clear()` - Clear the canvas
- `exportPNG(opts?): Promise<Blob | undefined>` - Export as PNG
- `exportSVG(opts?): Promise<string | undefined>` - Export as SVG

### Export Options

- `exportPNG({ padding, scale, transparent, selectedOnly, fitContent })`
  - Defaults: `padding: 20`, `scale: 2`, `transparent: false`, `selectedOnly: false`, `fitContent: false`
- `exportSVG({ padding, scale, selectedOnly, fitContent })`
  - Defaults: `padding: 20`, `scale: 1`, `selectedOnly: false`, `fitContent: false`

### Canvas Component

Simple canvas component with proper styling for drawfn.

**Props:**
- `width?: number` - Canvas width (default: 800)
- `height?: number` - Canvas height (default: 600)
- `class?: string` - CSS class

### drawfn Action

Svelte action for using drawfn on a canvas element.

**Usage:**
```svelte
<canvas use:drawfn={options} />
```

**Options:**
- `scene?: Scene` - Initial scene
- `overlayRoot?: HTMLElement` - Root for text overlay
- `getImageBitmap?: (src: string) => Promise<ImageBitmap>` - Image loader
- `onReady?: (drawfn: Drawfn) => void` - Ready callback
- `onSceneChange?: (scene: Scene, meta?: SceneChangedEvent) => void` - Scene change callback

### createDrawfnStore()

Creates a Svelte store for reactive drawfn state.

**Returns a store with:**
```typescript
{
  instance: Drawfn | null;
  isReady: boolean;
  currentTool: ToolName;
  canUndo: boolean;
  canRedo: boolean;
  selectedIds: string[];
  elementCount: number;
  camera: Camera;
}
```

**Methods:**
- `setInstance(drawfn: Drawfn)` - Set drawfn instance
- `setTool(tool: ToolName, opts?)` - Set active tool
- `clear()` - Clear canvas
- `destroy()` - Cleanup

## Tools

All tools from `drawfn` are available:
- `select` - Select, move, resize, rotate elements
- `pan` - Pan the canvas
- `pen` - Freehand drawing
- `rectangle` - Draw rectangles (Shift for square)
- `ellipse` - Draw ellipses (Shift for circle)
- `arrow` - Draw arrows with arrowhead
- `text` - Add text with inline editing
- `image` - Add images: `setTool('image', { src: 'url' })`
- `node` - Add nodes: `setTool('node', { nodeId: 'abc' })`

## Events

Subscribe to drawfn events:

```svelte
<script>
  import { drawfn } from '@drawfn/svelte';

  let instance;

  function handleReady(drawfn) {
    instance = drawfn;

    drawfn.on('elementAdded', (element) => {
      console.log('Element added:', element);
    });

    drawfn.on('selectionChanged', (ids) => {
      console.log('Selection changed:', ids);
    });
  }
</script>

<canvas use:drawfn={{ onReady: handleReady }} />
```

**Available events:**
- `pointerDown`, `pointerMove`, `pointerUp`
- `elementAdded`, `elementUpdated`, `elementRemoved`
- `selectionChanged`
- `historyChanged`
- `cameraChanged`

## TypeScript Support

Full TypeScript support with type definitions included.

```svelte
<script lang="ts">
  import DrawfnCanvas from '@drawfn/svelte/DrawfnCanvas.svelte';
  import type { Drawfn, Scene, SceneChangedEvent } from '@drawfn/svelte';

  let drawfnCanvas: DrawfnCanvas;
  let scene: Scene | undefined;
</script>
```

## License

MIT

### Clearing and undo history

`clear()` is undoable. Use `resetHistory()` to discard undo/redo entries without changing content, or call it after `clear()` for a permanent clear. The component/hook or store exposes this helper alongside `clear()`. Text commits produce `sceneChanged` metadata with reason `text-commit`.

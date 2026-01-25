# @21n/drawfn

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
npm install @21n/drawfn perfect-freehand
```

## Quick Start

```typescript
import { Drawfn } from '@21n/drawfn';

const canvas = document.querySelector('canvas');
const drawfn = new Drawfn({ canvas });

// Set a tool
drawfn.setTool('pen');

// Listen to events
drawfn.on('elementAdded', (element) => {
  console.log('New element added:', element);
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
- `getScene(): Scene`: Get current scene as JSON
- `clear()`: Clear the entire canvas

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

**Selection**
- `setSelection(ids: string[])`: Set selected element IDs
- `getSelectedIds(): string[]`: Get selected element IDs

**Export**
- `exportPNG(opts?): Promise<Blob>`: Export as PNG
  - Options: `{ padding?: number; scale?: number; transparent?: boolean }`
- `exportSVG(opts?): Promise<string>`: Export as SVG (includes freedraw, arrows, images)
  - Options: `{ padding?: number; scale?: number }`

**Events**
- `on(event, handler): () => void`: Subscribe to events, returns unsubscribe function
  - Events: `pointerDown`, `pointerMove`, `pointerUp`, `elementAdded`, `elementUpdated`, `elementRemoved`, `selectionChanged`, `historyChanged`, `cameraChanged`

**Cleanup**
- `destroy()`: Cleanup and remove event listeners

## Examples

See `example.html` for a complete vanilla JS example with toolbar and all tools.

For React examples, see `@21n/drawfn-react` package.

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

Apache-2.0

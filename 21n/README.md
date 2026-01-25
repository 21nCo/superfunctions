# 21n Drawing Canvas Packages

Cross-framework drawing canvas library for brainstorming and simple sketching.

## Packages

### [@21n/drawfn](./drawfn) - Core Library (43KB)

Framework-agnostic drawing canvas with complete feature set.

```bash
npm install @21n/drawfn perfect-freehand
```

**Features:**
- 9 tools: select, pan, pen, rectangle, ellipse, arrow, text, image, node
- Resize & rotation handles
- Undo/redo history (50 levels)
- PNG & SVG export
- Camera pan & zoom
- Perfect-freehand for smooth strokes
- Event system
- Keyboard shortcuts
- TypeScript support

[View Documentation →](./drawfn/README.md)

### [@21n/drawfn-react](./drawfn-react) - React Adapter (3.4KB)

React hooks and components for drawfn.

```bash
npm install @21n/drawfn-react @21n/drawfn perfect-freehand
```

**API:**
- `useDrawfn()` hook
- `<Canvas>` component
- `<DrawfnCanvas>` all-in-one component
- Controlled/uncontrolled scene support

**Example:**
```tsx
import { DrawfnCanvas } from '@21n/drawfn-react';

function App() {
  return <DrawfnCanvas width={1200} height={800} />;
}
```

[View Documentation →](./drawfn-react/README.md)

### [@21n/drawfn-svelte](./drawfn-svelte) - Svelte Adapter (2.7KB)

Svelte actions, stores, and components for drawfn.

```bash
npm install @21n/drawfn-svelte @21n/drawfn perfect-freehand
```

**API:**
- `use:drawfn` action
- `createDrawfnStore()` for reactive state
- `<Canvas>` component
- `<DrawfnCanvas>` all-in-one component

**Example:**
```svelte
<script>
  import DrawfnCanvas from '@21n/drawfn-svelte/DrawfnCanvas.svelte';
</script>

<DrawfnCanvas width={1200} height={800} />
```

[View Documentation →](./drawfn-svelte/README.md)

## Features Comparison

| Feature | Core | React | Svelte |
|---------|------|-------|--------|
| All 9 tools | ✅ | ✅ | ✅ |
| Resize/rotate handles | ✅ | ✅ | ✅ |
| Undo/redo | ✅ | ✅ | ✅ |
| PNG/SVG export | ✅ | ✅ | ✅ |
| Text editing overlay | ✅ | ✅ | ✅ |
| Controlled scene | ✅ | ✅ | ✅ |
| Event subscriptions | ✅ | ✅ | ✅ |
| TypeScript | ✅ | ✅ | ✅ |
| Framework hook | - | ✅ | ✅ (action) |
| Reactive stores | - | - | ✅ |

## Tools

All packages support these tools:

- **select** - Select, move, resize, rotate elements with handles
- **pan** - Pan the canvas
- **pen** - Freehand drawing with pressure support (perfect-freehand)
- **rectangle** - Draw rectangles (Shift for square)
- **ellipse** - Draw ellipses (Shift for circle)
- **arrow** - Draw arrows with triangle arrowhead
- **text** - Add text with inline HTML overlay editing
- **image** - Add images programmatically
- **node** - Add Nucleus node bookmarks (for integrations)

## Examples

### Vanilla JS
See [example.html](./drawfn/example.html) for complete demo.

```javascript
import { Drawfn } from '@21n/drawfn';

const canvas = document.querySelector('canvas');
const drawfn = new Drawfn({ canvas });

drawfn.setTool('pen');
drawfn.on('elementAdded', (element) => {
  console.log('Element added:', element);
});
```

### React
```tsx
import { useDrawfn, Canvas } from '@21n/drawfn-react';

function App() {
  const { canvasRef, setTool, undo, redo } = useDrawfn();
  
  return (
    <div>
      <button onClick={() => setTool('pen')}>Pen</button>
      <button onClick={undo}>Undo</button>
      <Canvas ref={canvasRef} width={1200} height={800} />
    </div>
  );
}
```

### Svelte
```svelte
<script>
  import { drawfn, createDrawfnStore } from '@21n/drawfn-svelte';
  
  const store = createDrawfnStore();
  
  function handleReady(instance) {
    store.setInstance(instance);
  }
</script>

<button on:click={() => store.setTool('pen')}>Pen</button>
<button on:click={() => $store.instance?.undo()} disabled={!$store.canUndo}>
  Undo
</button>

<canvas use:drawfn={{ onReady: handleReady }} width={1200} height={800} />
```

## Build

```bash
# Install dependencies
npm install

# Build all packages
npm run build -- --filter="@21n/*"

# Build specific package
cd drawfn && npm run build
cd drawfn-react && npm run build
cd drawfn-svelte && npm run build
```

## Testing

```bash
cd drawfn
npm test           # Run tests
npm run lint       # Type check
```

## Architecture

```
User Interaction
      ↓
Framework Adapter (React/Svelte/Vanilla)
      ↓
Drawfn Core
      ↓
Tool Manager → Tools (select, pen, etc.)
      ↓
Renderer (Canvas 2D + perfect-freehand)
      ↓
Scene (JSON-serializable state)
```

## License

Apache-2.0

## Links

- [Core Documentation](./drawfn/README.md)
- [React Documentation](./drawfn-react/README.md)
- [Svelte Documentation](./drawfn-svelte/README.md)
- [Implementation Details](./drawfn/IMPLEMENTATION.md)
- [Original Spec](./drawfn/SPEC.md)

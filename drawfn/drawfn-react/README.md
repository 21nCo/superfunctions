# @21n/drawfn-react

React adapter for @21n/drawfn drawing canvas library.

## Installation

```bash
npm install @21n/drawfn-react @21n/drawfn perfect-freehand
```

## Quick Start

### Using the DrawfnCanvas Component

```tsx
import { DrawfnCanvas } from '@21n/drawfn-react';
import { useState } from 'react';

function App() {
  const [drawfn, setDrawfn] = useState(null);

  return (
    <div>
      <button onClick={() => drawfn?.setTool('pen')}>Pen</button>
      <button onClick={() => drawfn?.setTool('rectangle')}>Rectangle</button>
      <button onClick={() => drawfn?.undo()}>Undo</button>
      <button onClick={() => drawfn?.redo()}>Redo</button>
      
      <DrawfnCanvas
        width={1200}
        height={800}
        onReady={setDrawfn}
      />
    </div>
  );
}
```

### Using the useDrawfn Hook

```tsx
import { useDrawfn, Canvas } from '@21n/drawfn-react';

function App() {
  const { canvasRef, setTool, undo, redo, getScene } = useDrawfn({
    onSceneChange: (scene) => {
      console.log('Scene changed:', scene);
    },
  });

  return (
    <div>
      <button onClick={() => setTool('pen')}>Pen</button>
      <button onClick={() => setTool('select')}>Select</button>
      <button onClick={undo}>Undo</button>
      <button onClick={redo}>Redo</button>
      
      <Canvas ref={canvasRef} width={1200} height={800} />
    </div>
  );
}
```

### Controlled Scene

```tsx
import { DrawfnCanvas } from '@21n/drawfn-react';
import { useState } from 'react';

function App() {
  const [scene, setScene] = useState(null);

  return (
    <DrawfnCanvas
      width={1200}
      height={800}
      scene={scene}
      onSceneChange={setScene}
    />
  );
}
```

### Export Canvas

```tsx
import { useDrawfn, Canvas } from '@21n/drawfn-react';

function App() {
  const { canvasRef, exportPNG, exportSVG } = useDrawfn();

  const handleExportPNG = async () => {
    const blob = await exportPNG({ scale: 2 });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'drawing.png';
    a.click();
  };

  const handleExportSVG = async () => {
    const svg = await exportSVG();
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'drawing.svg';
    a.click();
  };

  return (
    <div>
      <button onClick={handleExportPNG}>Export PNG</button>
      <button onClick={handleExportSVG}>Export SVG</button>
      <Canvas ref={canvasRef} width={1200} height={800} />
    </div>
  );
}
```

## API

### useDrawfn(options?)

Returns an object with:
- `canvasRef` - React ref to attach to a canvas element
- `drawfn` - Drawfn instance (null until mounted)
- `isReady` - Boolean indicating if drawfn is initialized
- `setTool(tool, opts?)` - Set the active tool
- `getScene()` - Get current scene as JSON
- `undo()` - Undo last action
- `redo()` - Redo last undone action
- `clear()` - Clear the canvas
- `exportPNG(opts?)` - Export as PNG blob
- `exportSVG(opts?)` - Export as SVG string
- `on(event, handler)` - Subscribe to events

### DrawfnCanvas

Props:
- All canvas props (width, height, style, etc.)
- `scene?` - Initial or controlled scene
- `onSceneChange?` - Callback when scene changes
- `onReady?` - Callback when drawfn is initialized
- `overlayRoot?` - Root element for text editing overlay
- `getImageBitmap?` - Custom image loader

## License

Apache-2.0

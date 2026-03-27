# drawfn: Cross‑Framework Drawing Canvas Library (Spec)

Status: Draft 1 (2026‑01‑08)
Owner: 21n
Scope: Library (not an app) usable in React, Svelte, Vue, vanilla

## 1. Goals
- Provide a lightweight, framework‑agnostic drawing canvas for brainstorming and simple sketching.
- Support freehand pen drawing, basic shapes, text, images, and nucleus nodes (bookmark/markdown) as insertable items.
- Element‑based retained‑mode architecture with full scene serialization to JSON for persistence.
- First integration target: Nucleus apps; but library must work in any frontend project.
- No collaboration/realtime features in v1.

## 2. Non‑Goals (v1)
- No multiplayer/CRDT/OT or presence.
- No complex artistic brushes, filters, or blend modes.
- No shape libraries or connectors beyond arrows.
- No rough/sketch aesthetic (can be added via optional plugin later).

## 3. High‑Level Architecture

```
App / Host Framework
  └── drawfn (core)
        ├─ Scene Store (elements, camera, selection, history)
        ├─ Renderer (Canvas 2D) + optional DOM overlay for text inputs
        ├─ Tools (select, pan, pen, rectangle, ellipse, arrow, text, image, node)
        ├─ IO (serialize/deserialize, import/export PNG/SVG)
        └─ Adapters (React/Svelte bindings - thin wrappers)
```

- Core is framework‑agnostic TypeScript with no UI framework deps.
- Rendering target: Canvas 2D for speed; HTML overlay for in‑place text editing; optional SVG export.
- Freehand strokes via perfect‑freehand to generate outlines.

## 4. Data Model (Serializable)

```ts
export type ElementType =
  | 'freedraw'
  | 'rectangle'
  | 'ellipse'
  | 'arrow'
  | 'text'
  | 'image'
  | 'node'; // nucleus node reference

export type BaseElement = {
  id: string
  type: ElementType
  x: number
  y: number
  w: number
  h: number
  rotation: number // radians
  stroke: string
  fill: string | 'transparent'
  strokeWidth: number
  opacity: number // 0..1
  locked?: boolean
  meta?: Record<string, any>
}

export type FreeDrawElement = BaseElement & {
  type: 'freedraw'
  points: [number, number, number?][] // x,y,(pressure)
  style?: {
    size?: number // base brush size
    thinning?: number
    smoothing?: number
    streamline?: number
    taperStart?: number
    taperEnd?: number
  }
}

export type TextElement = BaseElement & {
  type: 'text'
  text: string
  fontFamily: string
  fontSize: number
  align: 'left'|'center'|'right'
}

export type ImageElement = BaseElement & {
  type: 'image'
  src: string // data URL or external URL
  naturalW?: number
  naturalH?: number
}

export type ArrowElement = BaseElement & {
  type: 'arrow'
  points: [number, number][] // start..end polyline
  head: 'triangle'|'none'
}

export type NodeElement = BaseElement & {
  type: 'node'
  nodeId: string // IRecordId from nucleus
  nodeType?: string // NodeType if available
  variant?: 'bookmark'|'embed'|'card'
  preview?: { title?: string; icon?: string; excerpt?: string }
}

export type Scene = {
  version: 1
  id: string
  elements: BaseElement[]
  camera: { x: number; y: number; zoom: number }
  background: { color: string; grid?: { size: number; color: string; alpha: number } }
}
```

Notes:
- Scene JSON is the persistable unit; stable, forward‑compatible via `version` + tolerant parsing.
- `NodeElement` integrates with nucleus by carrying `nodeId` and optional metadata; rendering shows a bookmark/card with link.

## 5. Public API (Core)

```ts
export type DrawfnOptions = {
  canvas: HTMLCanvasElement
  overlayRoot?: HTMLElement // for text input overlays
  getImageBitmap?: (src: string) => Promise<ImageBitmap> // optional image loader
}

export class Drawfn {
  constructor(opts: DrawfnOptions)

  // Scene
  load(scene: Scene): void
  getScene(): Scene
  clear(): void

  // Elements
  add(el: BaseElement): string // returns id
  update(id: string, patch: Partial<BaseElement>): void
  remove(id: string): void
  bringToFront(id: string): void
  sendToBack(id: string): void

  // Tools & Interaction
  setTool(tool: ToolName, opts?: any): void
  getTool(): ToolName
  on(event: DrawfnEvent, handler: (...args:any[])=>void): () => void // unsubscribe

  // Camera
  setCamera(c: Partial<Scene['camera']>): void
  getCamera(): Scene['camera']
  screenToCanvas(p: {x:number;y:number}): {x:number;y:number}

  // History
  undo(): void
  redo(): void

  // Export
  exportPNG(opts?: { padding?: number; scale?: number; transparent?: boolean }): Promise<Blob>
  exportSVG(opts?: { padding?: number; scale?: number }): Promise<string>
}
```

Events: `pointerDown|Move|Up`, `elementAdded|Updated|Removed`, `selectionChanged`, `historyChanged`.

## 6. Tools (Built‑in)
- select: marquee select, move, resize, rotate, delete
- pan: space+drag, trackpad; wheel zoom at cursor
- pen: freehand with perfect‑freehand; pressure if available
- rectangle, ellipse: drag to create, shift to constrain
- arrow: start→end, simple arrowhead
- text: click to place; HTML textarea overlay for editing; commits to canvas element
- image: programmatic insert (URL/DataURL); resize handles
- node: programmatic insert using nucleus nodeId; renders bookmark/preview tile

## 7. Rendering
- Single Canvas for content; optional second canvas for static cache in later versions.
- Apply camera transform (translate+scale). Stroke widths adjust with zoom for consistent visual size for selection handles; element strokes remain in scene units.
- Freehand: store points; render by computing outline polygon from `perfect-freehand` and filling path.
- Text: measured via Canvas; actual editing via DOM overlay; on blur, draw text to canvas on each render pass.

## 8. Performance
- Viewport culling: skip elements outside visible rect.
- Debounced renders via `requestAnimationFrame`.
- Optional offscreen cache for static layers (v1.1).
- Lazy image loading via `getImageBitmap` hook.

## 9. Persistence
- `getScene()` returns JSON‑serializable object for storage.
- `load(scene)` hydrates from storage.
- Hosts (Nucleus apps) persist via their own storage (Dexie/IndexedDB/etc.).

## 10. Nucleus Integration
- `NodeElement.nodeId` links to existing Nucleus node (`IRecordId`).
- Rendering strategy:
  - Bookmark variant: draw rounded rect with title/icon (provided via `preview`), click opens node route in host app.
  - Embed variant (future): host can register a render callback to draw richer previews.
- Adapter hook:
```ts
registerNodePreviewFetcher(async (nodeId) => ({ title, icon, excerpt }))
```
- Selection → host can open a side panel for node details.

## 11. Framework Bindings

### React (package: `@drawfn/react`)
- `Canvas` component mounts a `<canvas>` and constructs `Drawfn`.
- Controlled or uncontrolled scene.
- Example:
```tsx
function Whiteboard() {
  const ref = useRef<HTMLCanvasElement>(null)
  const [api, setApi] = useState<Drawfn | null>(null)
  useEffect(() => {
    if (!ref.current) return
    const d = new Drawfn({ canvas: ref.current, overlayRoot: document.body })
    setApi(d)
    return () => d?.clear()
  }, [])
  return <canvas ref={ref} width={1200} height={800} />
}
```

### Svelte (package: `@drawfn/svelte`)
- `<Canvas bind:api {scene} on:event=... />` thin wrapper.

Bindings expose the same core API; no dependency on framework inside core.

## 12. Input & Accessibility
- Pointer Events API (works for mouse, pen, touch).
- Keyboard: delete, cmd/ctrl+Z/Y, space for pan, shift to constrain aspect.
- Screen readers: not primary target; expose ARIA on toolbar if wrapper provides one.

## 13. Hit Testing & Transforms
- Axis‑aligned bbox for basic shapes; for rotation, compute oriented bbox for selection handles.
- Freehand hit test via polygon bounding box with tolerance.
- Text hit test via measured metrics.

## 14. Styling & Theming
- Basic element styles: stroke, fill, opacity.
- Global theme input: background color, grid settings.
- Host controls tool UI; core does not ship UI, only imperative API + events.

## 15. Packaging
- Monorepo packages:
  - `drawfn` (core, ESM + CJS)
  - `@drawfn/react` (optional)
  - `@drawfn/svelte` (optional)
- Dependencies: `perfect-freehand` only (runtime). Dev: TypeScript, Vite build.

## 16. Security & Sandbox
- No remote code execution.
- Images loaded via host‑provided loader to avoid cross‑origin issues.

## 17. Roadmap
- v1.0: core elements, serialization, React/Svelte adapters, PNG/SVG export
- v1.1: offscreen caching, alignment guides, snap to grid, groups
- v1.2: rich NodeElement embed, clipboard copy/paste (PNG/SVG/JSON), image cropping
- v1.3: pens/eraser tools (vector eraser), rulers

## 18. Example JSON

```json
{
  "version": 1,
  "id": "scene_001",
  "camera": { "x": 0, "y": 0, "zoom": 1 },
  "background": { "color": "#ffffff", "grid": { "size": 16, "color": "#e5e7eb", "alpha": 0.6 } },
  "elements": [
    {
      "id": "e1",
      "type": "freedraw",
      "x": 100,
      "y": 120,
      "w": 220,
      "h": 80,
      "rotation": 0,
      "stroke": "#111827",
      "fill": "transparent",
      "strokeWidth": 2,
      "opacity": 1,
      "points": [[0,0,0.2],[10,5,0.5],[20,8,0.3]]
    },
    {
      "id": "e2",
      "type": "node",
      "x": 380,
      "y": 150,
      "w": 240,
      "h": 120,
      "rotation": 0,
      "stroke": "#2563eb",
      "fill": "#eff6ff",
      "strokeWidth": 1,
      "opacity": 1,
      "nodeId": "nuc_abc123",
      "variant": "bookmark",
      "preview": { "title": "My Markdown Note", "icon": "md", "excerpt": "…" }
    }
  ]
}
```

## 19. Open Questions
- Do we need arrow bindings or snapping in v1, or push to v1.1?
- Should NodeElement support inline markdown rendering on canvas, or always show a bookmark card?
- Clipboard integration scope for v1?

## 20. Acceptance Criteria (v1)
- Import/export full scene JSON deterministically (round‑trip safe).
- Create/edit/delete: freedraw, rectangle, ellipse, arrow, text, image, node.
- Pan/zoom; selection + resize; undo/redo.
- PNG export of visible scene; SVG export of vector content.
- React and Svelte wrappers compile and run in a demo app.
- Works in Nucleus app embedding with NodeElement bookmarks.

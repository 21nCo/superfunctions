import { describe, it, expect, vi } from "vitest";
import { Drawfn } from "../src/drawfn";
import { Renderer } from "../src/renderer";
import type { RectangleElement } from "../src/types";
const rectangle: RectangleElement = { id: "r", type: "rectangle", x: 1000, y: 2000, w: 100, h: 60, rotation: 0, stroke: "black", fill: "red", strokeWidth: 0, opacity: 1 };
const canvas = () => { const c = document.createElement("canvas"); c.width = 800; c.height = 600; document.body.append(c); return c; };
describe("core readiness boundaries", () => {
  it("escapes every SVG style attribute and positions fitted backgrounds", async () => {
    const api = new Drawfn({ canvas: canvas() });
    const injected = '\"><script>alert(1)</script><rect fill="';
    api.add({ ...rectangle, stroke: injected, fill: injected });
    api.add({ ...rectangle, id: "t", type: "text", text: "<unsafe>", fontSize: 16, fontFamily: injected, align: "left" });
    const scene = api.getScene(); scene.background.color = injected; api.load(scene);
    const doc = new DOMParser().parseFromString(await api.exportSVG({ fitContent: true }), "image/svg+xml");
    expect(doc.querySelector("parsererror, script")).toBeNull();
    expect(doc.querySelector("text")?.getAttribute("font-family")).toBe(injected);
    expect(doc.querySelector("rect")?.getAttribute("x")).toBe("980");
    expect(doc.querySelectorAll("rect")).toHaveLength(2);
    api.destroy();
  });
  it("fits PNG with one camera transform, independently of the live camera", async () => {
    const api = new Drawfn({ canvas: canvas() }); api.add(rectangle); api.setCamera({ x: 700, y: -80, zoom: 3 });
    const render = vi.spyOn(Renderer.prototype, "render");
    await api.exportPNG({ fitContent: true, padding: 10, scale: 2 });
    const exported = render.mock.calls.find(([scene]) => scene.camera.zoom === 2)?.[0];
    expect(exported?.camera).toEqual({ x: -1980, y: -3980, zoom: 2 });
    render.mockRestore(); api.destroy();
  });
  it("does not broadcast keyboard changes to another canvas or text inputs", () => {
    const a = new Drawfn({ canvas: canvas() }), bCanvas = canvas(), b = new Drawfn({ canvas: bCanvas });
    a.add(rectangle); b.add(rectangle); a.setSelection(["r"]); b.setSelection(["r"]);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(a.getElements()).toHaveLength(1); expect(b.getElements()).toHaveLength(1);
    bCanvas.focus(); bCanvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(a.getElements()).toHaveLength(1); expect(b.getElements()).toHaveLength(0);
    a.destroy(); b.destroy();
  });
  it("closes loaded and late bitmaps without post-disposal callbacks", async () => {
    let resolve!: (bitmap: ImageBitmap) => void;
    const loaded = vi.fn(), errored = vi.fn(), close = vi.fn();
    const renderer = new Renderer(canvas(), () => new Promise(r => { resolve = r; }), { onImageLoaded: loaded, onImageError: errored });
    const pending = renderer.preloadImages([{ ...rectangle, type: "image", src: "image" }]);
    renderer.dispose(); resolve({ close } as unknown as ImageBitmap); await pending;
    expect(close).toHaveBeenCalledOnce(); expect(loaded).not.toHaveBeenCalled(); expect(errored).not.toHaveBeenCalled();
    const readyClose = vi.fn();
    const ready = new Renderer(canvas(), async () => ({ close: readyClose } as unknown as ImageBitmap));
    await ready.preloadImages([{ ...rectangle, type: "image", src: "image" }]);
    ready.dispose(); ready.dispose(); expect(readyClose).toHaveBeenCalledOnce();
  });
  it("rejects invalid export scales and keeps camera state valid", async () => {
    const api = new Drawfn({ canvas: canvas() });
    const before = api.getCamera(); api.setCamera({ x: NaN });
    expect(api.getCamera()).toEqual(before);
    await expect(api.exportPNG({ scale: 0 })).rejects.toMatchObject({ code: "EXPORT_RENDER_FAILED" });
    await expect(api.exportSVG({ padding: Infinity })).rejects.toMatchObject({ code: "EXPORT_RENDER_FAILED" });
    api.destroy();
  });
  it("keeps a newly opened text editor focused through its opening click", async () => {
    const c = canvas(); const api = new Drawfn({ canvas: c }); api.setTool("text");
    c.dispatchEvent(new PointerEvent("pointerdown", { clientX: 20, clientY: 30, bubbles: true, cancelable: true }));
    const editor = document.querySelector("textarea"); expect(editor).toBe(document.activeElement);
    await new Promise(resolve => setTimeout(resolve, 1));
    c.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector("textarea")).toBe(editor);
    api.destroy();
  });

  it("resolves node previews and ignores results after removal", async () => {
    const loader = vi.fn(async () => ({ title: "Loaded", description: "Details" }));
    const api = new Drawfn({ canvas: canvas(), getNodePreview: loader });
    api.add({ ...rectangle, type: "node", nodeId: "n", variant: "card" });
    await vi.waitFor(() => expect(api.getElementById("r")).toMatchObject({ preview: { title: "Loaded", excerpt: "Details" } }));
    expect(loader).toHaveBeenCalledWith("n");
    api.add({ ...rectangle, id: "removed", type: "node", nodeId: "gone", variant: "card" });
    api.remove("removed"); await Promise.resolve(); await Promise.resolve();
    expect(api.getElementById("removed")).toBeUndefined(); api.destroy();
  });
  it("calls node click hooks for clicks, not drags", () => {
    const c = canvas(), onNodeClick = vi.fn(); const api = new Drawfn({ canvas: c, onNodeClick });
    api.add({ ...rectangle, x: 10, y: 10, type: "node", nodeId: "n", variant: "card" });
    const pointer = (type: string, x: number) => c.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: 30, button: 0, bubbles: true }));
    pointer("pointerdown", 30); pointer("pointerup", 30);
    expect(onNodeClick).toHaveBeenCalledOnce(); expect(onNodeClick.mock.calls[0][0]).toBe("n");
    pointer("pointerdown", 30); pointer("pointermove", 60); pointer("pointerup", 60);
    expect(onNodeClick).toHaveBeenCalledOnce(); api.destroy();
  });

  it("repaints backing dimension changes without scene/history events and disconnects on destroy", async () => {
    const c = canvas(); const render = vi.spyOn(Renderer.prototype, "render");
    const api = new Drawfn({ canvas: c }); const changed = vi.fn(); api.on("sceneChanged", changed);
    await vi.waitFor(() => expect(render).toHaveBeenCalled()); render.mockClear();
    c.width = 900; c.height = 700;
    await vi.waitFor(() => expect(render).toHaveBeenCalled()); expect(changed).not.toHaveBeenCalled();
    api.destroy(); render.mockClear(); c.width = 1000;
    await new Promise(resolve => setTimeout(resolve, 30)); expect(render).not.toHaveBeenCalled(); render.mockRestore();
  });
  it("maps CSS-scaled client coordinates into backing coordinates", () => {
    const c = canvas(); c.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 300 } as DOMRect);
    const api = new Drawfn({ canvas: c }); api.setCamera({ x: 20, y: 40, zoom: 2 });
    expect(api.screenToCanvas({ x: 60, y: 70 })).toEqual({ x: 40, y: 30 }); api.destroy();
  });

  it("cancels edits without committing history and retains camera during undo/redo", () => {
    const c = canvas(), api = new Drawfn({ canvas: c }); api.add({ ...rectangle, x: 10, y: 10 });
    const removed = vi.fn(); api.on("elementRemoved", removed);
    const history = api.getHistoryState(); api.setTool("rectangle");
    const event = (type: string, x: number) => c.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: x, clientY: x, button: 0, bubbles: true }));
    event("pointerdown", 30); event("pointermove", 80); expect(api.getElements()).toHaveLength(2);
    event("pointercancel", 80); expect(removed).toHaveBeenCalledOnce(); expect(api.getElements()).toHaveLength(1); expect(api.getHistoryState()).toEqual(history);
    api.setCamera({ x: 200, y: 300, zoom: 2 }); api.undo(); expect(api.getElements()).toHaveLength(0);
    expect(api.getCamera()).toEqual({ x: 200, y: 300, zoom: 2 }); api.redo(); expect(api.getCamera()).toEqual({ x: 200, y: 300, zoom: 2 });
    api.destroy();
  });
  it("records a pen tap as a canonical local dot", () => {
    const c = canvas(), api = new Drawfn({ canvas: c }); api.setTool("pen");
    c.dispatchEvent(new PointerEvent("pointerdown", { clientX: 100, clientY: 120, bubbles: true }));
    c.dispatchEvent(new PointerEvent("pointerup", { clientX: 100, clientY: 120, bubbles: true }));
    expect(api.getElements()[0]).toMatchObject({ points: [[0, 0, 0.5]] }); api.destroy();
  });

  it("reports non-serializable scene metadata through the result envelope", () => {
    const api = new Drawfn({ canvas: canvas() }); const scene = api.getScene();
    const meta: Record<string, unknown> = {}; meta.circular = meta;
    expect(api.loadScene({ ...scene, elements: [{ ...rectangle, meta }] })).toMatchObject({ ok: false, error: { code: "INVALID_SCENE" } });
    expect(api.getScene()).toEqual(scene); api.destroy();
  });
  it("keeps locked selected elements safe from keyboard deletion", () => {
    const c = canvas(), api = new Drawfn({ canvas: c }); api.add({ ...rectangle, locked: true }); api.setSelection(["r"]);
    c.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })); expect(api.getElements()).toHaveLength(1); api.destroy();
  });
  it("uses supplied pressure and taper in exported strokes", async () => {
    const api = new Drawfn({ canvas: canvas() });
    const path = async (pressure: number, taperStart = 0) => {
      api.clear(); api.add({ ...rectangle, type: "freedraw", x: 0, y: 0, points: [[0, 0, pressure], [20, 10, pressure], [40, 0, pressure]], style: { size: 10, taperStart } });
      return new DOMParser().parseFromString(await api.exportSVG(), "image/svg+xml").querySelector("path")?.getAttribute("d");
    };
    const light = await path(0.1), heavy = await path(0.9), tapered = await path(0.9, 20);
    expect(light).not.toBe(heavy); expect(tapered).not.toBe(heavy); api.destroy();
  });

});

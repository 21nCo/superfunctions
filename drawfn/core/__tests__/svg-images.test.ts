import { afterEach, describe, expect, it, vi } from "vitest";
import { Drawfn } from "../src/drawfn";
import type { ImageElement } from "../src/types";
const image = (id: string, src = "private://asset"): ImageElement => ({ id, type: "image", src, x: 0, y: 0, w: 10, h: 10, rotation: 0, stroke: "black", fill: "transparent", strokeWidth: 0, opacity: 1 });
const setup = (loader: (src: string) => Promise<ImageBitmap>) => {
  vi.spyOn(globalThis, "requestAnimationFrame").mockReturnValue(1);
  const api = new Drawfn({ canvas: document.createElement("canvas"), getImageBitmap: loader });
  const error = vi.fn(); api.on("error", error); return { api, error };
};
afterEach(() => vi.restoreAllMocks());

describe("portable SVG images", () => {
  it("embeds duplicate private sources once through the configured loader and disposes owned bitmaps", async () => {
    const close = vi.fn(); const loader = vi.fn(async () => ({ width: 2, height: 3, close } as unknown as ImageBitmap));
    const encode = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,encoded");
    const { api } = setup(loader); api.add(image("one")); api.add(image("two"));
    const svg = await api.exportSVG();
    expect(loader).toHaveBeenCalledExactlyOnceWith("private://asset"); expect(encode).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    expect(svg).not.toContain("private://"); expect(svg.match(/href="data:image\/png;base64,encoded"/g)).toHaveLength(2); api.destroy();
  });

  it.each(["reject", "taint", "invalid-encoding", "oversize", "pixel-budget"])("rejects %s without falling back to an external href", async failure => {
    const close = vi.fn(); const loader = vi.fn(async () => {
      if (failure === "reject") throw new Error("denied");
      return { width: failure === "oversize" ? 8193 : failure === "pixel-budget" ? 8192 : 2, height: failure === "pixel-budget" ? 8192 : 2, close } as unknown as ImageBitmap;
    });
    const encode = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => {
      if (failure === "taint") throw new DOMException("Tainted", "SecurityError");
      return failure === "invalid-encoding" ? "data:," : "data:image/png;base64,encoded";
    });
    const { api, error } = setup(loader); api.add(image("one")); if (failure === "pixel-budget") api.add(image("two", "private://second"));
    const code = failure === "reject" ? "EXPORT_IMAGE_LOAD_FAILED" : "EXPORT_RENDER_FAILED";
    await expect(api.exportSVG()).rejects.toMatchObject({ code, recoverable: true }); expect(error).toHaveBeenCalledOnce();
    if (failure === "oversize" || failure === "pixel-budget") expect(encode).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(failure === "reject" ? 0 : failure === "pixel-budget" ? 2 : 1); api.destroy();
  });

  it("rejects more than 64 unique sources before invoking the host loader", async () => {
    const loader = vi.fn(); const { api, error } = setup(loader);
    for (let i = 0; i < 65; i++) api.add(image(String(i), `private://${i}`));
    await expect(api.exportSVG()).rejects.toMatchObject({ code: "SCENE_LIMIT_EXCEEDED" });
    expect(loader).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce(); api.destroy();
  });
  it("keeps scene/camera snapshot stable while custom image loading is pending", async () => {
    let finish!: (asset: ImageBitmap) => void;
    const { api } = setup(() => new Promise(resolve => { finish = resolve; }));
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,encoded");
    api.add(image("one")); api.setCamera({ x: 10, y: 20, zoom: 2 });
    const pending = api.exportSVG(); api.setCamera({ x: 100, y: 200, zoom: 3 }); api.update("one", { x: 999 });
    finish({ width: 2, height: 2, close: vi.fn() } as unknown as ImageBitmap);
    const svg = await pending; expect(svg).toContain('translate(10 20) scale(2)'); expect(svg).toContain('<image x="0"'); api.destroy();
  });

  it("bounds repeated embedded URI expansion before producing a giant SVG", async () => {
    const close = vi.fn();
    const { api, error } = setup(async () => ({ width: 1, height: 1, close } as unknown as ImageBitmap));
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64," + "A".repeat(33 * 1024 * 1024));
    api.add(image("one")); api.add(image("two"));
    await expect(api.exportSVG()).rejects.toMatchObject({ code: "EXPORT_RENDER_FAILED", details: { limit: 64 * 1024 * 1024 } });
    expect(error).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); api.destroy();
  });

});

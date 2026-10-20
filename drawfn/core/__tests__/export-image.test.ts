import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Drawfn } from "../src/drawfn";
import type { DrawfnError } from "../src/types";

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = 600;
  canvas.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return canvas;
}

describe("export and image behavior", () => {
  const originalRaf = globalThis.requestAnimationFrame;

  beforeEach(() => {
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    }) as any;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
  });

  it("repaints after async image load completion and exportPNG uses the host image loader", async () => {
    const canvas = createCanvas();
    const ctx = canvas.getContext("2d") as any;
    Object.values(ctx).forEach((value) => {
      if (typeof value === "function" && "mockClear" in value) {
        value.mockClear();
      }
    });

    const loader = vi
      .fn<(_: string) => Promise<ImageBitmap>>()
      .mockResolvedValue({ width: 10, height: 10 } as ImageBitmap);
    const drawfn = new Drawfn({ canvas, getImageBitmap: loader });

    drawfn.add({
      id: "img1",
      type: "image",
      x: 10,
      y: 20,
      w: 100,
      h: 80,
      rotation: 0,
      stroke: "#000000",
      fill: "transparent",
      strokeWidth: 0,
      opacity: 1,
      src: "secure://image",
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(loader).toHaveBeenCalledTimes(1);
    expect(ctx.drawImage).toHaveBeenCalled();

    await drawfn.exportPNG();

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("rejects empty selected-only exports and emits structured export image errors", async () => {
    const canvas = createCanvas();
    const rejectingLoader = vi
      .fn<(_: string) => Promise<ImageBitmap>>()
      .mockRejectedValue(new Error("denied"));
    const drawfn = new Drawfn({ canvas, getImageBitmap: rejectingLoader });
    const errors: DrawfnError[] = [];
    drawfn.on("error", (error) => errors.push(error));

    await expect(
      drawfn.exportPNG({ selectedOnly: true, fitContent: true })
    ).rejects.toMatchObject({
      code: "EXPORT_EMPTY_SELECTION",
      message: "Cannot export an empty selection.",
      recoverable: true,
    });

    expect(errors[0]).toMatchObject({
      code: "EXPORT_EMPTY_SELECTION",
      recoverable: true,
    });

    drawfn.add({
      id: "img1",
      type: "image",
      x: 10,
      y: 20,
      w: 100,
      h: 80,
      rotation: 0,
      stroke: "#000000",
      fill: "transparent",
      strokeWidth: 0,
      opacity: 1,
      src: "secure://image",
    });

    errors.length = 0;

    await expect(drawfn.exportPNG()).rejects.toMatchObject({
      code: "EXPORT_IMAGE_LOAD_FAILED",
      recoverable: true,
    });
    expect(errors[0]).toMatchObject({
      code: "EXPORT_IMAGE_LOAD_FAILED",
      recoverable: true,
    });

    await expect(drawfn.exportSVG({ selectedOnly: true })).rejects.toMatchObject({
      code: "EXPORT_EMPTY_SELECTION",
      recoverable: true,
    });
  });
  it.each(["exportPNG", "exportSVG"] as const)("%s bounds scaled viewport and fitted dimensions before encoding", async (method) => {
    const drawfn = new Drawfn({ canvas: createCanvas() });
    const errors: DrawfnError[] = [];
    drawfn.on("error", error => errors.push(error));
    const create = vi.spyOn(document, "createElement");
    try {
      for (const scale of [8193 / 800, Number.MAX_VALUE]) {
        await expect(drawfn[method]({ scale })).rejects.toMatchObject({ code: "EXPORT_RENDER_FAILED", recoverable: true });
      }
      expect(create).not.toHaveBeenCalled();
      await expect(drawfn[method]({ scale: 8192 / 800 })).resolves.toBeDefined();
      drawfn.add({ id: "wide", type: "rectangle", x: 0, y: 0, w: 8192, h: 10, rotation: 0, stroke: "black", fill: "white", strokeWidth: 0, opacity: 1 });
      await expect(drawfn[method]({ fitContent: true, padding: 0, scale: 1 })).resolves.toBeDefined();
      await expect(drawfn[method]({ fitContent: true, padding: 0.5, scale: 1 })).rejects.toMatchObject({ code: "EXPORT_RENDER_FAILED" });
      expect(errors).toHaveLength(3);
    } finally { create.mockRestore(); drawfn.destroy(); }
  });

  it.each(["throw", "null"])("reports PNG %s encoding failures through the error event and rejection", async (failure) => {
    const drawfn = new Drawfn({ canvas: createCanvas() });
    const errors: DrawfnError[] = [];
    drawfn.on("error", error => errors.push(error));
    const encode = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => {
      if (failure === "throw") throw new DOMException("Tainted canvas", "SecurityError");
      callback(null);
    });
    try {
      await expect(drawfn.exportPNG()).rejects.toMatchObject({ code: "EXPORT_RENDER_FAILED", recoverable: true });
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe("EXPORT_RENDER_FAILED");
    } finally { encode.mockRestore(); drawfn.destroy(); }
  });

});

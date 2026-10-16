import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FreeDrawElement } from "../src/types";
import { Drawfn } from "../src/drawfn";

import { createCanvas } from "../../testing/create-canvas";

describe("freedraw normalization", () => {
  let canvas: HTMLCanvasElement;
  let drawfn: Drawfn;

  beforeEach(() => {
    canvas = createCanvas();
    drawfn = new Drawfn({ canvas });
  });

  it("stores newly created pen strokes with element-local points", () => {
    drawfn.setTool("pen");

    (drawfn as any).handlePointerDown({
      target: canvas,
      clientX: 100,
      clientY: 120,
      pressure: 0.3,
    } as PointerEvent);
    (drawfn as any).handlePointerMove({
      target: canvas,
      clientX: 110,
      clientY: 125,
      pressure: 0.5,
    } as PointerEvent);
    (drawfn as any).handlePointerUp({
      target: canvas,
      clientX: 110,
      clientY: 125,
      pressure: 0.5,
    } as PointerEvent);

    const freedraw = drawfn.getScene().elements[0] as FreeDrawElement;

    expect(freedraw.type).toBe("freedraw");
    expect(freedraw.x).toBe(100);
    expect(freedraw.y).toBe(120);
    expect(freedraw.points).toEqual([
      [0, 0, 0.3],
      [10, 5, 0.5],
    ]);
    expect(freedraw.w).toBe(10);
    expect(freedraw.h).toBe(5);
  });

  it("normalizes the known legacy freedraw corruption pattern during tolerant load", () => {
    const result = drawfn.loadScene({
      version: 1,
      id: "legacy-freedraw",
      camera: { x: 0, y: 0, zoom: 1 },
      background: { color: "#ffffff" },
      elements: [
        {
          id: "fd1",
          type: "freedraw",
          x: 100,
          y: 120,
          w: 90,
          h: 115,
          rotation: 0,
          stroke: "#000000",
          fill: "transparent",
          strokeWidth: 2,
          opacity: 1,
          points: [
            [100, 120, 0.3],
            [10, 5, 0.5],
          ],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected normalized freedraw scene.");
    }

    const freedraw = result.data.elements[0] as FreeDrawElement;
    expect(freedraw.points).toEqual([
      [0, 0, 0.3],
      [10, 5, 0.5],
    ]);
    expect(freedraw.w).toBe(10);
    expect(freedraw.h).toBe(5);
  });

  it("rejects irreparable mixed-basis freedraw points deterministically", () => {
    const result = drawfn.loadScene({
      version: 1,
      id: "scene_mixed",
      camera: { x: 0, y: 0, zoom: 1 },
      background: { color: "#ffffff" },
      elements: [
        {
          id: "fd1",
          type: "freedraw",
          x: 100,
          y: 120,
          w: 20,
          h: 10,
          rotation: 0,
          stroke: "#000000",
          fill: "transparent",
          strokeWidth: 2,
          opacity: 1,
          points: [
            [100, 120],
            [10, 5],
            [140, 160],
          ],
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected invalid freedraw scene.");
    }

    expect(result.error.code).toBe("INVALID_SCENE");
  });

  it("renderer and SVG export interpret freedraw points in the same coordinate basis", async () => {
    const ctx = canvas.getContext("2d") as any;
    ctx.moveTo.mockClear();
    ctx.lineTo.mockClear();

    drawfn.load({
      version: 1,
      id: "scene_svg",
      camera: { x: 0, y: 0, zoom: 1 },
      background: { color: "#ffffff" },
      elements: [
        {
          id: "fd1",
          type: "freedraw",
          x: 100,
          y: 120,
          w: 10,
          h: 5,
          rotation: 0,
          stroke: "#000000",
          fill: "transparent",
          strokeWidth: 2,
          opacity: 1,
          points: [
            [0, 0, 0.3],
            [10, 5, 0.5],
          ],
          style: {
            size: 4,
            thinning: 0.5,
            smoothing: 0.5,
            streamline: 0.5,
          },
        },
      ],
    });

    (drawfn as any).renderer.render(drawfn.getScene());
    const svg = await drawfn.exportSVG();
    const match = svg.match(/M ([^ ]+) ([^ ]+)/);

    expect(match).not.toBeNull();
    expect(ctx.moveTo).toHaveBeenCalled();

    const [renderX, renderY] = ctx.moveTo.mock.calls[0];
    expect(renderX).toBeCloseTo(Number(match![1]), 5);
    expect(renderY).toBeCloseTo(Number(match![2]), 5);
  });
});

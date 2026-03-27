import { beforeEach, describe, expect, it, vi } from "vitest";
import { Renderer } from "../src/renderer";
import type { Scene } from "../src/types";

function createCanvas(width = 100, height = 100): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function rectangleScene(): Scene {
  return {
    version: 1,
    id: "scene",
    camera: { x: 0, y: 0, zoom: 1 },
    background: { color: "#ffffff" },
    elements: [],
  };
}

describe("renderer rotation and locking", () => {
  let canvas: HTMLCanvasElement;
  let ctx: any;

  beforeEach(() => {
    canvas = createCanvas();
    ctx = canvas.getContext("2d") as any;
    Object.values(ctx).forEach((value) => {
      if (typeof value === "function" && "mockClear" in value) {
        value.mockClear();
      }
    });
  });

  it("renders locked elements and culls rotated elements using oriented bounds", () => {
    const renderer = new Renderer(canvas);
    const scene = rectangleScene();
    scene.elements = [
      {
        id: "locked",
        type: "rectangle",
        x: 10,
        y: 10,
        w: 20,
        h: 20,
        rotation: 0,
        stroke: "#000000",
        fill: "transparent",
        strokeWidth: 2,
        opacity: 1,
        locked: true,
      },
      {
        id: "rotated",
        type: "rectangle",
        x: 110,
        y: 10,
        w: 10,
        h: 100,
        rotation: Math.PI / 4,
        stroke: "#000000",
        fill: "transparent",
        strokeWidth: 2,
        opacity: 1,
      },
    ];

    renderer.render(scene);

    expect(ctx.strokeRect).toHaveBeenCalledWith(10, 10, 20, 20);
    expect(ctx.rotate).toHaveBeenCalledWith(Math.PI / 4);
  });

  it("renders rotated selection chrome with zoom-normalized handles", () => {
    canvas = createCanvas(400, 400);
    ctx = canvas.getContext("2d") as any;
    Object.values(ctx).forEach((value) => {
      if (typeof value === "function" && "mockClear" in value) {
        value.mockClear();
      }
    });

    const renderer = new Renderer(canvas);
    const scene = rectangleScene();
    scene.camera.zoom = 2;
    scene.elements = [
      {
        id: "rotated",
        type: "rectangle",
        x: 100,
        y: 100,
        w: 120,
        h: 60,
        rotation: 0.7853981634,
        stroke: "#000000",
        fill: "transparent",
        strokeWidth: 2,
        opacity: 1,
      },
    ];

    renderer.render(scene, { selectedIds: new Set(["rotated"]) });

    expect(ctx.strokeRect).not.toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      124,
      64
    );
    expect(ctx.moveTo).toHaveBeenCalled();
    expect(ctx.lineTo).toHaveBeenCalled();

    const handleRects = ctx.fillRect.mock.calls.filter(
      (call: any[]) => call[2] === 3 && call[3] === 3
    );
    expect(handleRects.length).toBeGreaterThan(0);
  });
});

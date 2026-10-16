import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Scene } from "../src/types";
import { Drawfn } from "../src/drawfn";

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = 600;
  canvas.getBoundingClientRect = vi.fn(() => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    toJSON: () => ({}),
  })) as any;
  return canvas;
}

function rectangleScene(): Scene {
  return {
    version: 1,
    id: "scene_hist",
    camera: { x: 0, y: 0, zoom: 1 },
    background: { color: "#ffffff" },
    elements: [
      {
        id: "rect1",
        type: "rectangle",
        x: 10,
        y: 20,
        w: 100,
        h: 50,
        rotation: 0,
        stroke: "#000000",
        fill: "transparent",
        strokeWidth: 2,
        opacity: 1,
      },
    ],
  };
}

describe("interaction history", () => {
  let canvas: HTMLCanvasElement;
  let drawfn: Drawfn;

  beforeEach(() => {
    canvas = createCanvas();
    drawfn = new Drawfn({ canvas });
  });

  it("creates exactly one undo snapshot for a drag gesture, even across many pointer moves", () => {
    drawfn.load(rectangleScene());

    const historyEvents: Array<{ canUndo: boolean; canRedo: boolean; depth: number }> = [];
    drawfn.on("historyChanged", (event) => historyEvents.push(event));

    (drawfn as any).handlePointerDown({
      target: canvas,
      pointerId: 1,
      clientX: 20,
      clientY: 30,
      shiftKey: false,
    } as PointerEvent);

    for (let step = 1; step <= 10; step += 1) {
      (drawfn as any).handlePointerMove({
        target: canvas,
        pointerId: 1,
        clientX: 20 + step * 2,
        clientY: 30 + step,
      } as PointerEvent);
    }

    (drawfn as any).handlePointerUp({
      target: canvas,
      pointerId: 1,
      clientX: 40,
      clientY: 40,
    } as PointerEvent);

    expect(historyEvents).toHaveLength(1);
    expect(historyEvents[0]).toEqual({ canUndo: true, canRedo: false, depth: 1 });
    expect(drawfn.getElementById("rect1")).toMatchObject({ x: 30, y: 30 });

    drawfn.undo();
    expect(drawfn.getElementById("rect1")).toMatchObject({ x: 10, y: 20 });
  });

  it("creates exactly one undo snapshot for a pen stroke", () => {
    const historyEvents: Array<{ canUndo: boolean; canRedo: boolean; depth: number }> = [];
    drawfn.on("historyChanged", (event) => historyEvents.push(event));

    drawfn.setTool("pen");
    (drawfn as any).handlePointerDown({
      target: canvas,
      pointerId: 1,
      clientX: 100,
      clientY: 120,
      pressure: 0.3,
    } as PointerEvent);
    (drawfn as any).handlePointerMove({
      target: canvas,
      pointerId: 1,
      clientX: 110,
      clientY: 125,
      pressure: 0.5,
    } as PointerEvent);
    (drawfn as any).handlePointerUp({
      target: canvas,
      pointerId: 1,
      clientX: 110,
      clientY: 125,
      pressure: 0.5,
    } as PointerEvent);

    expect(historyEvents).toHaveLength(1);
    expect(historyEvents[0]).toEqual({ canUndo: true, canRedo: false, depth: 1 });
    expect(drawfn.getScene().elements).toHaveLength(1);

    drawfn.undo();
    expect(drawfn.getScene().elements).toEqual([]);
  });

  it("creates exactly one undo snapshot for a resize gesture", () => {
    drawfn.load(rectangleScene());
    drawfn.setSelection(["rect1"]);

    const historyEvents: Array<{ canUndo: boolean; canRedo: boolean; depth: number }> = [];
    drawfn.on("historyChanged", (event) => historyEvents.push(event));

    (drawfn as any).handlePointerDown({
      target: canvas,
      pointerId: 1,
      clientX: 110,
      clientY: 70,
      shiftKey: false,
    } as PointerEvent);
    (drawfn as any).handlePointerMove({
      target: canvas,
      pointerId: 1,
      clientX: 130,
      clientY: 90,
    } as PointerEvent);
    (drawfn as any).handlePointerUp({
      target: canvas,
      pointerId: 1,
      clientX: 130,
      clientY: 90,
    } as PointerEvent);

    expect(historyEvents).toHaveLength(1);
    expect(drawfn.getElementById("rect1")).toMatchObject({ w: 120, h: 70 });

    drawfn.undo();
    expect(drawfn.getElementById("rect1")).toMatchObject({ w: 100, h: 50 });
  });

  it("creates zero undo snapshots for a no-op click gesture", () => {
    drawfn.load(rectangleScene());

    const historyEvents: Array<{ canUndo: boolean; canRedo: boolean; depth: number }> = [];
    drawfn.on("historyChanged", (event) => historyEvents.push(event));

    (drawfn as any).handlePointerDown({
      target: canvas,
      pointerId: 1,
      clientX: 20,
      clientY: 30,
      shiftKey: false,
    } as PointerEvent);
    (drawfn as any).handlePointerUp({
      target: canvas,
      pointerId: 1,
      clientX: 20,
      clientY: 30,
      shiftKey: false,
    } as PointerEvent);

    expect(historyEvents).toHaveLength(0);
    expect(drawfn.getElementById("rect1")).toMatchObject({ x: 10, y: 20 });
  });
});

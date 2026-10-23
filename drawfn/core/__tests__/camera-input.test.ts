import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneChangeReason } from "../src/types";
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

describe("camera and input safety", () => {
  let canvas: HTMLCanvasElement;
  let drawfn: Drawfn;

  beforeEach(() => {
    canvas = createCanvas();
    drawfn = new Drawfn({ canvas });
  });

  it("keeps the pre-zoom canvas point under the cursor invariant", () => {
    drawfn.setCamera({ x: 50, y: 20, zoom: 2 });

    const before = drawfn.screenToCanvas({ x: 100, y: 120 });

    (drawfn as any).handleWheel({
      deltaY: -100,
      clientX: 100,
      clientY: 120,
      preventDefault: vi.fn(),
    } as WheelEvent);

    const after = drawfn.screenToCanvas({ x: 100, y: 120 });

    expect(before.x).toBeCloseTo(25, 5);
    expect(before.y).toBeCloseTo(50, 5);
    expect(after.x).toBeCloseTo(before.x, 5);
    expect(after.y).toBeCloseTo(before.y, 5);
  });

  it("temporarily switches to pan on space and restores the previous tool on release", () => {
    drawfn.setTool("rectangle");

    (drawfn as any).handleKeyDown({
      key: " ",
      target: canvas,
      preventDefault: vi.fn(),
    } as KeyboardEvent);
    expect(drawfn.getTool()).toBe("pan");

    (drawfn as any).handleKeyUp({
      key: " ",
      target: canvas,
    } as KeyboardEvent);
    expect(drawfn.getTool()).toBe("rectangle");
  });

  it("ignores destructive shortcuts while editing text or when focus is outside drawfn", () => {
    drawfn.add({
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
    });
    drawfn.setSelection(["rect1"]);

    const textarea = document.createElement("textarea");
    (drawfn as any).handleKeyDown({
      key: "Backspace",
      target: textarea,
    } as KeyboardEvent);
    expect(drawfn.getScene().elements).toHaveLength(1);

    const input = document.createElement("input");
    input.type = "text";
    (drawfn as any).handleKeyDown({
      key: "Delete",
      target: input,
    } as KeyboardEvent);
    expect(drawfn.getScene().elements).toHaveLength(1);
  });

  it("emits sceneChanged for load, clear, reorder, undo, redo, and camera changes", () => {
    const reasons: SceneChangeReason[] = [];
    drawfn.on("sceneChanged", (event) => reasons.push(event.reason));

    drawfn.load({
      version: 1,
      id: "scene_reasons",
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
        {
          id: "rect2",
          type: "rectangle",
          x: 150,
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
    });

    drawfn.setCamera({ x: 20 });
    drawfn.bringToFront("rect1");
    drawfn.undo();
    drawfn.redo();
    drawfn.clear();

    expect(reasons).toEqual([
      "load",
      "camera",
      "reorder",
      "undo",
      "redo",
      "clear",
    ]);
  });
});

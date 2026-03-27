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

describe("selection and event semantics", () => {
  let canvas: HTMLCanvasElement;
  let drawfn: Drawfn;

  beforeEach(() => {
    canvas = createCanvas();
    drawfn = new Drawfn({ canvas });
  });

  it("emits element, history, and scene events in order for direct content mutations", () => {
    const events: string[] = [];
    drawfn.on("elementAdded", () => events.push("elementAdded"));
    drawfn.on("historyChanged", () => events.push("historyChanged"));
    drawfn.on("sceneChanged", () => events.push("sceneChanged"));

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

    expect(events).toEqual(["elementAdded", "historyChanged", "sceneChanged"]);
  });

  it("emits selectionChanged for pointer selection and does not emit sceneChanged", () => {
    drawfn.load({
      version: 1,
      id: "scene_select",
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
    });

    const selections: string[][] = [];
    const sceneReasons: SceneChangeReason[] = [];

    drawfn.on("selectionChanged", (ids) => selections.push(ids));
    drawfn.on("sceneChanged", (event) => sceneReasons.push(event.reason));

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

    expect(selections).toEqual([["rect1"]]);
    expect(sceneReasons).toEqual([]);
  });

  it("uses bounds intersection for marquee selection", () => {
    drawfn.load({
      version: 1,
      id: "scene_marquee",
      camera: { x: 0, y: 0, zoom: 1 },
      background: { color: "#ffffff" },
      elements: [
        {
          id: "a",
          type: "rectangle",
          x: 0,
          y: 0,
          w: 100,
          h: 100,
          rotation: 0,
          stroke: "#000000",
          fill: "transparent",
          strokeWidth: 2,
          opacity: 1,
        },
        {
          id: "b",
          type: "rectangle",
          x: 200,
          y: 0,
          w: 100,
          h: 100,
          rotation: 0,
          stroke: "#000000",
          fill: "transparent",
          strokeWidth: 2,
          opacity: 1,
        },
      ],
    });

    (drawfn as any).handlePointerDown({
      target: canvas,
      pointerId: 1,
      clientX: 90,
      clientY: -10,
      shiftKey: false,
    } as PointerEvent);
    (drawfn as any).handlePointerMove({
      target: canvas,
      pointerId: 1,
      clientX: 120,
      clientY: 20,
      shiftKey: false,
    } as PointerEvent);
    (drawfn as any).handlePointerUp({
      target: canvas,
      pointerId: 1,
      clientX: 120,
      clientY: 20,
      shiftKey: false,
    } as PointerEvent);

    expect(drawfn.getSelectedIds()).toEqual(["a"]);
  });

  it("commits active drags on window pointerup outside the canvas and clears drag state", () => {
    drawfn.load({
      version: 1,
      id: "scene_drag",
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
    });

    (drawfn as any).handlePointerDown({
      target: canvas,
      pointerId: 1,
      clientX: 20,
      clientY: 30,
      shiftKey: false,
    } as PointerEvent);
    (drawfn as any).handlePointerMove({
      target: canvas,
      pointerId: 1,
      clientX: 40,
      clientY: 40,
    } as PointerEvent);
    (drawfn as any).handleWindowPointerUp({
      target: document.body,
      pointerId: 1,
      clientX: 40,
      clientY: 40,
    } as PointerEvent);

    expect(drawfn.getElementById("rect1")).toMatchObject({ x: 30, y: 30 });

    (drawfn as any).handlePointerMove({
      target: canvas,
      pointerId: 1,
      clientX: 60,
      clientY: 60,
    } as PointerEvent);

    expect(drawfn.getElementById("rect1")).toMatchObject({ x: 30, y: 30 });
  });
});

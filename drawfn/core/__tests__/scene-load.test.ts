import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DrawfnError, Scene } from "../src/types";
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

function rectangle(id: string) {
  return {
    id,
    type: "rectangle" as const,
    x: 10,
    y: 20,
    w: 100,
    h: 50,
    rotation: 0,
    stroke: "#000000",
    fill: "transparent" as const,
    strokeWidth: 2,
    opacity: 1,
  };
}

describe("scene loading", () => {
  let canvas: HTMLCanvasElement;
  let drawfn: Drawfn;

  beforeEach(() => {
    canvas = createCanvas();
    drawfn = new Drawfn({ canvas });
  });

  it("loadScene normalizes a valid version-1 scene and drops unknown fields outside meta", () => {
    const result = drawfn.loadScene({
      version: 1,
      id: "scene_ok",
      camera: { x: 0, y: 0, zoom: 9 },
      background: { color: "#ffffff" },
      elements: [
        {
          ...rectangle("rect1"),
          meta: { keep: true, nested: { ok: true } },
          extraField: "drop-me",
        },
      ],
      topLevelNoise: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected normalized scene result.");
    }

    expect(result.data).toEqual({
      version: 1,
      id: "scene_ok",
      camera: { x: 0, y: 0, zoom: 5 },
      background: { color: "#ffffff" },
      elements: [
        {
          ...rectangle("rect1"),
          meta: { keep: true, nested: { ok: true } },
        },
      ],
    });
    expect(drawfn.getScene()).toEqual(result.data);
    expect((result.data as Record<string, unknown>).topLevelNoise).toBeUndefined();
    expect((result.data.elements[0] as Record<string, unknown>).extraField).toBeUndefined();
  });

  it("load deep-clones, normalizes, clears selection, and clears history", () => {
    const historyChanged: Array<{ canUndo: boolean; canRedo: boolean; depth: number }> = [];
    const selectionChanged: string[][] = [];

    drawfn.on("historyChanged", (state) => historyChanged.push(state));
    drawfn.on("selectionChanged", (ids) => selectionChanged.push(ids));

    drawfn.add(rectangle("before-load"));
    drawfn.setSelection(["before-load"]);

    const scene: Scene = {
      version: 1,
      id: "loaded-scene",
      camera: { x: 12, y: -5, zoom: 9 },
      background: { color: "#ffffff" },
      elements: [],
    };

    drawfn.load(scene);

    scene.id = "mutated-after-load";
    scene.camera.zoom = 0.1;
    scene.background.color = "#000000";

    expect(drawfn.getScene()).toEqual({
      version: 1,
      id: "loaded-scene",
      camera: { x: 12, y: -5, zoom: 5 },
      background: { color: "#ffffff" },
      elements: [],
    });
    expect(drawfn.getSelectedIds()).toEqual([]);
    expect(selectionChanged[selectionChanged.length - 1]).toEqual([]);
    expect(historyChanged[historyChanged.length - 1]).toEqual({
      canUndo: false,
      canRedo: false,
      depth: 0,
    });

    drawfn.undo();
    expect(drawfn.getScene().id).toBe("loaded-scene");
    expect(drawfn.getScene().elements).toEqual([]);
  });

  it("loadScene rejects unsupported versions without mutating active scene and emits error", () => {
    drawfn.add(rectangle("keep"));
    const before = drawfn.getScene();
    const errors: DrawfnError[] = [];

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    drawfn.on("error", (error) => errors.push(error));

    const result = drawfn.loadScene({
      version: 2,
      id: "scene_bad",
      elements: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected invalid scene result.");
    }

    expect(result.error).toEqual({
      code: "UNSUPPORTED_SCENE_VERSION",
      message: "Scene version 2 is not supported.",
      details: { version: 2 },
      recoverable: true,
    });
    expect(errors[errors.length - 1]).toEqual(result.error);
    expect(drawfn.getScene()).toEqual(before);
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();

    consoleError.mockRestore();
    consoleWarn.mockRestore();
    consoleLog.mockRestore();
  });

  it("loadScene rejects malformed shapes without mutating the active scene", () => {
    drawfn.add(rectangle("keep"));
    const before = drawfn.getScene();

    const result = drawfn.loadScene({
      version: 1,
      id: "scene_bad",
      camera: { x: 0, y: 0, zoom: "abc" },
      background: { color: "#ffffff" },
      elements: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected invalid scene result.");
    }

    expect(result.error.code).toBe("INVALID_SCENE");
    expect(drawfn.getScene()).toEqual(before);
  });

  it("loadScene rejects scenes that exceed the element cap", () => {
    const elements = Array.from({ length: 2001 }, (_, index) => ({
      ...rectangle(`rect-${index}`),
      x: index,
    }));

    const result = drawfn.loadScene({
      version: 1,
      id: "too-many-elements",
      camera: { x: 0, y: 0, zoom: 1 },
      background: { color: "#ffffff" },
      elements,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected cap violation result.");
    }

    expect(result.error).toEqual({
      code: "SCENE_LIMIT_EXCEEDED",
      message: "Scenes cannot exceed 2000 elements.",
      details: { limit: 2000, actual: 2001 },
      recoverable: true,
    });
  });
});

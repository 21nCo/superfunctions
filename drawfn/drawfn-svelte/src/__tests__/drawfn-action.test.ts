import { get } from "svelte/store";
import { Drawfn, type Scene } from "drawfn";
import { describe, expect, it, vi } from "vitest";
import { drawfn } from "../drawfn-action";
import { createDrawfnStore } from "../stores";

function createScene(): Scene {
  return {
    version: 1,
    id: "scene-1",
    camera: { x: 0, y: 0, zoom: 1 },
    background: { color: "#ffffff" },
    elements: [
      {
        id: "rect1",
        type: "rectangle",
        x: 10,
        y: 20,
        w: 80,
        h: 40,
        rotation: 0,
        stroke: "#000000",
        fill: "transparent",
        strokeWidth: 2,
        opacity: 1,
      },
    ],
  };
}

function rectangle(id: string) {
  return {
    id,
    type: "rectangle" as const,
    x: 10,
    y: 20,
    w: 80,
    h: 40,
    rotation: 0,
    stroke: "#000000",
    fill: "transparent" as const,
    strokeWidth: 2,
    opacity: 1,
  };
}

describe("drawfn svelte action and store", () => {
  it("uses sceneChanged for action callbacks and suppresses deep-equal controlled echoes", () => {
    const canvas = document.createElement("canvas");
    const onReady = vi.fn<(drawfn: Drawfn) => void>();
    const onSceneChange = vi.fn();
    const loadSpy = vi.spyOn(Drawfn.prototype, "load");
    const scene = createScene();

    const action = drawfn(canvas, {
      scene,
      onReady,
      onSceneChange,
    });

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(loadSpy).toHaveBeenCalledTimes(1);

    const instance = onReady.mock.calls[0]?.[0] as Drawfn;
    instance.setCamera({ x: 120 });

    expect(onSceneChange).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ reason: "camera" })
    );

    action.update({
      scene: JSON.parse(JSON.stringify(instance.getScene())),
      onReady,
      onSceneChange,
    });

    expect(loadSpy).toHaveBeenCalledTimes(1);

    action.destroy();
    loadSpy.mockRestore();
  });

  it("keeps store state synchronized through sceneChanged, historyChanged, and selectionChanged", () => {
    const canvas = document.createElement("canvas");
    const instance = new Drawfn({ canvas });
    const store = createDrawfnStore();

    store.setInstance(instance);

    instance.add(rectangle("rect1"));
    instance.setCamera({ x: 48 });
    instance.setSelection(["rect1"]);

    const state = get(store);
    expect(state.elementCount).toBe(1);
    expect(state.camera.x).toBe(48);
    expect(state.canUndo).toBe(true);
    expect(state.selectedIds).toEqual(["rect1"]);

    store.destroy();

    const destroyed = get(store);
    expect(destroyed.instance).toBeNull();
    expect(destroyed.isReady).toBe(false);
  });
});

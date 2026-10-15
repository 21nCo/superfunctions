import { get } from "svelte/store";
import { Drawfn, type Scene } from "drawfn";
import { describe, expect, it, vi } from "vitest";
import { drawfn } from "../src/drawfn-action";
import { createDrawfnStore } from "../src/stores";

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

it("rebuilds constructor resources while retaining uncontrolled content and current integration callbacks", async () => {
  const canvas = document.createElement('canvas');
  const onReady = vi.fn();
  const preview = vi.fn(async () => ({ title: 'preview' }));
  const action = drawfn(canvas, { onReady });
  const first = onReady.mock.lastCall![0] as Drawfn;
  first.add(rectangle('retained'));
  action.update({ onReady, overlayRoot: document.createElement('div'), getNodePreview: preview });
  expect(onReady).toHaveBeenCalledTimes(2);
  const replacement = onReady.mock.lastCall![0] as Drawfn;
  expect(replacement).not.toBe(first);
  expect(replacement.getElementById('retained')).toBeTruthy();
  replacement.add({ ...rectangle('node'), type: 'node', nodeId: 'remote', variant: 'card' });
  await Promise.resolve();
  expect(preview).toHaveBeenCalledWith('remote');
  action.destroy();
  action.destroy();
});


it("initializes store history from the attached instance and unsubscribes on replacement", () => {
  const canvas = document.createElement("canvas"); const instance = new Drawfn({ canvas });
  instance.add(rectangle("first")); const store = createDrawfnStore(); store.setInstance(instance);
  expect(get(store).canUndo).toBe(true); instance.undo(); expect(get(store).canRedo).toBe(true);
  const next = new Drawfn({ canvas: document.createElement("canvas") }); store.setInstance(next);
  expect(get(store).canUndo).toBe(false); expect(get(store).canRedo).toBe(false);
  instance.redo(); expect(get(store).elementCount).toBe(0); store.destroy(); instance.destroy();
});

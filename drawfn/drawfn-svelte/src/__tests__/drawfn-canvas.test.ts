import { render, waitFor } from "@testing-library/svelte";
import { Drawfn, type Scene } from "drawfn";
import { describe, expect, it, vi } from "vitest";
import Canvas from "../Canvas.svelte";
import DrawfnCanvas from "../DrawfnCanvas.svelte";

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

describe("DrawfnCanvas.svelte", () => {
  it("resolves and mounts Canvas.svelte and DrawfnCanvas.svelte with the shipped API surface", () => {
    const canvasView = render(Canvas, {
      width: 320,
      height: 240,
      class: "plain-canvas",
    });
    const drawfnView = render(DrawfnCanvas, {
      width: 320,
      height: 240,
    });

    expect(canvasView.container.querySelector("canvas")).toBeTruthy();
    expect(drawfnView.container.querySelector("canvas")).toBeTruthy();
  });

  it("mounts cleanly, calls onReady once, forwards sceneChanged meta, and suppresses deep-equal scene echoes", async () => {
    const loadSpy = vi.spyOn(Drawfn.prototype, "load");
    const onReady = vi.fn<(drawfn: Drawfn) => void>();
    const onSceneChange = vi.fn();
    const scene = createScene();

    const view = render(DrawfnCanvas, {
      scene,
      onReady,
      onSceneChange,
      width: 640,
      height: 480,
    });

    await waitFor(() => {
      expect(onReady).toHaveBeenCalledTimes(1);
    });
    expect(loadSpy).toHaveBeenCalledTimes(1);

    const instance = onReady.mock.calls[0]?.[0] as Drawfn;
    instance.setCamera({ x: 96 });

    await waitFor(() => {
      expect(onSceneChange).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ reason: "camera" })
      );
    });

    await view.rerender({
      scene: JSON.parse(JSON.stringify(instance.getScene())),
      onReady,
      onSceneChange,
      width: 640,
      height: 480,
    });

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    loadSpy.mockRestore();
  });
});

import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { Drawfn, type Scene } from "drawfn";
import { describe, expect, it, vi } from "vitest";
import { useDrawfn, type UseDrawfnResult, type UseDrawfnOptions } from "../use-drawfn";

function createScene(): Scene {
  return {
    version: 1,
    id: "scene-1",
    camera: { x: 0, y: 0, zoom: 1 },
    background: { color: "#ffffff" },
    elements: [
      {
        id: "rect-1",
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

function HookHarness(props: UseDrawfnOptions & {
  scene?: Scene;
  onSceneChange?: (scene: Scene, meta?: any) => void;
  onReady?: (value: UseDrawfnResult) => void;
}) {
  const drawfn = useDrawfn(props);

  React.useEffect(() => {
    if (drawfn.isReady && props.onReady) {
      props.onReady(drawfn);
    }
  }, [drawfn.drawfn, drawfn.isReady, props.onReady]);

  return <canvas ref={drawfn.canvasRef} width={800} height={600} />;
}

describe("useDrawfn", () => {
  it("suppresses deep-equal controlled scene echoes without reloading", async () => {
    const loadSpy = vi.spyOn(Drawfn.prototype, "load");
    let readyApi: UseDrawfnResult | null = null;

    function ControlledHarness() {
      const [scene, setScene] = React.useState<Scene>(createScene());
      return (
        <HookHarness
          scene={scene}
          onReady={(value) => {
            readyApi = value;
          }}
          onSceneChange={(nextScene) => {
            setScene(nextScene);
          }}
        />
      );
    }

    render(<ControlledHarness />);

    await waitFor(() => {
      expect(readyApi?.drawfn).toBeTruthy();
    });
    expect(loadSpy).toHaveBeenCalledTimes(1);

    act(() => {
      readyApi?.drawfn?.clear();
    });

    await waitFor(() => {
      expect(readyApi?.drawfn?.getScene().elements).toHaveLength(0);
    });
    expect(loadSpy).toHaveBeenCalledTimes(1);
    loadSpy.mockRestore();
  });

  it("propagates camera, undo, and redo through onSceneChange meta from sceneChanged", async () => {
    let readyApi: UseDrawfnResult | null = null;
    const reasons: Array<string | undefined> = [];

    render(
      <HookHarness
        onReady={(value) => {
          readyApi = value;
        }}
        onSceneChange={(_scene, meta) => {
          reasons.push(meta?.reason);
        }}
      />
    );

    await waitFor(() => {
      expect(readyApi?.drawfn).toBeTruthy();
    });

    act(() => {
      readyApi?.drawfn?.add(rectangle("rect-2"));
      readyApi?.drawfn?.setCamera({ x: 120 });
      readyApi?.drawfn?.undo();
      readyApi?.drawfn?.redo();
    });

    await waitFor(() => {
      expect(reasons).toContain("camera");
      expect(reasons).toContain("undo");
      expect(reasons).toContain("redo");
    });
  });
});

it("preserves uncontrolled content and publishes the replacement instance when constructor options change", async () => {
  const ready = vi.fn();
  const view = render(<HookHarness onReady={ready} />);
  await waitFor(() => expect(ready).toHaveBeenCalled());
  const first = ready.mock.lastCall![0] as UseDrawfnResult;
  act(() => first.drawfn!.add(rectangle('retained')));
  view.rerender(<HookHarness onReady={ready} overlayRoot={document.createElement('div')} />);
  await waitFor(() => expect(ready.mock.lastCall![0].drawfn).not.toBe(first.drawfn));
  expect(ready.mock.lastCall![0].drawfn.getElementById('retained')).toBeTruthy();
  view.unmount();
});

it("forwards the latest preview callback without replacing the active instance", async () => {
  const ready = vi.fn();
  const initial = vi.fn(async () => ({ title: 'old' }));
  const latest = vi.fn(async () => ({ title: 'new' }));
  const view = render(<HookHarness onReady={ready} getNodePreview={initial} />);
  await waitFor(() => expect(ready).toHaveBeenCalled());
  const instance = ready.mock.lastCall![0].drawfn as Drawfn;
  view.rerender(<HookHarness onReady={ready} getNodePreview={latest} />);
  act(() => instance.add({ ...rectangle('node'), type: 'node', nodeId: 'remote', variant: 'card' }));
  await waitFor(() => expect(latest).toHaveBeenCalledWith('remote'));
  expect(initial).not.toHaveBeenCalled();
  expect(ready.mock.lastCall![0].drawfn).toBe(instance);
  view.unmount();
});

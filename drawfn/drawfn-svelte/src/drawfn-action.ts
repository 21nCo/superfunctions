import {
  Drawfn,
  type DrawfnOptions,
  type Scene,
  type SceneChangedEvent,
} from "drawfn";

export type DrawfnActionOptions = Omit<DrawfnOptions, "canvas"> & {
  scene?: Scene;
  onReady?: (drawfn: Drawfn) => void;
  onSceneChange?: (scene: Scene, meta?: SceneChangedEvent) => void;
};

function scenesAreEqual(left?: Scene, right?: Scene): boolean {
  if (!left || !right) {
    return left === right;
  }

  return JSON.stringify(left) === JSON.stringify(right);
}

export function drawfn(canvas: HTMLCanvasElement, options?: DrawfnActionOptions) {
  let currentOptions = options;
  let instance: Drawfn;
  let unsubscribeSceneChanged: (() => void) | undefined;
  let destroyed = false;
  let lastLoadedSceneKey: string | undefined;

  function create(scene?: Scene): void {
    instance = new Drawfn({
      canvas,
      overlayRoot: currentOptions?.overlayRoot,
      getImageBitmap: currentOptions?.getImageBitmap,
      onNodeClick: (...args) => currentOptions?.onNodeClick?.(...args),
      getNodePreview: currentOptions?.getNodePreview ? (id) => currentOptions?.getNodePreview?.(id) ?? Promise.resolve({}) : undefined,
    });
    unsubscribeSceneChanged = instance.on("sceneChanged", (meta) => {
      currentOptions?.onSceneChange?.(meta.scene, meta);
    });
    if (scene && !scenesAreEqual(instance.getScene(), scene)) instance.load(scene);
    lastLoadedSceneKey = currentOptions?.scene ? JSON.stringify(currentOptions.scene) : undefined;
    currentOptions?.onReady?.(instance);
  }
  create(options?.scene);

  return {
    update(newOptions: DrawfnActionOptions = {}) {
      if (destroyed) return;
      const rebuild = newOptions.overlayRoot !== currentOptions?.overlayRoot ||
        newOptions.getImageBitmap !== currentOptions?.getImageBitmap ||
        Boolean(newOptions.getNodePreview) !== Boolean(currentOptions?.getNodePreview);
      currentOptions = newOptions;
      if (rebuild) {
        const scene = newOptions.scene ?? instance.getScene();
        unsubscribeSceneChanged?.();
        instance.destroy();
        create(scene);
      } else if (newOptions.scene) {
        const key = JSON.stringify(newOptions.scene);
        if (key !== lastLoadedSceneKey && !scenesAreEqual(instance.getScene(), newOptions.scene)) instance.load(newOptions.scene);
        lastLoadedSceneKey = key;
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribeSceneChanged?.();
      instance.destroy();
    },
  };
}

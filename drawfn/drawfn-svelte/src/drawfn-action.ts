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
  const instance = new Drawfn({
    canvas,
    overlayRoot: options?.overlayRoot,
    getImageBitmap: options?.getImageBitmap,
  });
  let currentOptions = options;

  const unsubscribeSceneChanged = instance.on("sceneChanged", (meta) => {
    currentOptions?.onSceneChange?.(meta.scene, meta);
  });

  if (options?.scene && !scenesAreEqual(instance.getScene(), options.scene)) {
    instance.load(options.scene);
  }

  options?.onReady?.(instance);

  return {
    update(newOptions: DrawfnActionOptions) {
      currentOptions = newOptions;

      if (newOptions.scene && !scenesAreEqual(instance.getScene(), newOptions.scene)) {
        instance.load(newOptions.scene);
      }
    },
    destroy() {
      unsubscribeSceneChanged?.();
      instance.destroy();
    },
  };
}

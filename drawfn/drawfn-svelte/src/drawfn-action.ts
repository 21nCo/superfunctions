import { Drawfn, type DrawfnOptions, type Scene } from '@21n/drawfn';

export type DrawfnActionOptions = Omit<DrawfnOptions, 'canvas'> & {
  scene?: Scene;
  onReady?: (drawfn: Drawfn) => void;
  onSceneChange?: (scene: Scene) => void;
};

export function drawfn(canvas: HTMLCanvasElement, options?: DrawfnActionOptions) {
  const instance = new Drawfn({
    canvas,
    overlayRoot: options?.overlayRoot,
    getImageBitmap: options?.getImageBitmap,
  });

  if (options?.scene) {
    instance.load(options.scene);
  }

  // Setup scene change listeners
  let unsubscribers: (() => void)[] = [];
  if (options?.onSceneChange) {
    unsubscribers.push(
      instance.on('elementAdded', () => options.onSceneChange?.(instance.getScene())),
      instance.on('elementUpdated', () => options.onSceneChange?.(instance.getScene())),
      instance.on('elementRemoved', () => options.onSceneChange?.(instance.getScene()))
    );
  }

  // Call onReady
  options?.onReady?.(instance);

  return {
    update(newOptions: DrawfnActionOptions) {
      if (newOptions.scene && newOptions.scene !== options?.scene) {
        instance.load(newOptions.scene);
      }
    },
    destroy() {
      unsubscribers.forEach(unsub => unsub());
      instance.destroy();
    },
  };
}

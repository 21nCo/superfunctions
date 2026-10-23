import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  Drawfn,
  type DrawfnEvent,
  type DrawfnEventMap,
  type DrawfnOptions,
  type Scene,
  type SceneChangedEvent,
  type ToolName,
} from "drawfn";

export type UseDrawfnOptions = Omit<DrawfnOptions, 'canvas'> & {
  scene?: Scene;
  onSceneChange?: (scene: Scene, meta?: SceneChangedEvent) => void;
};

export type UseDrawfnResult = {
  canvasRef: RefObject<HTMLCanvasElement>;
  drawfn: Drawfn | null;
  isReady: boolean;
  setTool(tool: ToolName, opts?: unknown): void;
  getScene(): Scene | undefined;
  undo(): void;
  redo(): void;
  clear(): void;
  exportPNG(options?: Parameters<Drawfn["exportPNG"]>[0]): Promise<Blob | undefined>;
  exportSVG(options?: Parameters<Drawfn["exportSVG"]>[0]): Promise<string | undefined>;
  on<E extends DrawfnEvent>(
    event: E,
    handler: (...args: DrawfnEventMap[E]) => void
  ): (() => void) | undefined;
};

function scenesAreEqual(left?: Scene, right?: Scene): boolean {
  if (!left || !right) {
    return left === right;
  }

  return JSON.stringify(left) === JSON.stringify(right);
}

function serializeScene(scene?: Scene): string | null {
  return scene ? JSON.stringify(scene) : null;
}

export function useDrawfn(options?: UseDrawfnOptions): UseDrawfnResult {
  const canvasRef = useRef<HTMLCanvasElement>(null!);
  const drawfnRef = useRef<Drawfn | null>(null);
  const lastLoadedSceneRef = useRef<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const onSceneChangeRef = useRef(options?.onSceneChange);

  useEffect(() => {
    onSceneChangeRef.current = options?.onSceneChange;
  }, [options?.onSceneChange]);

  useEffect(() => {
    if (!canvasRef.current) return;

    const drawfn = new Drawfn({
      canvas: canvasRef.current,
      overlayRoot: options?.overlayRoot,
      getImageBitmap: options?.getImageBitmap,
    });
    drawfnRef.current = drawfn;

    const unsubscribeSceneChanged = drawfn.on("sceneChanged", (meta: SceneChangedEvent) => {
      onSceneChangeRef.current?.(meta.scene, meta);
    });

    const sceneKey = serializeScene(options?.scene);
    if (options?.scene && !scenesAreEqual(drawfn.getScene(), options.scene)) {
      lastLoadedSceneRef.current = sceneKey;
      drawfn.load(options.scene);
    }

    setIsReady(true);

    return () => {
      unsubscribeSceneChanged?.();
      drawfn.destroy();
      drawfnRef.current = null;
      lastLoadedSceneRef.current = null;
      setIsReady(false);
    };
  }, [options?.overlayRoot, options?.getImageBitmap]);

  useEffect(() => {
    if (!drawfnRef.current || !options?.scene) {
      return;
    }

    const sceneKey = serializeScene(options.scene);
    if (
      sceneKey === lastLoadedSceneRef.current ||
      scenesAreEqual(drawfnRef.current.getScene(), options.scene)
    ) {
      lastLoadedSceneRef.current = sceneKey;
      return;
    }

    lastLoadedSceneRef.current = sceneKey;
    drawfnRef.current.load(options.scene);
  }, [options?.scene]);

  const setTool = useCallback((tool: ToolName, opts?: any) => {
    drawfnRef.current?.setTool(tool, opts);
  }, []);

  const getScene = useCallback(() => {
    return drawfnRef.current?.getScene();
  }, []);

  const undo = useCallback(() => {
    drawfnRef.current?.undo();
  }, []);

  const redo = useCallback(() => {
    drawfnRef.current?.redo();
  }, []);

  const clear = useCallback(() => {
    drawfnRef.current?.clear();
  }, []);

  const exportPNG = useCallback(async (opts?: Parameters<Drawfn['exportPNG']>[0]) => {
    return await drawfnRef.current?.exportPNG(opts);
  }, []);

  const exportSVG = useCallback(async (opts?: Parameters<Drawfn['exportSVG']>[0]) => {
    return await drawfnRef.current?.exportSVG(opts);
  }, []);

  const on = useCallback(<E extends DrawfnEvent>(
    event: E,
    handler: (...args: DrawfnEventMap[E]) => void
  ) => {
    return drawfnRef.current?.on(event, handler);
  }, []);

  return {
    canvasRef,
    drawfn: drawfnRef.current,
    isReady,
    setTool,
    getScene,
    undo,
    redo,
    clear,
    exportPNG,
    exportSVG,
    on,
  };
}

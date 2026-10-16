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
  const [instance, setInstance] = useState<Drawfn | null>(null);
  const retainedSceneRef = useRef<Scene>();
  const integrationRef = useRef(options);
  integrationRef.current = options;
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
      onNodeClick: (...args) => integrationRef.current?.onNodeClick?.(...args),
      getNodePreview: options?.getNodePreview ? (id) => integrationRef.current?.getNodePreview?.(id) ?? Promise.resolve({}) : undefined,
    });
    drawfnRef.current = drawfn;

    const unsubscribeSceneChanged = drawfn.on("sceneChanged", (meta: SceneChangedEvent) => {
      onSceneChangeRef.current?.(meta.scene, meta);
    });

    const initialScene = options?.scene ?? retainedSceneRef.current;
    const sceneKey = serializeScene(initialScene);
    if (initialScene && !scenesAreEqual(drawfn.getScene(), initialScene)) {
      lastLoadedSceneRef.current = sceneKey;
      drawfn.load(initialScene);
    }

    setInstance(drawfn);

    return () => {
      unsubscribeSceneChanged?.();
      retainedSceneRef.current = drawfn.getScene();
      drawfn.destroy();
      drawfnRef.current = null;
      lastLoadedSceneRef.current = null;
      setInstance(null);
    };
  }, [options?.overlayRoot, options?.getImageBitmap, Boolean(options?.getNodePreview)]);

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
    drawfn: instance,
    isReady: instance !== null,
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

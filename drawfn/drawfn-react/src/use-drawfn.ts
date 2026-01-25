import { useEffect, useRef, useState, useCallback } from 'react';
import { Drawfn, type DrawfnOptions, type Scene, type ToolName, type DrawfnEvent, type DrawfnEventMap } from '@21n/drawfn';

export type UseDrawfnOptions = Omit<DrawfnOptions, 'canvas'> & {
  scene?: Scene;
  onSceneChange?: (scene: Scene) => void;
};

export function useDrawfn(options?: UseDrawfnOptions) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawfnRef = useRef<Drawfn | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (!canvasRef.current) return;

    const drawfn = new Drawfn({
      canvas: canvasRef.current,
      overlayRoot: options?.overlayRoot,
      getImageBitmap: options?.getImageBitmap,
    });

    if (options?.scene) {
      drawfn.load(options.scene);
    }

    if (options?.onSceneChange) {
      const unsubscribe = drawfn.on('elementAdded', () => {
        options.onSceneChange?.(drawfn.getScene());
      });

      const unsubscribe2 = drawfn.on('elementUpdated', () => {
        options.onSceneChange?.(drawfn.getScene());
      });

      const unsubscribe3 = drawfn.on('elementRemoved', () => {
        options.onSceneChange?.(drawfn.getScene());
      });

      drawfnRef.current = drawfn;
      setIsReady(true);

      return () => {
        unsubscribe();
        unsubscribe2();
        unsubscribe3();
        drawfn.destroy();
        drawfnRef.current = null;
        setIsReady(false);
      };
    }

    drawfnRef.current = drawfn;
    setIsReady(true);

    return () => {
      drawfn.destroy();
      drawfnRef.current = null;
      setIsReady(false);
    };
  }, [options?.overlayRoot, options?.getImageBitmap]);

  useEffect(() => {
    if (drawfnRef.current && options?.scene) {
      drawfnRef.current.load(options.scene);
    }
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

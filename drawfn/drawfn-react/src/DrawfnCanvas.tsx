import React from 'react';
import { Canvas, type CanvasProps } from './Canvas';
import { useDrawfn, type UseDrawfnOptions } from './use-drawfn';

export type DrawfnCanvasProps = CanvasProps & UseDrawfnOptions & {
  onReady?: (drawfn: ReturnType<typeof useDrawfn>) => void;
};

export function DrawfnCanvas({
  scene,
  onSceneChange,
  overlayRoot,
  getImageBitmap,
  onReady,
  ...canvasProps
}: DrawfnCanvasProps) {
  const drawfn = useDrawfn({
    scene,
    onSceneChange,
    overlayRoot,
    getImageBitmap,
  });

  React.useEffect(() => {
    if (drawfn.isReady && onReady) {
      onReady(drawfn);
    }
  }, [drawfn.isReady, onReady]);

  return <Canvas ref={drawfn.canvasRef} {...canvasProps} />;
}

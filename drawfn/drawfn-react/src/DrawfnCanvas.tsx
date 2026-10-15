import React from "react";
import { Canvas, type CanvasProps } from "./Canvas";
import {
  useDrawfn,
  type UseDrawfnOptions,
  type UseDrawfnResult,
} from "./use-drawfn";

export type DrawfnCanvasProps = CanvasProps & UseDrawfnOptions & {
  onReady?: (value: UseDrawfnResult) => void;
};

export function DrawfnCanvas({
  scene,
  onSceneChange,
  overlayRoot,
  getImageBitmap,
  onNodeClick,
  getNodePreview,
  onReady,
  ...canvasProps
}: DrawfnCanvasProps) {
  const drawfn = useDrawfn({
    scene,
    onSceneChange,
    overlayRoot,
    getImageBitmap,
  onNodeClick,
  getNodePreview,
  });
  const readyInstanceRef = React.useRef<UseDrawfnResult["drawfn"]>(null);

  React.useEffect(() => {
    if (!drawfn.isReady || !drawfn.drawfn || !onReady) {
      return;
    }

    if (readyInstanceRef.current === drawfn.drawfn) {
      return;
    }

    readyInstanceRef.current = drawfn.drawfn;
    onReady(drawfn);
  }, [drawfn.drawfn, drawfn.isReady, onReady]);

  React.useEffect(() => {
    if (!drawfn.isReady) {
      readyInstanceRef.current = null;
    }
  }, [drawfn.isReady]);

  return <Canvas ref={drawfn.canvasRef} {...canvasProps} />;
}

import { BaseTool } from "./base-tool";
import type { ImageElement, ToolContext } from "../types";
import { generateId, screenToCanvas } from "../utils";

export type ImageToolOptions = {
  src: string;
  naturalW?: number;
  naturalH?: number;
};

export class ImageTool extends BaseTool {
  name = "image";
  private pendingImage: ImageToolOptions | null = null;

  activate(opts?: ImageToolOptions): void {
    super.activate(opts);
    if (opts?.src) {
      this.pendingImage = opts;
    }
  }

  handlePointerDown(e: PointerEvent, context: ToolContext): void {
    if (!this.pendingImage) return;

    const canvas = e.target as HTMLCanvasElement;
    const scene = context.getScene();
    const point = screenToCanvas(
      { x: e.clientX, y: e.clientY },
      scene.camera,
      canvas
    );

    context.recordHistory();

    const w = this.pendingImage.naturalW || 200;
    const h = this.pendingImage.naturalH || 150;

    const element: ImageElement = {
      id: generateId(),
      type: "image",
      x: point.x - w / 2,
      y: point.y - h / 2,
      w,
      h,
      rotation: 0,
      stroke: "#000000",
      fill: "transparent",
      strokeWidth: 0,
      opacity: 1,
      src: this.pendingImage.src,
      naturalW: this.pendingImage.naturalW,
      naturalH: this.pendingImage.naturalH,
    };

    context.addElement(element);
    this.pendingImage = null;
  }
}

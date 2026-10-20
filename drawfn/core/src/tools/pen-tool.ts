import { BaseTool } from "./base-tool";
import type { FreeDrawElement, Point, ToolContext } from "../types";
import { generateId, screenToCanvas, MAX_FREEDRAW_POINTS } from "../utils";

export class PenTool extends BaseTool {
  name = "pen";
  private currentElement: FreeDrawElement | null = null;
  private currentElementId: string | null = null;
  private pointLimitReported = false;
  private currentPoints: [number, number, number?][] = [];

  handlePointerDown(e: PointerEvent, context: ToolContext): void {
    const canvas = e.target as HTMLCanvasElement;
    const scene = context.getScene();
    const point = screenToCanvas(
      { x: e.clientX, y: e.clientY },
      scene.camera,
      canvas
    );

    context.getDrawfn().beginGesture("add");

    this.currentPoints = [[0, 0, e.pressure || 0.5]];
    this.pointLimitReported = false;

    this.currentElement = {
      id: generateId(),
      type: "freedraw",
      x: point.x,
      y: point.y,
      w: 1,
      h: 1,
      rotation: 0,
      stroke: "#000000",
      fill: "transparent",
      strokeWidth: 2,
      opacity: 1,
      points: [...this.currentPoints],
      style: {
        size: 4,
        thinning: 0.5,
        smoothing: 0.5,
        streamline: 0.5,
      },
    };

    this.currentElementId = context.addElement(this.currentElement);
  }

  handlePointerMove(e: PointerEvent, context: ToolContext): void {
    if (!this.currentElement || !this.currentElementId) return;

    const canvas = e.target as HTMLCanvasElement;
    const scene = context.getScene();
    const point = screenToCanvas(
      { x: e.clientX, y: e.clientY },
      scene.camera,
      canvas
    );

    if (this.currentPoints.length >= MAX_FREEDRAW_POINTS) {
      if (!this.pointLimitReported) {
        this.pointLimitReported = true;
        // The normal validator emits the structured limit error once. Do not
        // retain the rejected point or keep growing the live gesture buffer.
        context.updateElement(this.currentElementId, {
          points: [...this.currentPoints, [point.x - this.currentElement.x, point.y - this.currentElement.y, e.pressure || 0.5]],
        });
      }
      return;
    }

    this.currentPoints.push([
      point.x - this.currentElement.x,
      point.y - this.currentElement.y,
      e.pressure || 0.5,
    ]);

    const xs = this.currentPoints.map((p) => p[0]);
    const ys = this.currentPoints.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);

    context.updateElement(this.currentElementId, {
      points: this.currentPoints,
      w,
      h,
    });
  }

  handlePointerUp(e: PointerEvent, context: ToolContext): void {
    this.currentElement = null;
    this.currentElementId = null;
    this.currentPoints = [];
    this.pointLimitReported = false;
  }
}

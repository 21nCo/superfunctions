import { BaseTool } from "./base-tool";
import type { RectangleElement, Point, ToolContext } from "../types";
import { generateId, screenToCanvas } from "../utils";

export class RectangleTool extends BaseTool {
  name = "rectangle";
  private startPoint: Point | null = null;
  private currentElementId: string | null = null;

  handlePointerDown(e: PointerEvent, context: ToolContext): void {
    const canvas = e.target as HTMLCanvasElement;
    const scene = context.getScene();
    this.startPoint = screenToCanvas(
      { x: e.clientX, y: e.clientY },
      scene.camera,
      canvas
    );

    context.getDrawfn().beginGesture("add");

    const element: RectangleElement = {
      id: generateId(),
      type: "rectangle",
      x: this.startPoint.x,
      y: this.startPoint.y,
      w: 0,
      h: 0,
      rotation: 0,
      stroke: "#000000",
      fill: "transparent",
      strokeWidth: 2,
      opacity: 1,
    };

    this.currentElementId = context.addElement(element);
  }

  handlePointerMove(e: PointerEvent, context: ToolContext): void {
    if (!this.startPoint || !this.currentElementId) return;

    const canvas = e.target as HTMLCanvasElement;
    const scene = context.getScene();
    const point = screenToCanvas(
      { x: e.clientX, y: e.clientY },
      scene.camera,
      canvas
    );

    let w = point.x - this.startPoint.x;
    let h = point.y - this.startPoint.y;

    if (e.shiftKey) {
      const size = Math.max(Math.abs(w), Math.abs(h));
      w = w >= 0 ? size : -size;
      h = h >= 0 ? size : -size;
    }

    const updates: any = {};

    if (w < 0) {
      updates.x = this.startPoint.x + w;
      updates.w = -w;
    } else {
      updates.x = this.startPoint.x;
      updates.w = w;
    }

    if (h < 0) {
      updates.y = this.startPoint.y + h;
      updates.h = -h;
    } else {
      updates.y = this.startPoint.y;
      updates.h = h;
    }

    context.updateElement(this.currentElementId, updates);
  }

  handlePointerUp(e: PointerEvent, context: ToolContext): void {
    if (this.currentElementId) {
      const scene = context.getScene();
      const element = scene.elements.find(
        (el) => el.id === this.currentElementId
      );
      if (element && (element.w < 1 || element.h < 1)) {
        context.removeElement(this.currentElementId);
      }
    }

    this.startPoint = null;
    this.currentElementId = null;
  }
}

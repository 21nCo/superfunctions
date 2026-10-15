import { BaseTool } from "./base-tool";
import type { ArrowElement, Point, ToolContext } from "../types";
import { generateId, screenToCanvas } from "../utils";

export class ArrowTool extends BaseTool {
  name = "arrow";
  private points: [number, number][] = [];
  private currentElementId: string | null = null;

  handlePointerDown(e: PointerEvent, context: ToolContext): void {
    const canvas = e.target as HTMLCanvasElement;
    const scene = context.getScene();
    const point = screenToCanvas(
      { x: e.clientX, y: e.clientY },
      scene.camera,
      canvas
    );

    context.getDrawfn().beginGesture("add");

    this.points = [[point.x, point.y]];

    const element: ArrowElement = {
      id: generateId(),
      type: "arrow",
      x: point.x,
      y: point.y,
      w: 0,
      h: 0,
      rotation: 0,
      stroke: "#000000",
      fill: "transparent",
      strokeWidth: 2,
      opacity: 1,
      points: [[0, 0]],
      head: "triangle",
    };

    this.currentElementId = context.addElement(element);
  }

  handlePointerMove(e: PointerEvent, context: ToolContext): void {
    if (!this.currentElementId || this.points.length === 0) return;

    const canvas = e.target as HTMLCanvasElement;
    const scene = context.getScene();
    const point = screenToCanvas(
      { x: e.clientX, y: e.clientY },
      scene.camera,
      canvas
    );

    const startX = this.points[0][0];
    const startY = this.points[0][1];

    let arrowPoints: [number, number][] = [
      [0, 0],
      [point.x - startX, point.y - startY],
    ];

    const minX = Math.min(0, point.x - startX);
    const minY = Math.min(0, point.y - startY);
    const maxX = Math.max(0, point.x - startX);
    const maxY = Math.max(0, point.y - startY);

    arrowPoints = arrowPoints.map(([x, y]) => [x - minX, y - minY]) as [
      number,
      number,
    ][];

    context.updateElement(this.currentElementId, {
      x: startX + minX,
      y: startY + minY,
      w: maxX - minX,
      h: maxY - minY,
      points: arrowPoints,
    });
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

    this.points = [];
    this.currentElementId = null;
  }
}

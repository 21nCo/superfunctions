import { BaseTool } from "./base-tool";
import type { Point, ToolContext } from "../types";

export class PanTool extends BaseTool {
  name = "pan";
  private dragStart: Point | null = null;

  deactivate(): void {
    super.deactivate();
    this.dragStart = null;
  }

  handlePointerDown(e: PointerEvent, context: ToolContext): void {
    this.dragStart = { x: e.clientX, y: e.clientY };
  }

  handlePointerMove(e: PointerEvent, context: ToolContext): void {
    if (!this.dragStart) return;

    const canvas = e.target as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const dx = (e.clientX - this.dragStart.x) * (rect.width > 0 ? canvas.width / rect.width : 1);
    const dy = (e.clientY - this.dragStart.y) * (rect.height > 0 ? canvas.height / rect.height : 1);

    const camera = context.getCamera();
    context.getDrawfn().setCamera({
      x: camera.x + dx,
      y: camera.y + dy,
    });

    this.dragStart = { x: e.clientX, y: e.clientY };
  }

  handlePointerUp(e: PointerEvent, context: ToolContext): void {
    this.dragStart = null;
  }
}

import { BaseTool } from "./base-tool";
import type { NodeElement, ToolContext } from "../types";
import { generateId, screenToCanvas } from "../utils";

export type NodeToolOptions = {
  nodeId: string;
  nodeType?: string;
  variant?: "bookmark" | "embed" | "card";
  preview?: {
    title?: string;
    icon?: string;
    excerpt?: string;
  };
};

export class NodeTool extends BaseTool {
  name = "node";
  private pendingNode: NodeToolOptions | null = null;

  activate(opts?: NodeToolOptions): void {
    super.activate(opts);
    if (opts?.nodeId) {
      this.pendingNode = opts;
    }
  }

  handlePointerDown(e: PointerEvent, context: ToolContext): void {
    if (!this.pendingNode) return;

    const canvas = e.target as HTMLCanvasElement;
    const scene = context.getScene();
    const point = screenToCanvas(
      { x: e.clientX, y: e.clientY },
      scene.camera,
      canvas
    );

    context.recordHistory();

    const element: NodeElement = {
      id: generateId(),
      type: "node",
      x: point.x - 120,
      y: point.y - 60,
      w: 240,
      h: 120,
      rotation: 0,
      stroke: "#2563eb",
      fill: "#eff6ff",
      strokeWidth: 1,
      opacity: 1,
      nodeId: this.pendingNode.nodeId,
      nodeType: this.pendingNode.nodeType,
      variant: this.pendingNode.variant || "bookmark",
      preview: this.pendingNode.preview,
    };

    context.addElement(element);
    this.pendingNode = null;
  }
}

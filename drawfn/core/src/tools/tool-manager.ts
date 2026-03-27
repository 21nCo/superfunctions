import type { ToolName, ToolContext } from "../types";
import { BaseTool } from "./base-tool";
import { SelectTool } from "./select-tool";
import { PanTool } from "./pan-tool";
import { PenTool } from "./pen-tool";
import { RectangleTool } from "./rectangle-tool";
import { EllipseTool } from "./ellipse-tool";
import { ArrowTool } from "./arrow-tool";
import { TextTool } from "./text-tool";
import { ImageTool } from "./image-tool";
import { NodeTool } from "./node-tool";

export class ToolManager {
  private tools: Map<ToolName, BaseTool> = new Map();
  private currentTool: ToolName = "select";
  private drawfn: any;

  constructor(drawfn: any, overlayRoot?: HTMLElement) {
    this.drawfn = drawfn;

    this.tools.set("select", new SelectTool());
    this.tools.set("pan", new PanTool());
    this.tools.set("pen", new PenTool());
    this.tools.set("rectangle", new RectangleTool());
    this.tools.set("ellipse", new EllipseTool());
    this.tools.set("arrow", new ArrowTool());
    this.tools.set("text", new TextTool(overlayRoot));
    this.tools.set("image", new ImageTool());
    this.tools.set("node", new NodeTool());
  }

  setTool(tool: ToolName, opts?: any): void {
    const currentTool = this.tools.get(this.currentTool);
    currentTool?.deactivate();

    this.currentTool = tool;

    const newTool = this.tools.get(tool);
    newTool?.activate(opts);
  }

  getCurrentTool(): ToolName {
    return this.currentTool;
  }

  handlePointerDown(
    e: PointerEvent,
    context: ToolContext,
    selectedIds: Set<string>
  ): void {
    const tool = this.tools.get(this.currentTool);
    tool?.handlePointerDown(e, context, selectedIds);
  }

  handlePointerMove(e: PointerEvent, context: ToolContext): void {
    const tool = this.tools.get(this.currentTool);
    tool?.handlePointerMove(e, context);
  }

  handlePointerUp(e: PointerEvent, context: ToolContext): void {
    const tool = this.tools.get(this.currentTool);
    tool?.handlePointerUp(e, context);
  }

  handlePointerCancel(e: PointerEvent, context: ToolContext): void {
    const tool = this.tools.get(this.currentTool);
    tool?.handlePointerCancel(e, context);
  }

  handleKeyDown(e: KeyboardEvent, context: ToolContext): void {
    const tool = this.tools.get(this.currentTool);
    tool?.handleKeyDown(e, context);
  }

  getTool(name: ToolName): BaseTool | undefined {
    return this.tools.get(name);
  }

  getMarquee(): {
    start: { x: number; y: number };
    current: { x: number; y: number };
  } | null {
    if (this.currentTool === "select") {
      const selectTool = this.tools.get("select") as any;
      return selectTool?.getMarquee?.() || null;
    }
    return null;
  }
}

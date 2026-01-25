import type { ToolContext } from "../types";

export abstract class BaseTool {
  abstract name: string;
  protected isActive = false;

  activate(opts?: any): void {
    this.isActive = true;
  }

  deactivate(): void {
    this.isActive = false;
  }

  handlePointerDown(
    e: PointerEvent,
    context: ToolContext,
    selectedIds: Set<string>
  ): void {}

  handlePointerMove(e: PointerEvent, context: ToolContext): void {}

  handlePointerUp(e: PointerEvent, context: ToolContext): void {}

  handleKeyDown(e: KeyboardEvent, context: ToolContext): void {}
}

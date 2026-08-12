import type { EditorController } from "@mdfn/core";

export type EditorMode = "visual" | "source" | "split" | "preview" | "read-only";

export interface ToolbarAction {
  readonly id: string;
  readonly label: string;
  readonly command?: string;
  readonly shortcut?: string;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
}

export interface ToolbarGroup {
  readonly id: string;
  readonly label: string;
  readonly actions: readonly ToolbarAction[];
}

export interface ToolbarModel {
  readonly ariaLabel: string;
  readonly groups: readonly ToolbarGroup[];
}

export interface ToolbarCommandTarget {
  can?(command: string): boolean;
  run(command: string): boolean;
}

export const defaultToolbarGroups: readonly ToolbarGroup[] = Object.freeze([
  { id: "history", label: "History", actions: [{ id: "undo", label: "Undo", shortcut: "Mod-z" }, { id: "redo", label: "Redo", shortcut: "Mod-Shift-z" }] },
  { id: "inline", label: "Inline formatting", actions: [{ id: "bold", label: "Bold", command: "bold", shortcut: "Mod-b" }, { id: "italic", label: "Italic", command: "italic", shortcut: "Mod-i" }, { id: "code", label: "Code", command: "inline-code" }] },
  { id: "blocks", label: "Blocks", actions: [{ id: "heading-2", label: "Heading", command: "heading-2" }, { id: "bullet-list", label: "Bullet list", command: "bullet-list" }, { id: "ordered-list", label: "Numbered list", command: "ordered-list" }, { id: "blockquote", label: "Quote", command: "blockquote" }] },
]);

export function createToolbarModel(controller: EditorController, groups: readonly ToolbarGroup[] = defaultToolbarGroups, ariaLabel = "Markdown formatting", commandTarget?: ToolbarCommandTarget | null): ToolbarModel {
  const canRun = (command: string): boolean => commandTarget?.can?.(command) ?? controller.can(command);
  return {
    ariaLabel,
    groups: groups.map((group) => ({
      ...group,
      actions: group.actions.map((action) => ({
        ...action,
        disabled: action.id === "undo" ? !(commandTarget?.can?.("undo") ?? controller.canUndo()) : action.id === "redo" ? !(commandTarget?.can?.("redo") ?? controller.canRedo()) : action.command ? !canRun(action.command) : action.disabled,
      })),
    })),
  };
}

export function runToolbarAction(controller: EditorController, action: ToolbarAction, commandTarget?: ToolbarCommandTarget | null): boolean {
  if (action.disabled) return false;
  if (commandTarget) return commandTarget.run(action.command ?? action.id);
  if (action.id === "undo") return controller.undo();
  if (action.id === "redo") return controller.redo();
  return action.command ? controller.run(action.command) : false;
}

export const MDFN_COMPONENTS_VERSION = "0.1.0" as const;

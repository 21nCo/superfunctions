/**
 * ContentFn patch types (SPEC.md).
 */

/** Strings retain dotted syntax; arrays address literal field names without splitting. */
export type ContentfnPatchPath = string | string[];

export type ContentfnPatchOp =
  | { op: "set"; path: ContentfnPatchPath; value: unknown }
  | { op: "unset"; path: ContentfnPatchPath }
  | { op: "inc"; path: ContentfnPatchPath; value: number }
  | { op: "dec"; path: ContentfnPatchPath; value: number }
  | {
      op: "insert";
      path: ContentfnPatchPath;
      position: "before" | "after";
      ref: string;
      items: unknown[];
    }
  | {
      op: "splice";
      path: ContentfnPatchPath;
      index: number;
      deleteCount: number;
      items?: unknown[];
    };

export interface ContentfnPatchInput {
  dataset: string;
  id: string;
  ifRev?: string;
  ops: ContentfnPatchOp[];
}

export const PATCH_OPS = new Set<string>([
  "set",
  "unset",
  "inc",
  "dec",
  "insert",
  "splice",
]);

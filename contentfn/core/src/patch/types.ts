/**
 * ContentFn patch types (SPEC.md).
 */

export type ContentfnPatchOp =
  | { op: "set"; path: string; value: unknown }
  | { op: "unset"; path: string }
  | { op: "inc"; path: string; value: number }
  | { op: "dec"; path: string; value: number }
  | {
      op: "insert";
      path: string;
      position: "before" | "after";
      ref: string;
      items: unknown[];
    }
  | {
      op: "splice";
      path: string;
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

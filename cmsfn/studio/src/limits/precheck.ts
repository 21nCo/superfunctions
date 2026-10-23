/**
 * Client-side limit prechecks (LIMIT-001). Surface UX errors before calling server.
 */

import type { ContentfnDocumentType, ContentfnField } from "@contentfn/core";

/** Max richtext blocks per field (SPEC.md). */
export const MAX_RICHTEXT_BLOCKS = 5000;

/**
 * Count blocks in a richtext value (array of block objects).
 */
export function countRichtextBlocks(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.length;
}

/**
 * Check all richtext fields in formState against maxBlocks.
 * Returns first field path that exceeds the limit.
 */
export function checkRichtextLimits(
  formState: Record<string, unknown>,
  docType: ContentfnDocumentType,
  maxBlocks: number = MAX_RICHTEXT_BLOCKS
): { ok: true } | { ok: false; path: string } {
  for (const field of docType.fields) {
    const ft = field.type as { kind?: string };
    if (ft?.kind === "richtext") {
      const count = countRichtextBlocks(formState[field.name]);
      if (count > maxBlocks) {
        return { ok: false, path: field.name };
      }
    }
  }
  return { ok: true };
}

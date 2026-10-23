/**
 * Client-side limit prechecks (LIMIT-001). Surface UX errors before calling server.
 */

import type { ContentfnDocumentType, ContentfnFieldType } from "@contentfn/core";

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
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1) return { ok: false, path: 'limits.maxRichtextBlocks' };
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const matches = (type: ContentfnFieldType, value: unknown): boolean => type.kind === 'primitive' ? type.type === 'json' || typeof value === (type.type === 'number' ? 'number' : type.type === 'boolean' ? 'boolean' : 'string') : type.kind === 'array' || type.kind === 'richtext' ? Array.isArray(value) : type.kind === 'reference' || type.kind === 'asset' ? record(value) && value._type === type.kind : record(value);
  const visit = (type: ContentfnFieldType, value: unknown, path: string): { ok: true } | { ok: false; path: string } => {
    if (type.kind === 'richtext' && countRichtextBlocks(value) > maxBlocks) return { ok: false, path };
    if (type.kind === 'object' && record(value)) {
      for (const field of type.fields) { const result = visit(field.type, value[field.name], `${path}.${field.name}`); if (!result.ok) return result; }
    }
    if (type.kind === 'array' && Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const results = type.of.filter(candidate => matches(candidate, value[i])).map(candidate => visit(candidate, value[i], `${path}[${i}]`));
        if (results.length && results.every(result => !result.ok)) return results[0];
      }
    }
    return { ok: true };
  };
  for (const field of docType.fields) { const result = visit(field.type, formState[field.name], field.name); if (!result.ok) return result; }
  return { ok: true };
}

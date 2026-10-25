/** Atomic top-level field patches retain literal nested keys and empty objects.
 * The editor supplies ifRev, so replacing an object cannot overwrite concurrent edits.
 */
import type { ContentfnPatchOp } from '@contentfn/core';
const SYSTEM_FIELDS = new Set(['_id', '_type', '_rev', '_createdAt', '_updatedAt', '_publishedAt', '_cms']);
const SIMPLE_FIELD = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
export function buildPatchOps(original: Record<string, unknown>, current: Record<string, unknown>): ContentfnPatchOp[] {
  const fields = [...new Set([...Object.keys(original), ...Object.keys(current)])].filter(field => !SYSTEM_FIELDS.has(field)).sort();
  const ops: ContentfnPatchOp[] = [];
  for (const field of fields) {
    const path = SIMPLE_FIELD.test(field) ? field : [field];
    if (!Object.prototype.hasOwnProperty.call(current, field)) {
      ops.push({ op: 'unset', path });
      continue;
    }
    const before = original[field], after = current[field];
    const same = before === after || (typeof before === 'object' && typeof after === 'object' && JSON.stringify(before) === JSON.stringify(after));
    if (!same) ops.push({ op: 'set', path, value: after });
  }
  return ops;
}

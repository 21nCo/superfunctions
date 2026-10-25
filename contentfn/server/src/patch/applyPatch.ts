/**
 * Deterministic patch application engine.
 * Applies patch operations to a document in order, validating paths and types.
 * Implements PATCH-001 semantics from SPEC.md.
 */

import type { ContentfnPatchOp } from "@contentfn/core";
import type { ContentfnEnvelope } from "@contentfn/core";
import { ok, err, parsePatchPath, formatPatchPath } from "@contentfn/core";

/**
 * Get value at path in document.
 * Returns undefined if path doesn't exist.
 */
function getValueAtPath(doc: Record<string, unknown>, segments: string[]): unknown {
  let current: any = doc;
  for (const seg of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    current = current[seg];
  }
  return current;
}

/**
 * Set value at path in document (mutating).
 * Creates intermediate objects if needed.
 * Returns error if path conflicts with existing non-object values.
 */
function setValueAtPath(
  doc: Record<string, unknown>,
  segments: string[],
  value: unknown,
  path: string
): ContentfnEnvelope<void> {
  if (segments.length === 0) {
    return err("PATCH_INVALID", "Path cannot be empty", { path });
  }
  // Check for empty segments
  for (const seg of segments) {
    if (seg === "") {
      return err("PATCH_INVALID", "Path contains empty segment", { path });
    }
  }

  let current: any = doc;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (!(seg in current)) {
      // Create intermediate object
      current[seg] = {};
    } else if (typeof current[seg] !== "object" || current[seg] === null || Array.isArray(current[seg])) {
      // Path conflict: existing value is not an object
      return err("PATCH_INVALID", `Cannot set nested path: segment "${seg}" is not an object`, {
        path: segments.slice(0, i + 1).join("."),
      });
    }
    current = current[seg];
  }

  const lastSeg = segments[segments.length - 1];
  current[lastSeg] = value;
  return ok(undefined);
}

/**
 * Unset (delete) value at path in document (mutating).
 * No-op if path doesn't exist.
 */
function unsetValueAtPath(doc: Record<string, unknown>, segments: string[]): void {
  if (segments.length === 0) return;

  let current: any = doc;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (!(seg in current)) return;
    current = current[seg];
    if (typeof current !== "object" || current === null) return;
  }

  const lastSeg = segments[segments.length - 1];
  delete current[lastSeg];
}

/**
 * Apply a single patch operation to a document (mutating).
 * Returns PATCH_INVALID if operation is invalid for the document structure.
 */
function applyOperation(
  doc: Record<string, unknown>,
  op: ContentfnPatchOp
): ContentfnEnvelope<void> {
  const parsed = parsePatchPath(op.path);
  if (!parsed.ok) return parsed;
  const segments = parsed.result;
  const path = formatPatchPath(op.path);

  switch (op.op) {
    case "set": {
      return setValueAtPath(doc, segments, op.value, path);
    }

    case "unset": {
      unsetValueAtPath(doc, segments);
      return ok(undefined);
    }

    case "inc":
    case "dec": {
      const current = getValueAtPath(doc, segments);
      if (current !== undefined && typeof current !== "number") {
        return err("PATCH_INVALID", `Cannot ${op.op} non-numeric field`, { path });
      }
      const currentValue = typeof current === "number" ? current : 0;
      const newValue = op.op === "inc" ? currentValue + op.value : currentValue - op.value;
      return setValueAtPath(doc, segments, newValue, path);
    }

    case "insert": {
      // Insert items into array at position relative to ref item
      const current = getValueAtPath(doc, segments);
      if (!Array.isArray(current)) {
        return err("PATCH_INVALID", `Cannot insert into non-array field`, { path });
      }

      // Find item with _key matching ref
      let refIndex = -1;
      for (let i = 0; i < current.length; i++) {
        const item = current[i];
        if (typeof item === "object" && item !== null && (item as any)._key === op.ref) {
          refIndex = i;
          break;
        }
      }

      if (refIndex === -1) {
        return err("PATCH_INVALID", `Reference item with _key="${op.ref}" not found in array`, {
          path,
        });
      }

      const insertIndex = op.position === "before" ? refIndex : refIndex + 1;
      current.splice(insertIndex, 0, ...op.items);
      return ok(undefined);
    }

    case "splice": {
      // Splice array at index
      const current = getValueAtPath(doc, segments);
      if (!Array.isArray(current)) {
        return err("PATCH_INVALID", `Cannot splice non-array field`, { path });
      }

      // Bounds check
      if (op.index < 0 || op.index > current.length) {
        return err("PATCH_INVALID", `Splice index ${op.index} out of bounds (array length ${current.length})`, {
          path,
        });
      }

      const itemsToInsert = op.items ?? [];
      current.splice(op.index, op.deleteCount, ...itemsToInsert);
      return ok(undefined);
    }

    default:
      // Should never happen if validatePatch is called first
      return err("PATCH_INVALID", "Unknown patch operation", {
        path: (op as { path?: string }).path,
      });
  }
}

/**
 * Apply all patch operations to a document in order.
 * Returns the mutated document on success, or an error if any operation fails.
 * The document is mutated in place; caller should clone if needed.
 */
export function applyPatch(
  doc: Record<string, unknown>,
  ops: ContentfnPatchOp[]
): ContentfnEnvelope<Record<string, unknown>> {
  for (let i = 0; i < ops.length; i++) {
    const result = applyOperation(doc, ops[i]);
    if (!result.ok) {
      return result as ContentfnEnvelope<Record<string, unknown>>;
    }
  }
  return ok(doc);
}

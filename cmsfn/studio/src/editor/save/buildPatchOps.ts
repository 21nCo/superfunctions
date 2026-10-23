/**
 * Build patch ops from original doc and current form state.
 * Ops in stable order (paths sorted).
 */

import type { ContentfnPatchOp } from "@contentfn/core";

/**
 * Recursively collect path-value pairs from an object (no system fields).
 */
function collectPaths(obj: unknown, prefix: string): Array<{ path: string; value: unknown }> {
  const out: Array<{ path: string; value: unknown }> = [];
  if (obj === null || obj === undefined) {
    out.push({ path: prefix, value: obj });
    return out;
  }
  if (Array.isArray(obj)) {
    out.push({ path: prefix, value: obj });
    return out;
  }
  if (typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    for (const key of Object.keys(o)) {
      if (key.startsWith("_")) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const v = o[key];
      if (v !== null && typeof v === "object" && !Array.isArray(v) && !(v as Record<string, unknown>)._type) {
        const nested = collectPaths(v, path);
        out.push(...nested);
      } else {
        out.push({ path, value: v });
      }
    }
  } else {
    out.push({ path: prefix, value: obj });
  }
  return out;
}

function pathsToMap(items: Array<{ path: string; value: unknown }>): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const { path, value } of items) {
    m.set(path, value);
  }
  return m;
}

const SYSTEM_FIELDS = new Set(["_id", "_type", "_rev", "_createdAt", "_updatedAt", "_publishedAt", "_cms"]);

/**
 * Build set/unset ops by diffing original and current.
 * Ops are returned in deterministic order (paths sorted).
 */
export function buildPatchOps(
  original: Record<string, unknown>,
  current: Record<string, unknown>
): ContentfnPatchOp[] {
  const origPaths = collectPaths(
    Object.fromEntries(Object.entries(original).filter(([k]) => !SYSTEM_FIELDS.has(k))),
    ""
  );
  const currPaths = collectPaths(
    Object.fromEntries(Object.entries(current).filter(([k]) => !SYSTEM_FIELDS.has(k))),
    ""
  );
  const origMap = pathsToMap(origPaths);
  const currMap = pathsToMap(currPaths);
  const allPaths = new Set([...origMap.keys(), ...currMap.keys()]);
  const ops: ContentfnPatchOp[] = [];
  const sorted = Array.from(allPaths).sort();
  for (const path of sorted) {
    const origVal = origMap.get(path);
    const currVal = currMap.get(path);
    if (!currMap.has(path)) {
      ops.push({ op: "unset", path });
    } else {
      const same = origVal === currVal || (typeof origVal === "object" && typeof currVal === "object" && JSON.stringify(origVal) === JSON.stringify(currVal));
      if (!same) ops.push({ op: "set", path, value: currVal });
    }
  }
  return ops;
}

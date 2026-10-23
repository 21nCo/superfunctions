/**
 * Deterministic patch validation: op allowlist, required fields per op,
 * path syntax (non-empty, allowed chars). Path grammar: segments separated by '.',
 * each segment = [a-zA-Z0-9_]+ or array index [0-9]+. For array item by _key we allow
 * a ref segment (exact encoding documented in implementation).
 */

import type { ContentfnPatchOp, ContentfnPatchInput } from "./types.js";
import { PATCH_OPS } from "./types.js";
import type { ContentfnEnvelope } from "../errors.js";
import { err } from "../errors.js";

/** Path segment: alphanumeric + underscore, or numeric index. No empty segments. */
const SEGMENT_REGEX = /^([a-zA-Z_][a-zA-Z0-9_]*|[0-9]+)$/;

function validatePath(path: unknown, pathField: string): ContentfnEnvelope<string> {
  if (typeof path !== "string") {
    return err("PATCH_INVALID", "Path must be a string", { path: pathField });
  }
  if (path.length === 0) {
    return err("PATCH_INVALID", "Path must be non-empty", { path: pathField });
  }
  const segments = path.split(".");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) {
      return err("PATCH_INVALID", "Path segment cannot be empty", {
        path: `${pathField}`,
      });
    }
    if (["__proto__", "prototype", "constructor"].includes(seg) || !SEGMENT_REGEX.test(seg)) {
      return err("PATCH_INVALID", "Path segment has invalid characters", {
        path: pathField,
      });
    }
  }
  return { ok: true, result: path };
}

function validateOp(op: unknown, index: number): ContentfnEnvelope<ContentfnPatchOp> {
  const opPath = `ops[${index}]`;
  if (op === null || typeof op !== "object") {
    return err("PATCH_INVALID", "Patch op must be an object", { path: opPath });
  }
  const o = op as Record<string, unknown>;
  if (typeof o.op !== "string" || !PATCH_OPS.has(o.op)) {
    return err("PATCH_INVALID", "Invalid patch op", { path: `${opPath}.op` });
  }

  const pathRes = validatePath(o.path, `${opPath}.path`);
  if (!pathRes.ok) return pathRes;

  switch (o.op) {
    case "set":
      return { ok: true, result: { op: "set", path: pathRes.result, value: o.value } };
    case "unset":
      return { ok: true, result: { op: "unset", path: pathRes.result } };
    case "inc":
    case "dec":
      if (typeof o.value !== "number" || !Number.isFinite(o.value)) {
        return err("PATCH_INVALID", `${o.op} requires numeric value`, {
          path: `${opPath}.value`,
        });
      }
      return {
        ok: true,
        result: { op: o.op as "inc" | "dec", path: pathRes.result, value: o.value },
      };
    case "insert":
      if (o.position !== "before" && o.position !== "after") {
        return err("PATCH_INVALID", "insert position must be before or after", {
          path: `${opPath}.position`,
        });
      }
      if (typeof o.ref !== "string" || !o.ref) {
        return err("PATCH_INVALID", "insert ref must be non-empty string", {
          path: `${opPath}.ref`,
        });
      }
      if (!Array.isArray(o.items)) {
        return err("PATCH_INVALID", "insert items must be array", {
          path: `${opPath}.items`,
        });
      }
      return {
        ok: true,
        result: {
          op: "insert",
          path: pathRes.result,
          position: o.position as "before" | "after",
          ref: o.ref,
          items: o.items,
        },
      };
    case "splice":
      if (typeof o.index !== "number" || !Number.isSafeInteger(o.index) || o.index < 0) {
        return err("PATCH_INVALID", "splice index must be non-negative number", {
          path: `${opPath}.index`,
        });
      }
      if (typeof o.deleteCount !== "number" || !Number.isSafeInteger(o.deleteCount) || o.deleteCount < 0) {
        return err("PATCH_INVALID", "splice deleteCount must be non-negative number", {
          path: `${opPath}.deleteCount`,
        });
      }
      const items = o.items;
      if (items !== undefined && !Array.isArray(items)) {
        return err("PATCH_INVALID", "splice items must be array", {
          path: `${opPath}.items`,
        });
      }
      return {
        ok: true,
        result: {
          op: "splice",
          path: pathRes.result,
          index: o.index,
          deleteCount: o.deleteCount,
          items,
        },
      };
    default:
      return err("PATCH_INVALID", "Unknown patch op", { path: `${opPath}.op` });
  }
}

/**
 * Validates patch input and ops. Returns PATCH_INVALID with details.path when invalid.
 */
export function validatePatch(input: unknown): ContentfnEnvelope<ContentfnPatchInput> {
  if (input === null || typeof input !== "object") {
    return err("PATCH_INVALID", "Patch input must be an object", { path: "" });
  }
  const i = input as Record<string, unknown>;
  if (typeof i.dataset !== "string" || !i.dataset) {
    return err("PATCH_INVALID", "dataset must be non-empty string", { path: "dataset" });
  }
  if (typeof i.id !== "string" || !i.id) {
    return err("PATCH_INVALID", "id must be non-empty string", { path: "id" });
  }
  if (i.ifRev !== undefined && typeof i.ifRev !== "string") {
    return err("PATCH_INVALID", "ifRev must be string", { path: "ifRev" });
  }
  if (!Array.isArray(i.ops)) {
    return err("PATCH_INVALID", "ops must be an array", { path: "ops" });
  }
  const ops: ContentfnPatchOp[] = [];
  for (let idx = 0; idx < i.ops.length; idx++) {
    const res = validateOp(i.ops[idx], idx);
    if (!res.ok) return res;
    ops.push(res.result);
  }
  return {
    ok: true,
    result: {
      dataset: i.dataset,
      id: i.id,
      ifRev: i.ifRev as string | undefined,
      ops,
    },
  };
}

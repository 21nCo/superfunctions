/**
 * Deterministic patch validation with legacy dotted paths or explicit literal
 * segment arrays. Both forms reject empty and prototype-mutating segments.
 */

import type { ContentfnPatchOp, ContentfnPatchInput, ContentfnPatchPath } from "./types.js";
import { PATCH_OPS } from "./types.js";
import type { ContentfnEnvelope } from "../errors.js";
import { err } from "../errors.js";

/** Path segment: alphanumeric + underscore, or numeric index. No empty segments. */
const SEGMENT_REGEX = /^([a-zA-Z_][a-zA-Z0-9_]*|[0-9]+)$/;

/** Validate and detach literal segments before any asynchronous storage operation. */
export function parsePatchPath(path: unknown, pathField = "path"): ContentfnEnvelope<string[]> {
  if (typeof path !== "string" && !Array.isArray(path)) return err("PATCH_INVALID", "Path must be a string or segment array", { path: pathField });
  const segments: unknown[] = typeof path === "string" ? path.split(".") : path;
  if (!segments.length) return err("PATCH_INVALID", "Path cannot be empty", { path: pathField });
  const detached: string[] = [];
  for (const segment of segments) {
    if (typeof segment !== "string" || !segment.length || ["__proto__", "prototype", "constructor"].includes(segment) || (typeof path === "string" && !SEGMENT_REGEX.test(segment))) {
      return err("PATCH_INVALID", "Path segment is invalid", { path: pathField });
    }
    detached.push(segment);
  }
  return { ok: true, result: detached };
}

/** Preserve legacy event paths where lossless; otherwise encode literal segments. */
export function formatPatchPath(path: ContentfnPatchPath): string {
  if (typeof path === "string") return path;
  return path.every(segment => SEGMENT_REGEX.test(segment)) ? path.join(".") : JSON.stringify(path);
}
function validatePath(path: unknown, pathField: string): ContentfnEnvelope<ContentfnPatchPath> {
  const parsed = parsePatchPath(path, pathField);
  if (!parsed.ok) return parsed;
  return { ok: true, result: typeof path === "string" ? path : parsed.result };
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

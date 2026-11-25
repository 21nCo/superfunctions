/**
 * Shared storage adapter validation utilities (STR-001)
 */

import type { DatafnHydrationState } from "../storage.js";

export function validateHydrationState(state: string): DatafnHydrationState {
  if (state !== "notStarted" && state !== "hydrating" && state !== "ready") {
    throw new Error(`Invalid hydration state: ${state}`);
  }
  return state as DatafnHydrationState;
}

export function validateTransition(
  from: DatafnHydrationState,
  to: DatafnHydrationState,
): void {
  if (from === to) return;
  if (from === "notStarted" && to === "hydrating") return;
  if (from === "hydrating" && to === "ready") return;
  if (from === "ready" && to === "hydrating") return;
  throw new Error(`Invalid hydration state transition: ${from} -> ${to}`);
}

export function validateCursor(cursor: unknown): void {
  if (cursor !== null && typeof cursor !== "string") {
    throw new Error("Invalid cursor format");
  }
}

export function cloneForStorage<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }

  if (value instanceof RegExp) {
    return new RegExp(value.source, value.flags) as T;
  }

  if (value instanceof ArrayBuffer) {
    return value.slice(0) as T;
  }

  if (ArrayBuffer.isView(value)) {
    return value;
  }

  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return value;
  }

  const source = value as Record<string, unknown>;
  const existing = seen.get(source);
  if (existing) {
    return existing as T;
  }

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(source, output);
    for (const item of value) {
      if (typeof item === "function" || typeof item === "symbol") {
        continue;
      }
      output.push(cloneForStorage(item, seen));
    }
    return output as T;
  }

  const output: Record<string, unknown> = {};
  seen.set(source, output);
  for (const key of Object.keys(source)) {
    const child = source[key];
    if (typeof child === "function" || typeof child === "symbol") {
      continue;
    }
    output[key] = cloneForStorage(child, seen);
  }
  return output as T;
}

/** DATA-41: storage key of a record's revision. */
export function revisionKey(resource: string, id: string): string {
  return `${resource}\u0000${id}`;
}

/**
 * DATA-41: whether a pending local mutation may change the record, so a
 * server row must not be installed over it. Conservative: a relation write
 * naming the id, any delete (relation policies can reach other records), and
 * any write to a `propagatingResources` resource (the parent of an
 * `inheritsInactive` relation, whose writes can change the inherited state
 * of its descendants) count as touching it.
 */
export function mutationTouchesRecord(
  mutation: unknown,
  resource: string,
  id: string,
  propagatingResources?: ReadonlyArray<string>,
): boolean {
  if (!mutation || typeof mutation !== "object") return false;
  const m = mutation as Record<string, unknown>;
  if (m.resource === resource && m.id === id) return true;
  if (m.operation === "delete") return true;
  if (typeof m.resource === "string" && propagatingResources?.includes(m.resource)) return true;
  if (m.operation === "relate" || m.operation === "modifyRelation" || m.operation === "unrelate") {
    return JSON.stringify(m.relations ?? null).includes(JSON.stringify(id));
  }
  return false;
}

/**
 * DATA-41: whether a server row must not be installed over a record: it was
 * written after the request that returned the row started (`writtenSince`),
 * or a pending local mutation may change it.
 */
export function blocksRevisionInstall(
  writtenStamp: number,
  writtenSince: number | undefined,
  pendingMutations: ReadonlyArray<unknown>,
  resource: string,
  id: string,
  propagatingResources?: ReadonlyArray<string>,
): boolean {
  if (writtenSince !== undefined && writtenStamp > writtenSince) return true;
  return pendingMutations.some((mutation) => mutationTouchesRecord(mutation, resource, id, propagatingResources));
}

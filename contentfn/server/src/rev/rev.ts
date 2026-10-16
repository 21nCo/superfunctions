/**
 * Revision generation strategy.
 * Each successful mutation generates a new opaque revision string.
 * Implementation uses random UUIDs for now (deterministic by uniqueness constraint).
 */

import { randomUUID } from "node:crypto";

/**
 * Generate a new revision string.
 * Must be opaque, unique, and suitable for optimistic concurrency checks.
 */
export function generateRev(): string {
  return `rev_${randomUUID()}`;
}

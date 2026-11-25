/**
 * DATA-41: wire types for server-managed per-record revisions.
 *
 * A revision is an integer the server raises by one on every committed write
 * to a record, kept as a tombstone after a delete and never reused. It travels
 * as row metadata, never inside a record's own fields.
 */

/** Reserved row property carrying a returned row's revision (clone, versioned query, pull). */
export const DATAFN_REVISION_FIELD = "$rev" as const;

/** A push mutation's revision result. */
export interface DatafnPushRevision {
  resource: string;
  id: string;
  /** The record's revision after the write. */
  rev: number;
  /**
   * The record's complete row at `rev`, read in the write's transaction,
   * carrying `rev` again as `$rev` row metadata (only that `$rev` belongs to
   * the row). Absent when the caller may not read every field, or on a
   * deduplicated reply; the caller then holds no row proven at `rev`.
   */
  record?: Record<string, unknown>;
  /** The write deleted the record; `rev` is its tombstone revision. */
  deleted?: true;
}

/** Capabilities a server announces on its responses. */
export interface DatafnServerCapabilities {
  /** The server issues revisions (`revisions: { enabled: true }`). */
  revisions?: boolean;
}

/**
 * Reads a returned row's revision, or undefined when it carries none.
 * Revision 0 is a record no write of a revision-aware release has touched.
 */
export function readRowRevision(row: unknown): number | undefined {
  if (!row || typeof row !== "object") return undefined;
  const rev = (row as Record<string, unknown>)[DATAFN_REVISION_FIELD];
  return typeof rev === "number" && Number.isInteger(rev) && rev >= 0 ? rev : undefined;
}

/** A copy of `row` without its revision metadata. */
export function withoutRowRevision<T extends Record<string, unknown>>(row: T): T {
  if (!(DATAFN_REVISION_FIELD in row)) return row;
  const rest: Record<string, unknown> = { ...row };
  delete rest[DATAFN_REVISION_FIELD];
  return rest as T;
}

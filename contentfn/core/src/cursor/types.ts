/**
 * Cursor encoding/decoding interface (implementation deferred to PHASE_06).
 * Shape only: opaque string <-> ordering tuple for deterministic pagination.
 */

/**
 * Opaque cursor string returned in CfqlResultPage.nextCursor.
 */
export type CursorString = string;

/**
 * Decoded cursor representation (implementation-defined in PHASE_06).
 */
export interface CursorPayload {
  /** Ordering values at the last seen document (e.g. _updatedAt, _id). */
  values: unknown[];
}

/**
 * Encode a cursor payload to an opaque string.
 * Implementation in PHASE_06.
 */
export type EncodeCursor = (payload: CursorPayload) => CursorString;

/**
 * Decode an opaque cursor string to payload.
 * Implementation in PHASE_06.
 */
export type DecodeCursor = (cursor: CursorString) => CursorPayload | null;

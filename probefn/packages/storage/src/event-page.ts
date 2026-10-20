import { stat } from 'node:fs/promises';
import path from 'node:path';
import { assertRepositoryRelativePath } from './manifest-writer.js';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createProbefnError } from '@probefn/contracts/errors';
import { iterateEventSinkFamily, type EventPosition } from './event-reader.js';
const cursorKey = randomBytes(32);
export const MAX_EVENT_PAGE_BYTES = 1024 * 1024;
export interface EventPageOptions { limit?: number; cursor?: string; }
export interface EventPage { events: unknown[]; provenance: Array<{ relativePath: string; lineNumber: number }>; nextCursor: string | null; }
const invalid = () => createProbefnError({ code: 'E_MCP_INVALID_ARGS', message: 'Invalid, expired, or cross-sink event cursor.', retryable: false });
function encode(repoRoot: string, anchor: string, position: EventPosition): string {
  const data = Buffer.from(JSON.stringify({ anchor, position })).toString('base64url');
  return data + '.' + createHmac('sha256', cursorKey).update(JSON.stringify([repoRoot, anchor, data])).digest('base64url');
}
function decode(repoRoot: string, anchor: string, cursor: string): EventPosition {
  if (typeof cursor !== 'string' || cursor.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  const [data, mac] = cursor.split('.');
  const expected = createHmac('sha256', cursorKey).update(JSON.stringify([repoRoot, anchor, data])).digest(); const actual = Buffer.from(mac!, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid();
  try { const value = JSON.parse(Buffer.from(data!, 'base64url').toString()); if (value.anchor !== anchor || !value.position) throw invalid(); return value.position; } catch { throw invalid(); }
}
/** Bounded live traversal. Process-local authenticated cursors expire on restart. */
export async function readEventSinkPage(repoRoot: string, anchor: string, options: EventPageOptions = {}): Promise<EventPage> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw invalid();
  anchor = assertRepositoryRelativePath(anchor);
  const anchorStat = await stat(path.resolve(repoRoot, anchor));
  const anchorIdentity = `${anchorStat.dev}:${anchorStat.ino}`;
  const start = options.cursor === undefined ? undefined : decode(repoRoot, anchor, options.cursor);
  if (start && (start.anchorIdentity !== anchorIdentity || anchorStat.size < start.anchorSize! || (anchorStat.size === start.anchorSize && anchorStat.mtimeMs !== start.anchorModifiedAt) || (start.relativePath !== anchor && anchorStat.size !== start.anchorSize))) throw invalid();
  const page: EventPage = { events: [], provenance: [], nextCursor: null }; let bytes = 0;
  for await (const record of iterateEventSinkFamily(repoRoot, anchor, { ...(start ? { start } : {}), maxRecordBytes: MAX_EVENT_PAGE_BYTES })) {
    const provenance = { relativePath: record.relativePath, lineNumber: record.lineNumber };
    const cursor = encode(repoRoot, anchor, { ...record.nextPosition!, anchorIdentity, anchorSize: anchorStat.size, anchorModifiedAt: anchorStat.mtimeMs });
    if (cursor.length > 8192) throw invalid();
    const recordBytes = Buffer.byteLength(JSON.stringify(record.payload)) + Buffer.byteLength(JSON.stringify(provenance));
    const overhead = Buffer.byteLength(JSON.stringify({ events: [], provenance: [], nextCursor: cursor }));
    if (recordBytes + overhead > MAX_EVENT_PAGE_BYTES) throw createProbefnError({ code: 'E_STORAGE_CAP_EXCEEDED', message: 'Single event exceeds the MCP page byte budget.', retryable: false, details: provenance });
    const additional = recordBytes + (page.events.length ? 2 : 0);
    if (bytes + additional + overhead > MAX_EVENT_PAGE_BYTES) return page;
    page.events.push(record.payload); page.provenance.push(provenance); bytes += additional;
    page.nextCursor = cursor;
    if (page.events.length === limit) return page;
  }
  page.nextCursor = null; return page;
}

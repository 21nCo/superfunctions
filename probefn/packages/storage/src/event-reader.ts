import { open, readdir, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createProbefnError } from '@probefn/contracts/errors';
import { assertRepositoryRelativePath } from './manifest-writer.js';

export interface StoredEvent {
  relativePath: string;
  lineNumber: number;
  payload: Record<string, unknown>;
  nextPosition?: EventPosition;
}

export interface EventPosition { anchorIdentity?: string; anchorSize?: number; anchorModifiedAt?: number; relativePath: string; byteOffset: number; lineNumber: number; identity: string; terminated: boolean; observedSize: number; modifiedAt: number; guardOffset: number; guardBytes: number; guardHash: string; }
export interface EventReadOptions {
  start?: EventPosition;
  /** Bounds a single encoded NDJSON record, excluding its newline. Never truncates. */
  maxRecordBytes?: number;
}

export const DEFAULT_MAX_EVENT_RECORD_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

/** Stream the initial sink and its numbered rollover siblings in numeric order. */
export async function* iterateEventSinkFamily(
  repoRoot: string,
  initialPath: string,
  options: EventReadOptions = {},
): AsyncGenerator<StoredEvent> {
  const relativePath = assertRepositoryRelativePath(initialPath);
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_EVENT_RECORD_BYTES;
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
    throw new TypeError('Event record byte limit must be a positive safe integer.');
  }
  const directory = path.posix.dirname(relativePath);
  const name = path.posix.basename(relativePath);
  const stem = name.endsWith('.ndjson') ? name.slice(0, -7) : name;
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}-(\\d{4,})\\.ndjson$`);
  // Open the anchor before listing siblings: a missing anchor is never an empty sink.
  const initial = await open(path.resolve(repoRoot, relativePath), 'r');
  let siblings: Array<{ name: string; index: number }>;
  try {
    siblings = (await readdir(path.resolve(repoRoot, directory)))
      .map(name => ({ name, index: Number(pattern.exec(name)?.[1]) }))
      .filter(entry => Number.isSafeInteger(entry.index) && entry.index >= 2)
      .sort((left, right) => left.index - right.index);
    for (const [offset, sibling] of siblings.entries()) {
      const expectedIndex = offset + 2;
      const expectedName = `${stem}-${String(expectedIndex).padStart(4, '0')}.ndjson`;
      if (sibling.index !== expectedIndex || sibling.name !== expectedName) {
        throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED',
          message: 'Stored event rollover sequence is incomplete or ambiguous.', retryable: false,
          details: { relativePath, expectedSegment: expectedName } });
      }
    }
    if (!options.start || options.start.relativePath === relativePath) yield* iterateFile(initial, relativePath, maxRecordBytes, options.start);
    else if (!siblings.some(sibling => path.posix.join(directory, sibling.name) === options.start!.relativePath)) throw createProbefnError({ code: 'E_MCP_INVALID_ARGS', message: 'Event cursor segment is unavailable.', retryable: false });
  } catch (error) {
    throw missingSegmentError(error, relativePath);
  } finally {
    await initial.close();
  }
  let resumed = !options.start || options.start.relativePath === relativePath;
  for (const sibling of siblings) {
    const file = path.posix.join(directory, sibling.name);
    if (!resumed && file !== options.start?.relativePath) continue;
    resumed = true;
    const handle = await open(path.resolve(repoRoot, file), 'r').catch(error => { throw missingSegmentError(error, file); });
    try {
      yield* iterateFile(handle, file, maxRecordBytes, options.start?.relativePath === file ? options.start : undefined);
    } catch (error) {
      throw missingSegmentError(error, file);
    } finally {
      await handle.close();
    }
  }
}

/** Compatibility collector. Aggregations should consume iterateEventSinkFamily directly. */
export async function readEventSinkFamily(
  repoRoot: string,
  initialPath: string,
  options: EventReadOptions = {},
): Promise<StoredEvent[]> {
  const records: StoredEvent[] = [];
  for await (const record of iterateEventSinkFamily(repoRoot, initialPath, options)) records.push(record);
  return records;
}

async function* iterateFile(handle: FileHandle, relativePath: string, maxRecordBytes: number, start?: EventPosition): AsyncGenerator<StoredEvent> {
  // Bound each segment to its size at open/read time so a live writer cannot prolong the scan forever.
  const { size, dev, ino, mtimeMs } = await handle.stat();
  const identity = `${dev}:${ino}`;
  if (start) {
    if (!Number.isSafeInteger(start.guardOffset) || start.guardOffset < 0 || !Number.isSafeInteger(start.guardBytes) || start.guardBytes < 1 || start.guardBytes > maxRecordBytes || !Number.isSafeInteger(start.observedSize) || start.observedSize < start.byteOffset || !Number.isFinite(start.modifiedAt) || typeof start.terminated !== 'boolean' || typeof start.guardHash !== 'string' || !/^[a-f0-9]{64}$/.test(start.guardHash) || start.guardOffset + start.guardBytes !== start.byteOffset - (start.terminated ? 1 : 0)) throw createProbefnError({ code: 'E_MCP_INVALID_ARGS', message: 'Event cursor guard is invalid.', retryable: false });
    if (!Number.isSafeInteger(start.byteOffset) || start.byteOffset < 0 || start.byteOffset > size || !Number.isSafeInteger(start.lineNumber) || start.lineNumber < 1 || start.identity !== identity) throw createProbefnError({ code: 'E_MCP_INVALID_ARGS', message: 'Event cursor is stale or invalid.', retryable: false });
    if (size < start.observedSize || (size === start.observedSize && mtimeMs !== start.modifiedAt)) throw createProbefnError({ code: 'E_MCP_INVALID_ARGS', message: 'Event segment changed since cursor creation.', retryable: false });
    const guard = createHash('sha256'); const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    let guarded = 0;
    while (guarded < start.guardBytes) {
      const result = await handle.read(chunk, 0, Math.min(chunk.length, start.guardBytes - guarded), start.guardOffset + guarded);
      if (!result.bytesRead) throw createProbefnError({ code: 'E_MCP_INVALID_ARGS', message: 'Event cursor guard is unavailable.', retryable: false });
      guard.update(chunk.subarray(0, result.bytesRead)); guarded += result.bytesRead;
    }
    if (guard.digest('hex') !== start.guardHash) throw createProbefnError({ code: 'E_MCP_INVALID_ARGS', message: 'Event cursor record changed.', retryable: false });
    if (start.byteOffset > 0) {
      const previous = Buffer.alloc(1); await handle.read(previous, 0, 1, start.byteOffset - 1);
      if (previous[0] !== 10 && (start.terminated || start.byteOffset !== size)) throw createProbefnError({ code: 'E_MCP_INVALID_ARGS', message: 'Event cursor does not identify a complete line boundary.', retryable: false });
    }
  }
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let position = start?.byteOffset ?? 0;
  let lineNumber = start?.lineNumber ?? 1;
  let parts: Buffer[] = [];
  let recordBytes = 0;
  const append = (part: Buffer) => {
    if (recordBytes + part.length > maxRecordBytes) {
      throw createProbefnError({ code: 'E_STORAGE_CAP_EXCEEDED',
        message: 'Stored event exceeds the configured record byte limit.', retryable: false,
        details: { relativePath, lineNumber, maxRecordBytes } });
    }
    if (part.length) parts.push(Buffer.from(part));
    recordBytes += part.length;
  };
  const parse = (byteOffset: number, terminated = true): StoredEvent | undefined => {
    const encoded = Buffer.concat(parts, recordBytes);
    const guardHash = createHash('sha256').update(encoded).digest('hex');
    const guardBytes = recordBytes;
    const guardOffset = byteOffset - recordBytes - (terminated ? 1 : 0);
    const line = encoded.toString('utf8');
    parts = []; recordBytes = 0;
    if (!line.trim()) return undefined;
    let payload: unknown;
    try { payload = JSON.parse(line); } catch {
      throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED',
        message: 'Stored event is not valid JSON.', retryable: false,
        details: { relativePath, lineNumber } });
    }
    return { relativePath, lineNumber, payload: payload as Record<string, unknown>, nextPosition: { relativePath, byteOffset, lineNumber: lineNumber + (terminated ? 1 : 0), identity, terminated, observedSize: size, modifiedAt: mtimeMs, guardOffset, guardBytes, guardHash } };
  };
  while (position < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
    if (bytesRead === 0) {
      throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED',
        message: 'Stored event segment was truncated while being read.', retryable: false,
        details: { relativePath, lineNumber } });
    }
    position += bytesRead;
    let start = 0;
    for (let index = 0; index < bytesRead; index++) {
      if (buffer[index] !== 10) continue;
      append(buffer.subarray(start, index));
      const record = parse(position - bytesRead + index + 1);
      if (record) yield record;
      lineNumber++;
      start = index + 1;
    }
    append(buffer.subarray(start, bytesRead));
  }
  if (recordBytes) {
    const record = parse(position, false);
    if (record) yield record;
  }
}

function missingSegmentError(error: unknown, relativePath: string): unknown {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    return createProbefnError({ code: 'E_STORAGE_WRITE_FAILED',
      message: 'Stored event segment disappeared while being read.', retryable: false,
      details: { relativePath } });
  }
  return error;
}

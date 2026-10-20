import { open, readdir, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createProbefnError } from '@probefn/contracts/errors';
import { assertRepositoryRelativePath } from './manifest-writer.js';

export interface StoredEvent {
  relativePath: string;
  lineNumber: number;
  payload: Record<string, unknown>;
}

export interface EventReadOptions {
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
    yield* iterateFile(initial, relativePath, maxRecordBytes);
  } catch (error) {
    throw missingSegmentError(error, relativePath);
  } finally {
    await initial.close();
  }
  for (const sibling of siblings) {
    const file = path.posix.join(directory, sibling.name);
    const handle = await open(path.resolve(repoRoot, file), 'r').catch(error => { throw missingSegmentError(error, file); });
    try {
      yield* iterateFile(handle, file, maxRecordBytes);
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

async function* iterateFile(handle: FileHandle, relativePath: string, maxRecordBytes: number): AsyncGenerator<StoredEvent> {
  // Bound each segment to its size at open/read time so a live writer cannot prolong the scan forever.
  const { size } = await handle.stat();
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let position = 0;
  let lineNumber = 1;
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
  const parse = (): StoredEvent | undefined => {
    const line = Buffer.concat(parts, recordBytes).toString('utf8');
    parts = []; recordBytes = 0;
    if (!line.trim()) return undefined;
    let payload: unknown;
    try { payload = JSON.parse(line); } catch {
      throw createProbefnError({ code: 'E_STORAGE_WRITE_FAILED',
        message: 'Stored event is not valid JSON.', retryable: false,
        details: { relativePath, lineNumber } });
    }
    return { relativePath, lineNumber, payload: payload as Record<string, unknown> };
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
      const record = parse();
      if (record) yield record;
      lineNumber++;
      start = index + 1;
    }
    append(buffer.subarray(start, bytesRead));
  }
  if (recordBytes) {
    const record = parse();
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

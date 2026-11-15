import * as errors from '../errors.js';

/**
 * Grammar of a file ID a client may choose on `upload/init`: `file_` followed by
 * 8 to 64 characters from `[A-Za-z0-9_-]`. Server-generated IDs (current and
 * earlier formats) and the client SDK's `generateFileId()` output match it.
 */
export const CLIENT_FILE_ID_PATTERN = /^file_[A-Za-z0-9_-]{8,64}$/;

export function isValidClientFileId(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_FILE_ID_PATTERN.test(value);
}

/**
 * Returns the client-chosen file ID, or `undefined` when the request names none
 * (`null` or omitted), in which case the server generates one. Any other value
 * outside the grammar, including an empty string or a non-string, is refused
 * with 400 `FILEFN_INVALID_FILE_ID`.
 */
export function parseRequestedFileId(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isValidClientFileId(value)) {
    throw errors.invalidFileId();
  }
  return value;
}

/**
 * How long one serialized call may hold its key before later calls of the same
 * key stop waiting for it. A call that never settles (for example a Workers
 * request cancelled when its client disconnected, or storage I/O that never
 * resolves) then delays later calls by at most this long instead of forever.
 */
export const SERIALIZED_HOLD_TIMEOUT_MS = 60_000;

/**
 * Runs callbacks one at a time per key within this process. FileFn uses it to
 * serialize upload completion per session and its commit section per `fileId`.
 * It is not a cross-process lock: across processes the unique `files.fileId`
 * constraint decides which completion creates a file.
 *
 * Each call holds its key until it settles or `holdTimeoutMs` passes,
 * whichever is first. After the timeout the next call proceeds even if the
 * earlier one is still running, as a call in another process would, and the
 * key's entry is dropped once no call is waiting on it.
 */
export function createKeyedSerializer(options: { holdTimeoutMs?: number } = {}) {
  const holdTimeoutMs = options.holdTimeoutMs ?? SERIALIZED_HOLD_TIMEOUT_MS;
  const tails = new Map<string, Promise<void>>();

  async function runSerialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // This call's turn starts when the previous turn ends and ends when this
    // call settles or its hold times out.
    const tail = previous.then(() => {
      timer = setTimeout(release, holdTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
      return released;
    });
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) {
        tails.delete(key);
      }
    });

    await previous;
    try {
      return await fn();
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  /** Number of keys with a call running or waiting (for tests). */
  runSerialized.activeKeys = (): number => tails.size;
  return runSerialized;
}

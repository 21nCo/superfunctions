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
 * Runs callbacks one at a time per key within this process. FileFn uses it to
 * serialize the commit section of upload completion per `fileId`. It is not a
 * cross-process lock: across processes the unique `files.fileId` constraint
 * decides which completion creates a file.
 */
export function createKeyedSerializer() {
  const tails = new Map<string, Promise<void>>();

  return async function runSerialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    tails.set(key, tail);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) {
        tails.delete(key);
      }
    }
  };
}

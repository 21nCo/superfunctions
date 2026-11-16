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
 * How long a call waits for an earlier call of the same key before it gives up
 * with the retryable 409 `FILEFN_UPLOAD_COMPLETION_IN_PROGRESS`. The timer
 * belongs to the waiting call, so it fires even when the earlier call's request
 * was cancelled and that call never settles.
 */
export const SERIALIZED_WAIT_TIMEOUT_MS = 30_000;

export interface SerializedRunOptions {
  /**
   * Time (epoch ms) from which a call that has timed out waiting may take the
   * key from this call while it may still be running. Only set it where such an
   * overlap is harmless. Omitted: this call holds the key until it settles.
   */
  evictableAt?: number;
  /**
   * This call never gives up: each time its wait times out without being able
   * to take the key, it keeps waiting. For a call that has already done work a
   * retry could not redo (FileFn's commit step, which runs after storage
   * completion and holds its key only for database steps).
   */
  keepWaiting?: boolean;
}

interface Turn {
  evictableAt?: number;
}

interface KeyState {
  holder: Turn;
  waiters: Array<{ turn: Turn; grant: () => void }>;
}

/**
 * Runs callbacks one at a time per key within this process. FileFn uses it to
 * serialize upload completion per session and per `fileId`. It is not a
 * cross-process lock: across processes the unique `files.fileId` constraint
 * decides which completion creates a file.
 *
 * A call runs only while it holds its key, and holds it until it settles. A
 * call that cannot get the key within `waitTimeoutMs` fails with the retryable
 * `FILEFN_UPLOAD_COMPLETION_IN_PROGRESS` without running, leaving no trace on
 * the key, unless the holder's `evictableAt` has passed: then it takes the key
 * and runs. A `keepWaiting` call keeps waiting instead of failing. Memory per
 * key is one holder entry plus the calls still waiting; a key's entry is
 * dropped when its last call settles. A holder that never settles and is never
 * evictable keeps its key's entry, and later calls of that key fail with the
 * retryable error after waiting (`keepWaiting` calls wait), until the process
 * restarts.
 */
export function createKeyedSerializer(options: { waitTimeoutMs?: number } = {}) {
  const waitTimeoutMs = options.waitTimeoutMs ?? SERIALIZED_WAIT_TIMEOUT_MS;
  const keys = new Map<string, KeyState>();

  function acquire(key: string, turn: Turn, keepWaiting = false): Promise<KeyState> | KeyState {
    const state = keys.get(key);
    if (!state) {
      const created: KeyState = { holder: turn, waiters: [] };
      keys.set(key, created);
      return created;
    }
    return new Promise<KeyState>((resolve, reject) => {
      const waiter = {
        turn,
        grant: () => {
          clearTimeout(timer);
          resolve(state);
        },
      };
      state.waiters.push(waiter);
      const onTimeout = () => {
        const index = state.waiters.indexOf(waiter);
        if (index < 0) return;
        const { evictableAt } = state.holder;
        if (evictableAt !== undefined && Date.now() >= evictableAt) {
          state.waiters.splice(index, 1);
          // The evicted call's release no longer touches the key.
          state.holder = turn;
          resolve(state);
          return;
        }
        if (keepWaiting) {
          timer = setTimeout(onTimeout, waitTimeoutMs);
          return;
        }
        state.waiters.splice(index, 1);
        reject(errors.uploadCompletionInProgress());
      };
      let timer = setTimeout(onTimeout, waitTimeoutMs);
    });
  }

  function release(key: string, state: KeyState, turn: Turn): void {
    if (state.holder !== turn) return;
    const next = state.waiters.shift();
    if (next) {
      state.holder = next.turn;
      next.grant();
    } else if (keys.get(key) === state) {
      keys.delete(key);
    }
  }

  async function runSerialized<T>(key: string, fn: () => Promise<T>, runOptions: SerializedRunOptions = {}): Promise<T> {
    const turn: Turn = { evictableAt: runOptions.evictableAt };
    const state = await acquire(key, turn, runOptions.keepWaiting);
    try {
      return await fn();
    } finally {
      release(key, state, turn);
    }
  }

  /** Number of keys with a call running or waiting (for tests). */
  runSerialized.activeKeys = (): number => keys.size;
  return runSerialized;
}

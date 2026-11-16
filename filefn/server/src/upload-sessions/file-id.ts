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
  /** Identifies this call to later calls of its key that probe with `sharesKeyWith`. */
  member?: string;
  /**
   * Set where calls of one key may belong to independent groups (FileFn: the
   * fileId key on adapters without unique constraints, where a group is one
   * store). When the key is busy, this call is shown the members of each group
   * holding or waiting for it and joins the first group this resolves true
   * for; if none, it starts its own group and runs without waiting.
   * Omitted: one group per key.
   */
  sharesKeyWith?: (members: readonly string[]) => Promise<boolean>;
}

interface Turn {
  evictableAt?: number;
  member?: string;
}

interface KeyState {
  holder: Turn;
  waiters: Array<{ turn: Turn; grant: () => void }>;
}

/**
 * Runs callbacks one at a time per key (and per group, see `sharesKeyWith`)
 * within this process. FileFn uses it to serialize upload completion per
 * session and per `fileId`. It is not a cross-process lock: across processes
 * the unique `files.fileId` constraint decides which completion creates a file.
 *
 * A call runs only while it holds its key, and holds it until it settles or a
 * waiter takes the key past its `evictableAt`. A call that cannot get the key
 * within `waitTimeoutMs` fails with the retryable
 * `FILEFN_UPLOAD_COMPLETION_IN_PROGRESS` without running, leaving no trace on
 * the key, unless the holder's `evictableAt` has passed: then it takes the key
 * and runs. A `keepWaiting` call keeps waiting instead of failing. Memory per
 * key is one holder entry per group plus the calls still waiting; a group's
 * entry is dropped when its last call settles. A holder that never settles and
 * is never evictable keeps its group's entry, and later calls of that group
 * fail with the retryable error after waiting (`keepWaiting` calls wait),
 * until the process restarts.
 */
export function createKeyedSerializer(options: { waitTimeoutMs?: number } = {}) {
  const waitTimeoutMs = options.waitTimeoutMs ?? SERIALIZED_WAIT_TIMEOUT_MS;
  const keys = new Map<string, KeyState[]>();

  function start(key: string, turn: Turn): KeyState {
    const created: KeyState = { holder: turn, waiters: [] };
    keys.set(key, [...(keys.get(key) ?? []), created]);
    return created;
  }

  function wait(state: KeyState, turn: Turn, keepWaiting: boolean): Promise<KeyState> {
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

  function membersOf(state: KeyState): string[] {
    return [state.holder, ...state.waiters.map((waiter) => waiter.turn)]
      .map((turn) => turn.member)
      .filter((member): member is string => member !== undefined);
  }

  // Probes every group not yet probed, then decides synchronously against the
  // live groups: it joins a matching group still present, probes groups
  // started meanwhile, or starts its own group once none is left unprobed. So
  // two calls of one group never both start a group while either is live.
  async function acquireAmong(
    key: string,
    turn: Turn,
    keepWaiting: boolean,
    sharesKeyWith: (members: readonly string[]) => Promise<boolean>,
  ): Promise<KeyState> {
    const probed = new Set<KeyState>();
    for (;;) {
      const unprobed = (keys.get(key) ?? []).filter((state) => !probed.has(state));
      if (unprobed.length === 0) return start(key, turn);
      unprobed.forEach((state) => probed.add(state));
      const shared = await Promise.all(unprobed.map((state) => sharesKeyWith(membersOf(state))));
      const live = keys.get(key) ?? [];
      const match = unprobed.find((state, index) => shared[index] && live.includes(state));
      if (match) return wait(match, turn, keepWaiting);
    }
  }

  function acquire(key: string, turn: Turn, runOptions: SerializedRunOptions): Promise<KeyState> | KeyState {
    const groups = keys.get(key);
    if (!groups) return start(key, turn);
    const keepWaiting = runOptions.keepWaiting ?? false;
    if (runOptions.sharesKeyWith) return acquireAmong(key, turn, keepWaiting, runOptions.sharesKeyWith);
    return wait(groups[0], turn, keepWaiting);
  }

  function release(key: string, state: KeyState, turn: Turn): void {
    if (state.holder !== turn) return;
    const next = state.waiters.shift();
    if (next) {
      state.holder = next.turn;
      next.grant();
      return;
    }
    const groups = keys.get(key)?.filter((group) => group !== state);
    if (groups === undefined) return;
    if (groups.length > 0) keys.set(key, groups);
    else keys.delete(key);
  }

  async function runSerialized<T>(key: string, fn: () => Promise<T>, runOptions: SerializedRunOptions = {}): Promise<T> {
    const turn: Turn = { evictableAt: runOptions.evictableAt, member: runOptions.member };
    const state = await acquire(key, turn, runOptions);
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

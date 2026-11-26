import type {
  OfflineQueueDirectoryHandle,
  OfflineQueueFileHandle,
  OfflineQueueLockCoordinator,
} from '../../offline/queue.js';

/**
 * Test doubles for the offline queue: an in-memory OPFS shared by every "tab"
 * of a test (it survives reloads), and a lock manager with the semantics of
 * `navigator.locks` that, like a browser, releases a tab's locks when it closes.
 */

/** Called before each write and commit; throw to inject a fault (a crash or a full disk). */
export type StorageFault = (path: string, step: 'write' | 'close') => void;

interface Storage {
  fault?: StorageFault;
}

function notFound(name: string): DOMException {
  return new DOMException(`${name} not found`, 'NotFoundError');
}

export class MemoryDirectory implements OfflineQueueDirectoryHandle {
  readonly entries = new Map<string, MemoryDirectory | MemoryFile>();

  constructor(
    readonly path = '',
    readonly storage: Storage = {},
  ) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectory> {
    let entry = this.entries.get(name);
    if (!entry && options?.create) {
      entry = new MemoryDirectory(`${this.path}/${name}`, this.storage);
      this.entries.set(name, entry);
    }
    if (!entry) throw notFound(name);
    if (!(entry instanceof MemoryDirectory)) throw new DOMException(`${name} is a file`, 'TypeMismatchError');
    return entry;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFile> {
    let entry = this.entries.get(name);
    if (!entry && options?.create) {
      entry = new MemoryFile(name, `${this.path}/${name}`, this.storage);
      this.entries.set(name, entry);
    }
    if (!entry) throw notFound(name);
    if (!(entry instanceof MemoryFile)) throw new DOMException(`${name} is a directory`, 'TypeMismatchError');
    return entry;
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) throw notFound(name);
    if (entry instanceof MemoryDirectory && entry.entries.size > 0 && !options?.recursive) {
      throw new DOMException(`${name} is not empty`, 'InvalidModificationError');
    }
    this.entries.delete(name);
  }

  async *values(): AsyncIterable<{ kind: 'file' | 'directory'; name: string }> {
    for (const [name, entry] of [...this.entries]) {
      yield { name, kind: entry instanceof MemoryDirectory ? 'directory' : 'file' };
    }
  }

  /** Every file path below this directory, sorted. */
  files(): string[] {
    const out: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry instanceof MemoryDirectory) out.push(...entry.files());
      else out.push(entry.path);
    }
    return out.sort();
  }
}

export class MemoryFile implements OfflineQueueFileHandle {
  content: Uint8Array<ArrayBufferLike> = new Uint8Array();

  constructor(
    readonly name: string,
    readonly path: string,
    readonly storage: Storage,
  ) {}

  async getFile(): Promise<Blob> {
    return new File([this.content.slice()], this.name);
  }

  async createWritable() {
    let staged: Uint8Array<ArrayBufferLike> | undefined;
    let aborted = false;
    return {
      write: async (data: ArrayBuffer | string) => {
        this.storage.fault?.(this.path, 'write');
        staged = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data.slice(0));
      },
      // Like OPFS, the new content replaces the old one only when the writable closes.
      close: async () => {
        this.storage.fault?.(this.path, 'close');
        if (aborted) throw new TypeError('Writable was aborted');
        if (staged) this.content = staged;
      },
      // Like OPFS, an aborted writable never replaces the content.
      abort: async () => {
        aborted = true;
        staged = undefined;
      },
    };
  }
}

export function createStorage(): { root: MemoryDirectory; storage: Storage } {
  const storage: Storage = {};
  return { root: new MemoryDirectory('', storage), storage };
}

export function quotaExceeded(): DOMException {
  return new DOMException('The quota has been exceeded.', 'QuotaExceededError');
}

/** Exclusive named locks shared by every tab of one origin. */
export class SharedLockManager {
  private readonly held = new Map<string, { token: symbol; tab: string }>();
  private readonly waiting = new Map<string, Array<() => void>>();
  private readonly closed = new Set<string>();
  readonly requests: string[] = [];

  forTab(tab: string): OfflineQueueLockCoordinator {
    return { request: (name, options, callback) => this.request(tab, name, options, callback) };
  }

  isHeld(name: string): boolean {
    return this.held.has(name);
  }

  heldNames(): string[] {
    return [...this.held.keys()];
  }

  /** A closed tab's locks are released at once, even if its callbacks never return. */
  closeTab(tab: string): void {
    this.closed.add(tab);
    for (const [name, holder] of [...this.held]) {
      if (holder.tab === tab) this.releaseIfHeld(name, holder.token);
    }
  }

  private async request<T>(
    tab: string,
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal; mode?: string },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T> {
    if (this.closed.has(tab)) throw new DOMException('Tab closed', 'AbortError');
    this.requests.push(name);
    if (options.ifAvailable) {
      if (this.held.has(name)) return callback(null);
      return this.run(tab, name, callback);
    }
    while (this.held.has(name)) {
      await new Promise<void>((resolve, reject) => {
        const list = this.waiting.get(name) ?? [];
        const onAbort = () => {
          const index = list.indexOf(wake);
          if (index >= 0) list.splice(index, 1);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        const wake = () => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        options.signal?.addEventListener('abort', onAbort, { once: true });
        list.push(wake);
        this.waiting.set(name, list);
      });
    }
    if (this.closed.has(tab)) throw new DOMException('Tab closed', 'AbortError');
    return this.run(tab, name, callback);
  }

  private async run<T>(tab: string, name: string, callback: (lock: unknown) => Promise<T>): Promise<T> {
    const token = Symbol(name);
    this.held.set(name, { token, tab });
    try {
      return await callback(token);
    } finally {
      this.releaseIfHeld(name, token);
    }
  }

  private releaseIfHeld(name: string, token: symbol): void {
    if (this.held.get(name)?.token !== token) return;
    this.held.delete(name);
    this.waiting.get(name)?.shift()?.();
  }
}

/** A promise with its resolve and reject exposed. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

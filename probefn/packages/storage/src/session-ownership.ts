import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { realpath, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createProbefnError, isProbefnError } from '@probefn/contracts/errors';
import { assertArtifactIdentifier } from './manifest-writer.js';
import { safeDirectory, safeFile } from './run-quota.js';

const ownedContext = new AsyncLocalStorage<SessionOwnership>();
const DEFAULT_MAX_SLOTS = 256;
const REGISTRY_BYTES = 32 * 1024 * 1024;
const SLOT_BYTES = 8192;
const ownershipFailure = (message: string, cause?: unknown) => createProbefnError({
  code: 'E_STORAGE_WRITE_FAILED', message, retryable: false, ...(cause ? { cause } : {}),
});
interface HeldSlot { database: DatabaseSync; filename: string; dev: number; ino: number }

/** Native SQLite write locks have no expiry and are released by process death. */
export class SessionOwnership {
  private released = false;
  private constructor(private readonly slots: HeldSlot[], private readonly directory: string, private readonly runKey: string, private readonly fold: boolean, private readonly sessionKey?: string) {}

  public static async acquire(input: { repoRoot: string; artifactRoot: string; sessionId?: string; runId: string; maxOwnershipSlots?: number }): Promise<SessionOwnership> {
    if (input.maxOwnershipSlots !== undefined && (!Number.isSafeInteger(input.maxOwnershipSlots) || input.maxOwnershipSlots < 2 || input.maxOwnershipSlots > 65536)) {
      throw createProbefnError({ code: 'E_CONFIG_INVALID', message: 'maxOwnershipSlots must be an integer from 2 through 65536.', retryable: false });
    }
    if (input.sessionId !== undefined) assertArtifactIdentifier(input.sessionId, 'Session id');
    assertArtifactIdentifier(input.runId, 'Run id');
    const root = await realpath(input.repoRoot);
    const relative = path.posix.join(input.artifactRoot, '.ownership');
    await safeDirectory(root, relative);
    const directory = await realpath(path.resolve(root, relative));
    // Let the actual volume determine case aliases; do not assume Darwin or Windows means insensitive.
    const alternate = await realpath(path.join(path.dirname(directory), '.OWNERSHIP')).catch(() => undefined);
    const fold = alternate === directory;
    const keys = [...(input.sessionId === undefined ? [] : [`session:${input.sessionId}`]), `run:${input.runId}`].map(key => fold ? key.toLowerCase() : key).sort();
    const registryPath = path.join(directory, 'registry.sqlite');
    for (const suffix of ['', '-journal', '-wal', '-shm']) await safeFile(registryPath + suffix);
    const registryInfo = await safeFile(registryPath);
    if (!registryInfo && (await readdir(directory)).some(name => /^[0-9a-f]{64}\.sqlite$/.test(name))) {
      throw ownershipFailure('Ownership registry disappeared while lock slots remain.');
    }
    const registry = new DatabaseSync(registryPath);
    const slots: HeldSlot[] = [];
    let transaction = false;
    try {
      configure(registry, REGISTRY_BYTES);
      registry.exec('BEGIN IMMEDIATE'); transaction = true;
      registry.exec('CREATE TABLE IF NOT EXISTS slots (identity TEXT PRIMARY KEY, filename TEXT NOT NULL, dev INTEGER NOT NULL, ino INTEGER NOT NULL)');
      registry.exec('CREATE TABLE IF NOT EXISTS limits (id INTEGER PRIMARY KEY CHECK(id=1), max_slots INTEGER NOT NULL)');
      const stored = registry.prepare('SELECT max_slots FROM limits WHERE id=1').get();
      const maximumSlots = input.maxOwnershipSlots ?? (stored ? Number(stored.max_slots) : DEFAULT_MAX_SLOTS);
      const allocatedAtStart = (await readdir(directory)).filter(name => /^[0-9a-f]{64}\.sqlite$/.test(name)).length;
      if (maximumSlots < allocatedAtStart) throw createProbefnError({ code: 'E_STORAGE_CAP_EXCEEDED', message: 'Ownership slot budget is below existing metadata allocation.', retryable: false });
      registry.prepare('INSERT INTO limits VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET max_slots=excluded.max_slots').run(maximumSlots);
      for (const key of keys) {
        const filename = path.join(directory, `${createHash('sha256').update(key).digest('hex')}.sqlite`);
        for (const suffix of ['-journal', '-wal', '-shm']) await safeFile(filename + suffix);
        const previous = registry.prepare('SELECT filename,dev,ino FROM slots WHERE identity=?').get(key);
        const before = await safeFile(filename);
        if (previous && (!before || previous.filename !== filename || previous.dev !== before.dev || previous.ino !== before.ino)) {
          throw ownershipFailure('Registered ownership lock was removed or replaced; refusing to fork authority.');
        }
        const allocated = (await readdir(directory)).filter(name => /^[0-9a-f]{64}\.sqlite$/.test(name)).length;
        if (!before && Math.max(allocated, Number(registry.prepare('SELECT count(*) AS n FROM slots').get()!.n)) >= maximumSlots) {
          throw createProbefnError({ code: 'E_STORAGE_CAP_EXCEEDED', message: 'Ownership metadata slot budget exhausted.', retryable: false,
            details: { budget: 'ownership-metadata', maxSlots: maximumSlots } });
        }
        const database = new DatabaseSync(filename);
        try {
          configure(database, SLOT_BYTES);
          database.exec('CREATE TABLE IF NOT EXISTS ownership (id INTEGER PRIMARY KEY CHECK(id=1))');
          database.exec('BEGIN IMMEDIATE');
          const info = await safeFile(filename);
          if (!info || (before && (before.dev !== info.dev || before.ino !== info.ino))) throw ownershipFailure('Ownership lock identity changed during acquisition.');
          slots.push({ database, filename, dev: info.dev, ino: info.ino });
          if (!previous) registry.prepare('INSERT INTO slots VALUES (?, ?, ?, ?)').run(key, filename, info.dev, info.ino);
        } catch (error) { database.close(); throw error; }
      }
      registry.exec('COMMIT'); transaction = false;
      const ownership = new SessionOwnership(slots, directory, fold ? input.runId.toLowerCase() : input.runId, fold, input.sessionId === undefined ? undefined : fold ? input.sessionId.toLowerCase() : input.sessionId);
      ownership.assertOwned();
      return ownership;
    } catch (error) {
      for (const slot of slots.reverse()) slot.database.close();
      if (transaction) registry.exec('ROLLBACK');
      if (isProbefnError(error)) throw error;
      if (error instanceof Error && /database is (locked|busy)/i.test(error.message)) {
        throw createProbefnError({ code: 'E_SESSION_ALREADY_RUNNING', message: 'Another process owns this session, run, or its admission registry.', retryable: true });
      }
      throw ownershipFailure('Could not establish session ownership.', error);
    } finally { registry.close(); }
  }

  /** Explicitly propagate this authority into asynchronous producers and their nested writes. */
  public run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOwned();
    return ownedContext.run(this, operation);
  }

  public static async withRun<T>(input: { repoRoot: string; artifactRoot: string; runId: string; sessionId?: string; maxOwnershipSlots?: number }, operation: (identity: { caseInsensitive: boolean }) => Promise<T>): Promise<T> {
    const active = ownedContext.getStore();
    if (active) {
      active.assertOwned();
      const directory = await realpath(path.resolve(input.repoRoot, input.artifactRoot, '.ownership'));
      const runKey = active.fold ? input.runId.toLowerCase() : input.runId;
      const sessionKey = input.sessionId === undefined ? undefined : active.fold ? input.sessionId.toLowerCase() : input.sessionId;
      if (directory !== active.directory || runKey !== active.runKey || (sessionKey !== undefined && sessionKey !== active.sessionKey)) throw ownershipFailure('Explicit ownership context does not cover this run.');
      return operation({ caseInsensitive: active.fold });
    }
    // Admission only: never retry producer effects, and never steal or expire an existing owner.
    const deadline = performance.now() + 1000;
    let lease: SessionOwnership;
    for (;;) {
      try { lease = await SessionOwnership.acquire(input); break; }
      catch (error) {
        if (!isProbefnError(error) || error.code !== 'E_SESSION_ALREADY_RUNNING' || performance.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    try { return await lease.run(() => operation({ caseInsensitive: lease.fold })); } finally { lease.release(); }
  }

  public assertOwned(): void {
    if (this.released) throw ownershipFailure('Session ownership has already been released.');
    for (const slot of this.slots) {
      let current;
      try { current = lstatSync(slot.filename); } catch (error) { throw ownershipFailure('Owned lock disappeared.', error); }
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== slot.dev || current.ino !== slot.ino) {
        throw ownershipFailure('Owned lock was replaced.');
      }
    }
  }

  /** Never unlink a lock DB: its stable inode is part of the ownership protocol. */
  public release(): void {
    if (this.released) return;
    this.released = true;
    for (const slot of [...this.slots].reverse()) slot.database.close();
  }
}

function configure(database: DatabaseSync, maximumBytes: number): void {
  database.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;');
  const mode = database.prepare('PRAGMA journal_mode=DELETE').get()!.journal_mode;
  if (mode !== 'delete') throw ownershipFailure('Ownership requires SQLite DELETE journal mode.');
  const pageSize = Number(database.prepare('PRAGMA page_size').get()!.page_size);
  const pages = Math.floor(maximumBytes / pageSize);
  if (Number(database.prepare(`PRAGMA max_page_count=${pages}`).get()!.max_page_count) > pages) {
    throw ownershipFailure('Ownership database exceeds its fixed metadata budget.');
  }
}

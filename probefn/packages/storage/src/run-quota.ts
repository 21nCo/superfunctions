import path from 'node:path';
import { createReadStream, constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createProbefnError } from '@probefn/contracts/errors';
import { assertArtifactIdentifier, assertRepositoryRelativePath } from './manifest-writer.js';
import type { AppendEventResult } from './event-sink.js';
import { DEFAULT_ACCOUNTING_DATABASE_BYTES, type EventCapPolicy } from './caps.js';

const queues = new Map<string, Promise<void>>();
const failed = (message: string, cause?: unknown) => createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message, retryable: false, ...(cause ? { cause } : {}) });
const busy = (error: unknown) => error instanceof Error && /database is (locked|busy)/i.test(error.message);

/** All cooperating writers use a SQLite OS lock; connections never escape one queued operation. */
export class RunQuota {
  public constructor(private readonly repoRoot: string, private readonly artifactRoot: string, private readonly configuredCap: number,
    private readonly accountingLimit = DEFAULT_ACCOUNTING_DATABASE_BYTES) {
    if (!Number.isSafeInteger(accountingLimit) || accountingLimit < 65536) throw new TypeError('Accounting database cap must be a safe integer of at least 65536 bytes.');
  }

  public async transaction<T>(runId: string, target: string, operation: (quota: QuotaTransaction) => Promise<T>, external = false): Promise<T> {
    assertArtifactIdentifier(runId, 'Run id');
    const databasePath = path.resolve(this.repoRoot, this.artifactRoot, '.quota.sqlite');
    const prior = queues.get(databasePath) ?? Promise.resolve();
    const task = prior.then(async () => {
      await safeDirectory(this.repoRoot, this.artifactRoot);
      for (const suffix of ['', '-journal', '-wal', '-shm']) await safeFile(databasePath + suffix);
      const database = new DatabaseSync(databasePath);
      let effectiveAccountingLimit = this.accountingLimit;
      try {
        await retryBusy(() => database.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;'));
        await retryBusy(() => {
          const mode = database.prepare('PRAGMA journal_mode=DELETE').get()!.journal_mode;
          if (mode !== 'delete') throw failed('Accounting database requires DELETE journal mode.');
        });
        await begin(database);
        effectiveAccountingLimit = this.applyAccountingLimit(database);
        database.exec('CREATE TABLE IF NOT EXISTS run_caps (run_id TEXT PRIMARY KEY, cap INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS external_paths (path TEXT PRIMARY KEY, run_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sink_counts (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime REAL NOT NULL, count INTEGER NOT NULL, inode TEXT NOT NULL);');
        if (!database.prepare('PRAGMA table_info(sink_counts)').all().some(row => row.name === 'inode')) database.exec("ALTER TABLE sink_counts ADD COLUMN inode TEXT NOT NULL DEFAULT ''");
        const priorCap = database.prepare('SELECT cap FROM run_caps WHERE run_id=?').get(runId);
        if (!priorCap) database.prepare('INSERT INTO run_caps VALUES (?, ?)').run(runId, this.configuredCap);
        else if (this.configuredCap < Number(priorCap.cap)) database.prepare('UPDATE run_caps SET cap=? WHERE run_id=?').run(this.configuredCap, runId);
        if (external) {
          const owner = database.prepare('SELECT run_id FROM external_paths WHERE path=?').get(target);
          if (owner && owner.run_id !== runId) throw failed('Session-state artifact already belongs to another run; use a new session id.');
          if (!owner) database.prepare('INSERT INTO external_paths VALUES (?, ?)').run(target, runId);
        }
        // Persist the cap/ownership before file IO: a crash must not reset a first-write cap.
        await retryBusy(() => database.exec('COMMIT'));
        await begin(database);
        effectiveAccountingLimit = this.applyAccountingLimit(database);
        const cap = Number(database.prepare('SELECT cap FROM run_caps WHERE run_id=?').get(runId)!.cap);
        const runRoot = path.posix.join(this.artifactRoot, 'runs', runId);
        await safeDirectory(this.repoRoot, runRoot);
        const externalPaths = database.prepare('SELECT path FROM external_paths WHERE run_id=?').all(runId).map(row => String(row.path));
        let used = await scan(path.resolve(this.repoRoot, runRoot));
        for (const relative of externalPaths) {
          await safeDirectory(this.repoRoot, path.posix.dirname(relative));
          const item = await safeFile(path.resolve(this.repoRoot, relative));
          used += item?.size ?? 0;
        }
        const quota = new QuotaTransaction(this.repoRoot, database, cap, used);
        const result = await operation(quota);
        await retryBusy(() => database.exec('COMMIT'));
        return result;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch { /* No transaction may be active. */ }
        if (isSqliteFull(error)) throw accountingCapError(effectiveAccountingLimit, 'SQLite refused accounting database growth.', error);
        if (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('E_')) throw error;
        throw failed('Run artifact accounting failed.', error);
      } finally { database.close(); }
    });
    const settled = task.then(() => undefined, () => undefined);
    queues.set(databasePath, settled);
    void settled.then(() => { if (queues.get(databasePath) === settled) queues.delete(databasePath); });
    return task;
  }

  private applyAccountingLimit(database: DatabaseSync): number {
    // BEGIN IMMEDIATE excludes every cooperating writer before reading the minimum.
    const exists = database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='accounting_limits'").get();
    const stored = exists ? database.prepare('SELECT max_bytes FROM accounting_limits WHERE id=1').get() : undefined;
    const limit = Math.min(this.accountingLimit, stored ? Number(stored.max_bytes) : this.accountingLimit);
    const pageSize = Number(database.prepare('PRAGMA page_size').get()!.page_size);
    const pages = Math.floor(limit / pageSize);
    const actual = Number(database.prepare(`PRAGMA max_page_count=${pages}`).get()!.max_page_count);
    if (actual > pages) throw accountingCapError(limit, 'Existing accounting database exceeds the configured page limit.');
    database.exec('CREATE TABLE IF NOT EXISTS accounting_limits (id INTEGER PRIMARY KEY CHECK(id=1), max_bytes INTEGER NOT NULL)');
    database.prepare('INSERT INTO accounting_limits VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET max_bytes=min(max_bytes,excluded.max_bytes)').run(limit);
    return limit;
  }

}

function accountingCapError(limit: number, message: string, cause?: unknown) {
  return createProbefnError({ code: 'E_STORAGE_CAP_EXCEEDED', message, retryable: false,
    details: { budget: 'accounting-database', maxAccountingDatabaseBytes: limit }, ...(cause ? { cause } : {}) });
}
function isSqliteFull(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('errcode' in error && typeof error.errcode === 'number' && (error.errcode & 255) === 13) return true;
  return 'cause' in error && error.cause !== error && isSqliteFull(error.cause);
}

async function begin(database: DatabaseSync): Promise<void> {
  await retryBusy(() => database.exec('BEGIN IMMEDIATE'));
}
async function retryBusy(operation: () => void): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { operation(); return; }
    catch (error) {
      if (!busy(error) || Date.now() >= deadline) throw failed('Could not acquire run artifact transaction within 30 seconds.', error);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

export class QuotaTransaction {
  public constructor(private readonly repoRoot: string, private readonly database: DatabaseSync, private readonly cap: number, private used: number) {}
  public reserve(bytes: number, targetPath: string): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw failed('Invalid artifact byte count.');
    if (this.used + bytes > this.cap) throw createProbefnError({ code: 'E_STORAGE_CAP_EXCEEDED', message: `Artifact cap exceeded before ${targetPath} could be committed.`, retryable: false, details: { targetPath, maxArtifactBytes: this.cap, attemptedTotalBytes: this.used + bytes } });
    this.used += bytes;
  }
  public async prepare(relative: string): Promise<string> {
    const normalized = assertRepositoryRelativePath(relative);
    await safeDirectory(this.repoRoot, path.posix.dirname(normalized));
    await safeFile(path.resolve(this.repoRoot, normalized));
    return path.resolve(this.repoRoot, normalized);
  }
  public async append(relativeDirectory: string, baseName: string, payload: string, policy: EventCapPolicy): Promise<AppendEventResult> {
    await safeDirectory(this.repoRoot, relativeDirectory);
    const names = await readdir(path.resolve(this.repoRoot, relativeDirectory));
    let index = 1;
    for (const name of names) {
      if (name === `${baseName}.ndjson`) continue;
      if (name.startsWith(`${baseName}-`) && name.endsWith('.ndjson')) {
        const suffix = name.slice(baseName.length + 1, -7);
        if (/^\d+$/.test(suffix)) index = Math.max(index, Number(suffix));
      }
    }
    const filename = (number: number) => number === 1 ? `${baseName}.ndjson` : `${baseName}-${String(number).padStart(4, '0')}.ndjson`;
    let relativePath = path.posix.join(relativeDirectory, filename(index));
    let absolute = await this.prepare(relativePath);
    let count = await this.eventCount(absolute, relativePath);
    const rollover = count >= policy.maxEventsPerSink;
    if (rollover) {
      if (policy.strategy === 'error') throw createProbefnError({ code: 'E_STORAGE_CAP_EXCEEDED', message: `Event cap exceeded for ${relativePath}.`, retryable: false });
      index += 1; count = 0;
      relativePath = path.posix.join(relativeDirectory, filename(index));
      absolute = await this.prepare(relativePath);
    }
    this.reserve(Buffer.byteLength(payload), relativePath);
    const file = await open(absolute, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(payload); await file.sync(); }
    finally { await file.close(); }
    const info = (await safeFile(absolute))!;
    this.database.prepare('INSERT INTO sink_counts VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,count=excluded.count,inode=excluded.inode').run(relativePath, info.size, info.mtimeMs, count + 1, String(info.ino));
    return { relativePath, eventCount: count + 1, sinkIndex: index, ...(rollover ? { warning: `Event cap reached; rollover sink ${filename(index)} created.` } : {}) };
  }
  private async eventCount(absolute: string, relative: string): Promise<number> {
    const info = await safeFile(absolute);
    if (!info || info.size === 0) return 0;
    const cached = this.database.prepare('SELECT size,mtime,count,inode FROM sink_counts WHERE path=?').get(relative);
    if (cached && cached.size === info.size && cached.mtime === info.mtimeMs && cached.inode === String(info.ino)) return Number(cached.count);
    let count = 0, last = -1;
    for await (const chunk of createReadStream(absolute)) {
      for (const byte of chunk as Buffer) if (byte === 10) count++;
      last = (chunk as Buffer).at(-1) ?? last;
    }
    if (last !== 10) throw failed('Event sink contains an incomplete record; refusing to append.');
    return count;
  }
}

/** Application-owned tree only: reject links and special files, including pre-existing ancestors. */
export async function safeDirectory(repoRoot: string, relative: string): Promise<void> {
  const normalized = assertRepositoryRelativePath(relative);
  let current = path.resolve(repoRoot);
  const root = await lstat(current);
  if (!root.isDirectory() || root.isSymbolicLink()) throw failed('Repository root must be an owned directory.');
  for (const segment of normalized.split('/').filter(value => value !== '.')) {
    current = path.join(current, segment);
    try { await mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw failed('Artifact ancestor is not a regular directory.');
  }
}
async function safeFile(filename: string) {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !Number.isSafeInteger(info.ino)) throw failed('Artifact path must be a regular file without links.');
    return info;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function scan(directory: string, staging = false): Promise<number> {
  let total = 0;
  for (const name of await readdir(directory)) {
    const filename = path.join(directory, name);
    const info = await lstat(filename);
    if (info.isSymbolicLink()) throw failed('Run contains a symbolic link.');
    if (info.isDirectory()) total += await scan(filename, name === '.probefn-staging');
    else {
      if (!info.isFile() || info.nlink !== 1) throw failed('Run contains a special or linked file.');
      // Exclusive OS lock proves no cooperating writer can own a live staging file.
      if (staging && /\.probefn-tmp-[0-9a-f-]+$/.test(name)) await rm(filename);
      else total += info.size;
    }
  }
  return total;
}

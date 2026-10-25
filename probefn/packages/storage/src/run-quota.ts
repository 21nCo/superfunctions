import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { SessionOwnership } from './session-ownership.js';
import { EMPTY_EVENT_CHAIN, eventDigest, extendEventChain, inspectEventPrefix, parseEventIntent, reconcileEventAppend, type EventAppendIntent } from './event-journal.js';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createProbefnError } from '@probefn/contracts/errors';
import { assertArtifactIdentifier, assertRepositoryRelativePath } from './manifest-writer.js';
import type { AppendEventResult } from './event-sink.js';
import { DEFAULT_ACCOUNTING_DATABASE_BYTES, DEFAULT_STORAGE_CAPS, type EventCapPolicy } from './caps.js';

const queues = new Map<string, Promise<void>>();
const activeTransaction = new AsyncLocalStorage<boolean>();
const failed = (message: string, cause?: unknown) => createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message, retryable: false, ...(cause ? { cause } : {}) });
const busy = (error: unknown) => error instanceof Error && /database is (locked|busy)/i.test(error.message);

/** All cooperating writers use a SQLite OS lock; connections never escape one queued operation. */
export class RunQuota {
  public constructor(private readonly repoRoot: string, private readonly artifactRoot: string, private readonly configuredCap?: number,
    private readonly accountingLimit?: number,
    private readonly configuredEventCap?: number,
    private readonly maxOwnershipSlots?: number) {
    if (accountingLimit !== undefined && (!Number.isSafeInteger(accountingLimit) || accountingLimit < 65536)) throw new TypeError('Accounting database cap must be a safe integer of at least 65536 bytes.');
  }

  public owned<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    return SessionOwnership.withRun({ repoRoot: this.repoRoot, artifactRoot: this.artifactRoot, runId, ...(this.maxOwnershipSlots === undefined ? {} : { maxOwnershipSlots: this.maxOwnershipSlots }) }, operation);
  }

  public async transaction<T>(runId: string, target: string, operation: (quota: QuotaTransaction) => Promise<T>, external = false, eventWrite = false): Promise<T> {
    if (activeTransaction.getStore()) throw failed('Nested managed storage transactions are unsupported; finish the producer before starting another write.');
    assertArtifactIdentifier(runId, 'Run id');
    let sessionId: string | undefined;
    if (external) {
      const prefix = path.posix.join(this.artifactRoot, 'session-state') + '/';
      const normalized = assertRepositoryRelativePath(target);
      if (!normalized.startsWith(prefix) || !normalized.endsWith('.json')) throw failed('External run accounting requires a session-state JSON path.');
      sessionId = normalized.slice(prefix.length, -5);
      assertArtifactIdentifier(sessionId, 'Session id');
    }

    const databasePath = path.resolve(this.repoRoot, this.artifactRoot, '.quota.sqlite');
    const prior = queues.get(databasePath) ?? Promise.resolve();
    const task = prior.then(() => SessionOwnership.withRun({ repoRoot: this.repoRoot, artifactRoot: this.artifactRoot, runId, ...(sessionId === undefined ? {} : { sessionId }), ...(this.maxOwnershipSlots === undefined ? {} : { maxOwnershipSlots: this.maxOwnershipSlots }) }, async identity => {
      await safeDirectory(this.repoRoot, this.artifactRoot);
      if (identity.caseInsensitive) {
        for (const [directory, name] of [[path.posix.join(this.artifactRoot, 'runs'), runId], ...(sessionId === undefined ? [] : [[path.posix.join(this.artifactRoot, 'session-state'), sessionId + '.json']])] as [string, string][]) {
          await safeDirectory(this.repoRoot, directory);
          const existing = (await readdir(path.resolve(this.repoRoot, directory))).find(item => item.toLowerCase() === name.toLowerCase());
          if (existing !== undefined && existing !== name) throw failed('Run/session path casing must match its persisted identity.');
        }
      }
      for (const suffix of ['', '-journal', '-wal', '-shm']) await safeFile(databasePath + suffix);
      const database = new DatabaseSync(databasePath);
      let effectiveAccountingLimit = this.accountingLimit ?? DEFAULT_ACCOUNTING_DATABASE_BYTES;
      try {
        // The coordinator now contains redacted event bodies, matching private sink permissions.
        await chmod(databasePath, 0o600);
        await retryBusy(() => database.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;'));
        await retryBusy(() => {
          const mode = database.prepare('PRAGMA journal_mode=DELETE').get()!.journal_mode;
          if (mode !== 'delete') throw failed('Accounting database requires DELETE journal mode.');
        });
        await begin(database);
        effectiveAccountingLimit = this.applyAccountingLimit(database);
        database.exec('CREATE TABLE IF NOT EXISTS run_caps (run_id TEXT PRIMARY KEY, cap INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS external_paths (path TEXT PRIMARY KEY, run_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sink_counts (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime REAL NOT NULL, count INTEGER NOT NULL, inode TEXT NOT NULL);');
        if (!database.prepare('PRAGMA table_info(sink_counts)').all().some(row => row.name === 'inode')) database.exec("ALTER TABLE sink_counts ADD COLUMN inode TEXT NOT NULL DEFAULT ''");
        if (!database.prepare('PRAGMA table_info(run_caps)').all().some(row => row.name === 'max_events')) database.exec('ALTER TABLE run_caps ADD COLUMN max_events INTEGER NOT NULL DEFAULT 50000');
        database.exec('CREATE TABLE IF NOT EXISTS event_journal_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)');
        const version = database.prepare('SELECT version FROM event_journal_schema WHERE id=1').get();
        if (version && version.version !== 1) throw failed('Unsupported event journal schema version.');
        database.exec('INSERT OR IGNORE INTO event_journal_schema VALUES (1,1)');
        if (!database.prepare('PRAGMA table_info(run_caps)').all().some(row => row.name === 'event_failed')) database.exec('ALTER TABLE run_caps ADD COLUMN event_failed INTEGER NOT NULL DEFAULT 0');
        if (!database.prepare('PRAGMA table_info(sink_counts)').all().some(row => row.name === 'chain_digest')) database.exec("ALTER TABLE sink_counts ADD COLUMN chain_digest TEXT NOT NULL DEFAULT ''");
        database.exec('CREATE TABLE IF NOT EXISTS event_append_intents (run_id TEXT PRIMARY KEY, intent TEXT NOT NULL)');
        database.exec('CREATE TABLE IF NOT EXISTS capture_scratch_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)');
        const scratchVersion = database.prepare('SELECT version FROM capture_scratch_schema WHERE id=1').get();
        if (scratchVersion && scratchVersion.version !== 1) throw failed('Unsupported capture scratch schema version.');
        database.exec('INSERT OR IGNORE INTO capture_scratch_schema VALUES (1,1)');
        database.exec('CREATE TABLE IF NOT EXISTS capture_scratch (run_id TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(run_id,id))');
        const priorCap = database.prepare('SELECT cap FROM run_caps WHERE run_id=?').get(runId);
        if (!priorCap) database.prepare('INSERT INTO run_caps (run_id,cap,max_events) VALUES (?, ?, ?)').run(runId, this.configuredCap ?? DEFAULT_STORAGE_CAPS.maxArtifactBytes, this.configuredEventCap ?? DEFAULT_STORAGE_CAPS.maxEventsPerSink);
        else if (this.configuredCap !== undefined && this.configuredCap < Number(priorCap.cap)) database.prepare('UPDATE run_caps SET cap=? WHERE run_id=?').run(this.configuredCap, runId);
        if (this.configuredEventCap !== undefined) database.prepare('UPDATE run_caps SET max_events=min(max_events,?) WHERE run_id=?').run(this.configuredEventCap, runId);
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
        used += Number(database.prepare('SELECT count(*) * 4096 AS bytes FROM capture_scratch WHERE run_id=?').get(runId)!.bytes);
        for (const relative of externalPaths) {
          await safeDirectory(this.repoRoot, path.posix.dirname(relative));
          const item = await safeFile(path.resolve(this.repoRoot, relative));
          used += item?.size ?? 0;
        }
        const eventCap = Number(database.prepare('SELECT max_events FROM run_caps WHERE run_id=?').get(runId)!.max_events);
        const checkpoint = async () => {
          await retryBusy(() => database.exec('COMMIT'));
          await begin(database);
          effectiveAccountingLimit = this.applyAccountingLimit(database);
        };
        const quota = new QuotaTransaction(this.repoRoot, database, cap, used, eventCap, runId, runRoot, checkpoint);
        await quota.recoverEventWrite();
        if (eventWrite) await quota.armEventWrite();
        const result = await activeTransaction.run(true, () => operation(quota));
        await retryBusy(() => database.exec('COMMIT'));
        return result;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch { /* No transaction may be active. */ }
        if (isSqliteFull(error)) throw accountingCapError(effectiveAccountingLimit, 'SQLite refused accounting database growth.', error);
        if (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('E_')) throw error;
        throw failed('Run artifact accounting failed.', error);
      } finally { database.close(); }
    }));
    const settled = task.then(() => undefined, () => undefined);
    queues.set(databasePath, settled);
    void settled.then(() => { if (queues.get(databasePath) === settled) queues.delete(databasePath); });
    return task;
  }

  private applyAccountingLimit(database: DatabaseSync): number {
    // BEGIN IMMEDIATE excludes every cooperating writer before reading the minimum.
    const exists = database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='accounting_limits'").get();
    const stored = exists ? database.prepare('SELECT max_bytes FROM accounting_limits WHERE id=1').get() : undefined;
    const requested = this.accountingLimit ?? (stored ? Number(stored.max_bytes) : DEFAULT_ACCOUNTING_DATABASE_BYTES);
    const limit = Math.min(requested, stored ? Number(stored.max_bytes) : requested);
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
  public constructor(private readonly repoRoot: string, private readonly database: DatabaseSync, private readonly cap: number, private used: number, private readonly maxEventsPerSink = DEFAULT_STORAGE_CAPS.maxEventsPerSink,
    private readonly runId: string,
    private readonly runRoot: string,
    private readonly checkpoint: () => Promise<void>) {}
  public scratchRecord(id: string): string | undefined {
    const row = this.database.prepare('SELECT record FROM capture_scratch WHERE run_id=? AND id=?').get(this.runId, id);
    return row ? String(row.record) : undefined;
  }
  public scratchPage(after: string, limit: number): string[] {
    return this.database.prepare('SELECT record FROM capture_scratch WHERE run_id=? AND id>? ORDER BY id LIMIT ?').all(this.runId, after, limit).map(row => String(row.record));
  }
  public scratchDestination(destination: string): string[] {
    return this.database.prepare("SELECT record FROM capture_scratch WHERE run_id=? AND json_extract(record,'$.destination')=? LIMIT 2").all(this.runId, destination).map(row => String(row.record));
  }
  public saveScratch(id: string, serialized: string): void {
    const old = this.scratchRecord(id);
    if (!old) this.reserve(4096, 'capture scratch registry');
    this.database.prepare('INSERT INTO capture_scratch VALUES (?,?,?) ON CONFLICT(run_id,id) DO UPDATE SET record=excluded.record').run(this.runId, id, serialized);
  }
  public removeScratch(id: string): void { this.database.prepare('DELETE FROM capture_scratch WHERE run_id=? AND id=?').run(this.runId, id); }
  private priorFailed: 0 | 1 = 0;
  public hasEventFailure(): boolean {
    return this.database.prepare('SELECT event_failed FROM run_caps WHERE run_id=?').get(this.runId)!.event_failed !== 0;
  }
  public async armEventWrite(): Promise<void> {
    this.priorFailed = this.hasEventFailure() ? 1 : 0;
    this.database.prepare('UPDATE run_caps SET event_failed=1 WHERE run_id=?').run(this.runId);
    await this.checkpoint();
  }
  public async recoverEventWrite(): Promise<void> {
    const pending = this.database.prepare('SELECT intent FROM event_append_intents WHERE run_id=?').get(this.runId);
    if (!pending) return;
    const intent = parseEventIntent(String(pending.intent));
    const runSegment = this.runRoot + '/';
    if (typeof intent.path !== 'string' || !intent.path.startsWith(runSegment) || !Number.isSafeInteger(intent.count) || intent.count < 0 || (intent.priorFailed !== 0 && intent.priorFailed !== 1)) throw failed('Invalid persisted event append intent.');
    const absolute = await this.prepare(intent.path);
    const info = await safeFile(absolute);
    if (!info) throw failed('Pending event append file is missing.');
    this.reserve(Math.max(0, intent.offset + Buffer.byteLength(intent.payload) - info.size), intent.path);
    this.assertCanWrite(Buffer.byteLength(String(pending.intent)), intent.path);
    const file = await open(absolute, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
    try { await reconcileEventAppend(file, intent); } finally { await file.close(); }
    await this.finishEventWrite(intent);
    await this.checkpoint();
  }
  private async finishEventWrite(intent: EventAppendIntent): Promise<void> {
    const info = (await safeFile(path.resolve(this.repoRoot, intent.path)))!;
    if (!info || info.ino !== intent.ino || info.dev !== intent.dev || info.size !== intent.offset + Buffer.byteLength(intent.payload)) throw failed('Event append file changed before accounting commit.');
    this.database.prepare('INSERT INTO sink_counts (path,size,mtime,count,inode,chain_digest) VALUES (?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,count=excluded.count,inode=excluded.inode,chain_digest=excluded.chain_digest').run(intent.path, info.size, info.mtimeMs, intent.count + 1, String(info.ino), extendEventChain(intent.prefixChain, intent.digest));
    this.database.prepare('DELETE FROM event_append_intents WHERE run_id=?').run(this.runId);
    this.database.prepare('UPDATE run_caps SET event_failed=? WHERE run_id=?').run(intent.priorFailed, this.runId);
  }
  public assertCanWrite(bytes: number, targetPath: string): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw failed('Invalid artifact byte count.');
    if (this.used + bytes > this.cap) throw createProbefnError({ code: 'E_STORAGE_CAP_EXCEEDED', message: `Artifact cap exceeded before ${targetPath} could be committed.`, retryable: false, details: { targetPath, maxArtifactBytes: this.cap, attemptedTotalBytes: this.used + bytes } });
  }
  public reserve(bytes: number, targetPath: string): void {
    this.assertCanWrite(bytes, targetPath);
    this.used += bytes;
  }
  public async prepare(relative: string): Promise<string> {
    const normalized = assertRepositoryRelativePath(relative);
    await safeDirectory(this.repoRoot, path.posix.dirname(normalized));
    await safeFile(path.resolve(this.repoRoot, normalized));
    return path.resolve(this.repoRoot, normalized);
  }
  public async append(relativeDirectory: string, baseName: string, payload: string, policy: EventCapPolicy, explicitPolicyCap = true): Promise<AppendEventResult> {
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
    let prefix = await this.eventPrefix(absolute, relativePath);
    let count = prefix.count;
    const rollover = count >= (explicitPolicyCap ? Math.min(policy.maxEventsPerSink, this.maxEventsPerSink) : this.maxEventsPerSink);
    if (rollover) {
      if (policy.strategy === 'error') throw createProbefnError({ code: 'E_STORAGE_CAP_EXCEEDED', message: `Event cap exceeded for ${relativePath}.`, retryable: false });
      index += 1; count = 0;
      relativePath = path.posix.join(relativeDirectory, filename(index));
      absolute = await this.prepare(relativePath);
      prefix = await this.eventPrefix(absolute, relativePath); count = prefix.count;
    }
    this.reserve(Buffer.byteLength(payload), relativePath);
    const file = await open(absolute, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const info = await file.stat();
      if (prefix.identity === null ? info.size !== 0 : info.dev !== prefix.identity.dev || info.ino !== prefix.identity.ino || info.size !== prefix.identity.size || info.mtimeMs !== prefix.identity.mtime) throw failed('Event prefix changed before append admission.');
      await file.sync();
      const directory = await open(path.dirname(absolute), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
      const intent: EventAppendIntent = { path: relativePath, dev: info.dev, ino: info.ino, offset: info.size, mtime: info.mtimeMs,
        payload, digest: eventDigest(payload), prefixChain: prefix.chain, count, sinkIndex: index, rollover, priorFailed: this.priorFailed };
      const serialized = JSON.stringify(intent);
      this.assertCanWrite(Buffer.byteLength(serialized), relativePath);
      this.database.prepare('INSERT INTO event_append_intents VALUES (?,?)').run(this.runId, serialized);
      await this.checkpoint();
      await reconcileEventAppend(file, intent, false);
      await this.finishEventWrite(intent);
    } finally { await file.close(); }
    return { relativePath, eventCount: count + 1, sinkIndex: index, ...(rollover ? { warning: `Event cap reached; rollover sink ${filename(index)} created.` } : {}) };
  }
  private async eventPrefix(absolute: string, relative: string): Promise<{ count: number; chain: string; identity: { dev: number; ino: number; size: number; mtime: number } | null }> {
    const info = await safeFile(absolute);
    const identity = info ? { dev: info.dev, ino: info.ino, size: info.size, mtime: info.mtimeMs } : null;
    if (!info || info.size === 0) return { count: 0, chain: EMPTY_EVENT_CHAIN, identity };
    const cached = this.database.prepare('SELECT size,mtime,count,inode,chain_digest FROM sink_counts WHERE path=?').get(relative);
    if (cached && cached.size === info.size && cached.mtime === info.mtimeMs && cached.inode === String(info.ino) && /^[0-9a-f]{64}$/.test(String(cached.chain_digest))) return { count: Number(cached.count), chain: String(cached.chain_digest), identity };
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return { ...await inspectEventPrefix(file, info.size), identity }; } finally { await file.close(); }
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
export async function safeFile(filename: string) {
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

import path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { lstat, mkdir, open, opendir, rm, rmdir } from 'node:fs/promises';
import { z } from 'zod';
import type { FileHandle } from 'node:fs/promises';
import { createProbefnError } from '@probefn/contracts/errors';
import { RunQuota, safeDirectory, safeFile } from './run-quota.js';
import { assertArtifactIdentifier, assertRepositoryRelativePath } from './manifest-writer.js';

const integer = z.number().int().nonnegative().safe();
const schema = z.object({
  id: z.string().uuid(), runId: z.string().min(1).max(128),
  destination: z.string().min(1).max(2048),
  state: z.enum(['prepared', 'producing', 'sealed', 'admitting', 'admitted', 'removing', 'discarding', 'cleaned', 'quarantined']),
  dev: integer.nullable(), ino: integer.nullable(), admissionDev: integer.nullable(), admissionIno: integer.nullable(),
  digest: z.string().regex(/^[a-f0-9]{64}$/).nullable(), bytes: integer.nullable(),
}).strict();
export type CaptureScratchRecord = z.infer<typeof schema>;
export interface CaptureScratchPage { records: Array<CaptureScratchRecord & { removed: boolean; error?: string }>; nextCursor: string | null }
const failed = (message: string) => createProbefnError({ code: 'E_STORAGE_WRITE_FAILED', message, retryable: false, details: { scratchConflict: true } });
const parse = (text: string): CaptureScratchRecord => {
  if (Buffer.byteLength(text) > 4096) throw failed('Capture scratch record exceeds its metadata bound.');
  try { return schema.parse(JSON.parse(text)); } catch { throw failed('Invalid capture scratch record.'); }
};
const syncDirectory = async (directory: string) => { const file = await open(directory, constants.O_RDONLY); try { await file.sync(); } finally { await file.close(); } };

/** Durable trace scratch ownership; all methods run under the same native run authority. */
export class CaptureScratchRegistry {
  constructor(private readonly repoRoot: string, private readonly artifactRoot: string, private readonly quota: RunQuota) {}
  public owned<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    return this.quota.owned(runId, operation);
  }
  private directory(runId: string, id: string): string {
    assertArtifactIdentifier(runId, 'Run id');
    if (!z.string().uuid().safeParse(id).success) throw failed('Invalid capture scratch generation.');
    return path.posix.join(this.artifactRoot, 'runs', runId, '.probefn-scratch', `probefn-trace-${id}`);
  }
  public filename(record: CaptureScratchRecord): string { return path.resolve(this.repoRoot, this.directory(record.runId, record.id), 'trace.zip'); }
  private async get(runId: string, id: string): Promise<CaptureScratchRecord> {
    return this.quota.transaction(runId, this.directory(runId, id), async q => {
      const text = q.scratchRecord(id); if (!text) throw failed('Capture scratch generation no longer exists.');
      const record = parse(text); if (record.runId !== runId || record.id !== id) throw failed('Capture scratch scope mismatch.');
      this.validateDestination(record); return record;
    });
  }
  private validateDestination(record: Pick<CaptureScratchRecord, 'runId' | 'destination'>): void {
    if (record.destination.length > 2048) throw failed('Capture destination exceeds its metadata bound.');
    const target = assertRepositoryRelativePath(record.destination);
    const prefix = path.posix.join(this.artifactRoot, 'runs', record.runId) + '/';
    if (!target.startsWith(prefix) || target.slice(prefix.length).split('/').some(part => part.startsWith('.'))) throw failed('Capture destination must be an ordinary artifact in its owning run.');
  }
  private async save(record: CaptureScratchRecord, expected?: CaptureScratchRecord['state']): Promise<void> {
    const serialized = JSON.stringify(parse(JSON.stringify(record)));
    if (Buffer.byteLength(serialized) > 4096) throw failed('Capture scratch metadata exceeds its bound.');
    await this.quota.transaction(record.runId, this.directory(record.runId, record.id), async q => {
      const old = q.scratchRecord(record.id);
      if (expected === undefined ? old !== undefined : old === undefined || parse(old).state !== expected) throw failed('Capture scratch state was superseded.');
      q.saveScratch(record.id, serialized);
    });
  }
  public async prepare(runId: string, destination: string): Promise<CaptureScratchRecord> {
    const record: CaptureScratchRecord = { id: randomUUID(), runId, destination, state: 'prepared', dev: null, ino: null, admissionDev: null, admissionIno: null, digest: null, bytes: null };
    this.validateDestination(record);
    await this.save(record); // Admission is committed before creating or handing out any directory.
    const relative = this.directory(runId, record.id), absolute = path.resolve(this.repoRoot, relative);
    await safeDirectory(this.repoRoot, path.posix.dirname(relative));
    await this.quota.transaction(runId, relative, async q => { q.assertCanWrite(Buffer.byteLength(JSON.stringify({ id: record.id, runId })), relative); });
    await mkdir(absolute, { mode: 0o700 });
    const marker = await open(path.join(absolute, 'owner.json'), 'wx', 0o600);
    try { await marker.writeFile(JSON.stringify({ id: record.id, runId })); await marker.sync(); } finally { await marker.close(); }
    await syncDirectory(absolute); await syncDirectory(path.dirname(absolute));
    const info = await lstat(absolute);
    record.dev = info.dev; record.ino = info.ino;
    await this.save(record, 'prepared');
    return record;
  }
  private async verify(record: CaptureScratchRecord, allowMissing = false): Promise<boolean> {
    const relative = this.directory(record.runId, record.id), absolute = path.resolve(this.repoRoot, relative);
    await safeDirectory(this.repoRoot, path.posix.dirname(relative));
    let info;
    try { info = await lstat(absolute); } catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink() || record.dev === null || info.dev !== record.dev || info.ino !== record.ino) throw failed('Capture scratch directory identity changed.');
    const markerPath = path.join(absolute, 'owner.json');
    const marker = await safeFile(markerPath);
    if ((!marker && !['removing', 'discarding'].includes(record.state)) || (marker && marker.size > 256)) throw failed('Capture scratch ownership marker is missing or oversized.');
    if (marker) {
      const file = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await file.stat(), bytes = Buffer.alloc(257);
        const read = await file.read(bytes, 0, bytes.length, 0);
        if (opened.ino !== marker.ino || opened.dev !== marker.dev || read.bytesRead > 256 ||
          bytes.subarray(0, read.bytesRead).toString() !== JSON.stringify({ id: record.id, runId: record.runId })) throw failed('Capture scratch ownership marker changed.');
      } finally { await file.close(); }
    }
    const entries = await opendir(absolute);
    for await (const entry of entries) if (!['owner.json', 'trace.zip'].includes(entry.name)) throw failed('Capture scratch contains unexpected files.');
    return true;
  }
  public async producing(runId: string, id: string): Promise<CaptureScratchRecord> {
    const record = await this.get(runId, id);
    if (record.state !== 'prepared') throw failed('Capture scratch cannot be handed to another producer.');
    await this.verify(record); record.state = 'producing'; await this.save(record, 'prepared'); return record;
  }
  public async seal(runId: string, id: string): Promise<void> {
    const record = await this.get(runId, id);
    if (record.state !== 'producing') throw failed('Capture scratch producer generation changed.');
    await this.verify(record);
    const result = await digestFile(this.filename(record), true);
    record.digest = result.digest; record.bytes = result.bytes; record.state = 'sealed';
    await this.save(record, 'producing');
  }
  public async admitted(runId: string, id: string): Promise<void> {
    const record = await this.get(runId, id);
    if (record.state !== 'sealed') throw failed('Capture scratch is not sealed.');
    await this.verify(record); await this.verifyReceipt(record);
    record.state = 'admitted'; await this.save(record, 'sealed');
  }
  /** Explicit recovery writes only a new destination or the exact persisted admission inode. */
  public async reconcile(runId: string, id: string): Promise<string> {
    return this.owned(runId, async () => {
      const record = await this.get(runId, id);
      if (record.state === 'admitted' || record.state === 'cleaned') { await this.verifyReceipt(record); return record.destination; }
      if (!['sealed', 'admitting'].includes(record.state) || record.digest === null || record.bytes === null) throw failed('Only a sealed, quiescent trace can be admitted.');
      await this.verify(record);
      const sourcePath = this.filename(record), destination = path.resolve(this.repoRoot, record.destination);
      const source = await digestFile(sourcePath);
      if (source.digest !== record.digest || source.bytes !== record.bytes) throw failed('Sealed trace bytes changed before admission.');
      await safeDirectory(this.repoRoot, path.posix.dirname(record.destination));
      if (record.state === 'sealed') {
        const existing = await safeFile(destination);
        if (existing) { await this.admitted(runId, id); return record.destination; }
        await this.quota.transaction(runId, record.destination, async q => { q.assertCanWrite(source.bytes, record.destination); });
        // Exclusive creation never overwrites an unrelated target. An interruption before
        // identity commit remains an explicit conflict rather than guessed ownership.
        const file = await open(destination, 'wx', 0o600);
        try {
          await file.sync(); await syncDirectory(path.dirname(destination));
          const info = await file.stat(); record.admissionDev = info.dev; record.admissionIno = info.ino;
          record.state = 'admitting'; await this.save(record, 'sealed');
        } finally { await file.close(); }
      }
      await this.quota.transaction(runId, record.destination, async q => {
        const current = q.scratchRecord(id);
        if (!current || JSON.stringify(parse(current)) !== JSON.stringify(record)) throw failed('Trace admission generation changed.');
        const before = await safeFile(destination);
        if (!before || before.dev !== record.admissionDev || before.ino !== record.admissionIno || before.size > source.bytes) throw failed('Trace admission destination identity changed.');
        q.reserve(source.bytes - before.size, record.destination);
        const input = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        let output: FileHandle | undefined;
        try {
          output = await open(destination, constants.O_RDWR | constants.O_NOFOLLOW);
          const inputBefore = await input.stat(), outputBefore = await output.stat();
          if (outputBefore.ino !== before.ino || outputBefore.dev !== before.dev || outputBefore.size !== before.size || outputBefore.mtimeMs !== before.mtimeMs) throw failed('Trace admission changed before open.');
          const buffer = Buffer.alloc(64 * 1024), comparison = Buffer.alloc(64 * 1024);
          let position = 0;
          while (position < before.size) {
            const length = Math.min(buffer.length, before.size - position);
            const left = await input.read(buffer, 0, length, position), right = await output.read(comparison, 0, length, position);
            if (left.bytesRead !== length || right.bytesRead !== length || !buffer.subarray(0, length).equals(comparison.subarray(0, length))) throw failed('Trace admission prefix contains unrelated bytes.');
            position += length;
          }
          const checked = await output.stat();
          if (checked.size !== before.size || checked.mtimeMs !== before.mtimeMs) throw failed('Trace admission changed during prefix verification.');
          while (position < source.bytes) {
            const read = await input.read(buffer, 0, Math.min(buffer.length, source.bytes - position), position);
            if (!read.bytesRead) throw failed('Sealed trace ended during admission.');
            let offset = 0;
            while (offset < read.bytesRead) {
              const written = await output.write(buffer, offset, read.bytesRead - offset, position + offset);
              if (!written.bytesWritten) throw failed('Trace admission write made no progress.');
              offset += written.bytesWritten;
            }
            position += read.bytesRead;
          }
          const inputAfter = await input.stat();
          if (inputAfter.ino !== inputBefore.ino || inputAfter.dev !== inputBefore.dev || inputAfter.size !== inputBefore.size || inputAfter.mtimeMs !== inputBefore.mtimeMs) throw failed('Sealed trace changed during admission.');
          await output.sync(); await syncDirectory(path.dirname(destination));
          await this.verifyReceipt(record);
          record.state = 'admitted'; q.saveScratch(id, JSON.stringify(schema.parse(record)));
        } finally { try { await input.close(); } finally { await output?.close(); } }
      });
      return record.destination;
    });
  }
  private async verifyReceipt(record: CaptureScratchRecord): Promise<void> {
    await safeDirectory(this.repoRoot, path.posix.dirname(record.destination));
    const result = await digestFile(path.resolve(this.repoRoot, record.destination));
    if (result.digest !== record.digest || result.bytes !== record.bytes) throw failed('Admitted trace destination changed; scratch is retained.');
  }
  public async cleanup(runId: string, id: string, discardSealed = false): Promise<void> {
    const record = await this.get(runId, id);
    if (record.state === 'cleaned') { await this.verifyReceipt(record); return; }
    if (discardSealed && record.state === 'sealed') { record.state = 'discarding'; await this.save(record, 'sealed'); }
    if (!['prepared', 'admitted', 'removing', 'discarding'].includes(record.state)) throw failed('Capture scratch lacks proof that deletion is safe.');
    if (record.digest !== null && record.state !== 'discarding') await this.verifyReceipt(record);
    const present = await this.verify(record, true);
    if (present) {
      const source = await safeFile(this.filename(record));
      if (source) {
        if (record.digest === null) throw failed('Unhanded scratch unexpectedly contains producer output.');
        const content = await digestFile(this.filename(record));
        if (content.digest !== record.digest || content.bytes !== record.bytes) throw failed('Capture scratch bytes changed.');
      }
      // Persist intent before removing any owned bytes. Recovery can finish missing files.
      const previous = record.state;
      if (record.state !== 'discarding') record.state = 'removing'; await this.save(record, previous);
      await rm(this.filename(record), { force: true });
      await rm(path.join(path.dirname(this.filename(record)), 'owner.json'), { force: true });
      await rmdir(path.dirname(this.filename(record)));
      await syncDirectory(path.dirname(path.dirname(this.filename(record))));
    }
    await this.quota.transaction(runId, this.directory(runId, id), async q => { const current = q.scratchRecord(id); if (!current || parse(current).state !== record.state) throw failed('Capture scratch cleanup was superseded.'); if (record.digest !== null && record.state !== 'discarding') { record.state = 'cleaned'; q.saveScratch(id, JSON.stringify(schema.parse(record))); } else q.removeScratch(id); });
  }
  /** Call only after the destination receipt has been durably published by the host. */
  public async acknowledge(runId: string, destination: string): Promise<void> {
    this.validateDestination({ runId, destination });
    await this.owned(runId, async () => {
      const records = await this.quota.transaction(runId, destination, async q => q.scratchDestination(destination).map(parse));
      if (records.length > 1) throw failed('Ambiguous trace destination receipts require individual reconciliation.');
      const record = records[0];
      if (!record) return; // Repeated acknowledgement is harmless.
      this.validateDestination(record);
      if (record.runId !== runId || record.state !== 'cleaned') throw failed('Trace receipt cannot be acknowledged before scratch cleanup.');
      await this.verifyReceipt(record);
      await this.quota.transaction(runId, destination, async q => {
        if (q.scratchRecord(record.id) !== JSON.stringify(record)) throw failed('Trace receipt acknowledgement was superseded.');
        q.removeScratch(record.id);
      });
    });
  }
  public async recover(runId: string, cursor = '', limit = 32): Promise<CaptureScratchPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (cursor && !z.string().uuid().safeParse(cursor).success)) throw failed('Invalid capture scratch recovery page.');
    return this.owned(runId, async () => {
      const records = await this.quota.transaction(runId, path.posix.join(this.artifactRoot, 'runs', runId), async q => q.scratchPage(cursor, limit + 1).map(parse));
      const page: CaptureScratchPage['records'] = records.slice(0, limit).map(record => ({ ...record, removed: false }));
      for (const result of page) {
        const { removed: _removed, error: _error, ...record } = result;
        if (record.runId !== runId) throw failed('Capture scratch recovery scope mismatch.');
        this.validateDestination(record);
        if (record.state === 'producing') { record.state = 'quarantined'; await this.save(record, 'producing'); }
        if (record.state === 'sealed') {
          // A crash after import but before registry commit can be recognized without rewriting.
          const target = await safeFile(path.resolve(this.repoRoot, record.destination));
          if (target) {
            try { await this.admitted(runId, record.id); record.state = 'admitted'; }
            catch { record.state = 'quarantined'; await this.save(record, 'sealed'); }
          }
        }
        if (['prepared', 'admitted', 'removing', 'discarding', 'cleaned'].includes(record.state)) {
          try { await this.cleanup(runId, record.id); result.removed = true; if (record.digest !== null && record.state !== 'discarding') record.state = 'cleaned'; }
          catch {
            const latest = await this.get(runId, record.id);
            record.state = latest.state; result.error = 'cleanup_failed';
          }
        }
        result.state = record.state;
      }
      return { records: page, nextCursor: records.length > limit ? page.at(-1)!.id : null };
    });
  }
}

async function digestFile(filename: string, makePrivate = false): Promise<{ digest: string; bytes: number }> {
  const before = await safeFile(filename);
  if (!before) throw failed('Capture artifact is missing.');
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev) throw failed('Capture artifact changed before reading.');
    if (makePrivate) await file.chmod(0o600);
    const digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    for (;;) { const read = await file.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break; digest.update(buffer.subarray(0, read.bytesRead)); bytes += read.bytesRead; }
    await file.sync();
    const after = await file.stat();
    const named = await safeFile(filename);
    if (!named || named.ino !== after.ino || named.dev !== after.dev || named.size !== after.size || named.mtimeMs !== after.mtimeMs) throw failed('Capture artifact path changed while reading.');
    if (after.size !== bytes || after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs) throw failed('Capture artifact changed while reading.');
    return { digest: digest.digest('hex'), bytes };
  } finally { await file.close(); }
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OfflineQueue,
  type OfflineQueueHoldResult,
  type OfflineQueueHooks,
  type OfflineQueueOptions,
  type OfflineQueuePartition,
  type OfflineQueuePrincipal,
  type OfflineQueueUploader,
} from '../offline/queue.js';
import { OfflineSync } from '../offline/sync.js';
import { UPLOAD_SESSION_ENDED_ERROR } from '../upload-manager.js';
import {
  MemoryDirectory,
  MemoryFile,
  SharedLockManager,
  createStorage,
  deferred,
  quotaExceeded,
} from './helpers/offline-fixtures.js';

const ALICE: OfflineQueuePartition = { serviceId: 'svc-notes', principal: { kind: 'user', principalId: 'user-alice' } };
const BOB: OfflineQueuePartition = { serviceId: 'svc-notes', principal: { kind: 'user', principalId: 'user-bob' } };
const FILE_ID = 'file_00000000entry01';

let storage: ReturnType<typeof createStorage>;
let locks: SharedLockManager;

/** A deterministic uploader: records every call and returns ver_<n>. */
function recordingUploader() {
  const calls: Array<{ fileId: string; idempotencyKey: string; body: string }> = [];
  const uploader: OfflineQueueUploader & { calls: typeof calls } = {
    calls,
    async upload(input) {
      calls.push({ fileId: input.fileId, idempotencyKey: input.idempotencyKey, body: await input.file.text() });
      return { fileId: input.fileId, versionId: `ver_${calls.length}` };
    },
  };
  return uploader;
}

function tab(
  name: string,
  overrides: Partial<OfflineQueueOptions> = {},
): OfflineQueue {
  return new OfflineQueue({
    partition: ALICE,
    uploader: recordingUploader(),
    coordinator: locks.forTab(name),
    getRoot: async () => storage.root,
    currentPrincipal: () => (overrides.partition ?? ALICE).principal,
    ...overrides,
  });
}

async function stage(queue: OfflineQueue, body = 'v1', extra: Record<string, unknown> = {}) {
  const result = await queue.stage({ policy: 'p', file: new Blob([body], { type: 'text/plain' }), fileName: 'a.txt', fileId: FILE_ID, ...extra });
  if (result.status !== 'staged') throw new Error(`stage refused: ${JSON.stringify(result)}`);
  return result;
}

function heldId(result: OfflineQueueHoldResult): string {
  if (result.status !== 'held') throw new Error(`hold refused: ${JSON.stringify(result)}`);
  return result.holdId;
}

/** The journal file of an entry, found by the entryId it records. */
function journalOf(entryId: string): MemoryFile {
  const walk = (dir: MemoryDirectory): MemoryFile | undefined => {
    for (const [name, entry] of dir.entries) {
      if (entry instanceof MemoryDirectory) {
        const found = walk(entry);
        if (found) return found;
      } else if (name === 'journal.json') {
        try {
          if (JSON.parse(new TextDecoder().decode(entry.content)).entryId === entryId) return entry;
        } catch {
          // An unreadable journal names no entry.
        }
      }
    }
    return undefined;
  };
  const found = walk(storage.root);
  if (!found) throw new Error(`no journal for ${entryId}`);
  return found;
}

/** An always-online sync of `queue`. */
function onlineSync(queue: OfflineQueue, config: Omit<ConstructorParameters<typeof OfflineSync>[0], 'queue'> = {}): OfflineSync {
  const sync = new OfflineSync({ ...config, queue });
  sync.setConnectivityChecker({ isOnline: () => true, onOnline: () => () => {}, onOffline: () => () => {} });
  return sync;
}

async function writeCommitted(dir: MemoryDirectory, name: string, text: string): Promise<void> {
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(text);
  await writable.close();
}

async function partitionDir(): Promise<MemoryDirectory> {
  const layout = await (await storage.root.getDirectoryHandle('filefn-offline-queue')).getDirectoryHandle('v1');
  return layout.entries.values().next().value as MemoryDirectory;
}

function dataFiles(): string[] {
  return storage.root.files().filter((path) => path.endsWith('.bin'));
}

beforeEach(() => {
  storage = createStorage();
  locks = new SharedLockManager();
  // No ambient Web Locks or OPFS: each test chooses its coordinator and root.
  vi.stubGlobal('navigator', {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('two tabs sharing one storage and lock manager', () => {
  it('lets only one tab advance a generation and never lets a stale hold release a newer one', async () => {
    const a = tab('a');
    const b = tab('b');
    const first = await stage(a);
    const staleHold = heldId(await a.hold(FILE_ID, first.entry.generation));

    const results = await Promise.all([
      a.stage({ policy: 'p', file: new Blob(['from-a']), fileId: FILE_ID, expectedGeneration: 1, hold: true }),
      b.stage({ policy: 'p', file: new Blob(['from-b']), fileId: FILE_ID, expectedGeneration: 1, hold: true }),
    ]);
    const staged = results.filter((r) => r.status === 'staged');
    expect(staged).toHaveLength(1);
    expect(results.find((r) => r.status === 'refused')).toMatchObject({ reason: 'generation-conflict', currentGeneration: 2 });
    const winner = staged[0] as Extract<(typeof results)[number], { status: 'staged' }>;
    expect(winner.entry.generation).toBe(2);

    // The generation-1 hold cannot release generation 2, under either generation number.
    expect(await a.release(FILE_ID, 1, staleHold)).toBe(false);
    expect(await a.release(FILE_ID, 2, staleHold)).toBe(false);
    expect(await b.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'held' });
    expect(await b.release(FILE_ID, 2, winner.holdId!)).toBe(true);
    expect(await b.process(FILE_ID)).toMatchObject({ status: 'published' });
    expect(dataFiles()).toEqual([]);
  });

  it('runs one upload when both tabs process an entry, and resumes in the other tab with the same key after the first closes', async () => {
    const hanging = deferred<{ fileId: string; versionId: string }>();
    const uploadA = vi.fn(() => hanging.promise);
    const publishB = vi.fn(async () => ({ result: { linked: true } }));
    const a = tab('a', { uploader: { upload: uploadA } });
    const uploaderB = recordingUploader();
    const b = tab('b', { uploader: uploaderB, hooks: { publish: { run: publishB, idempotent: true } } });
    await stage(a);

    const running = a.process(FILE_ID);
    await vi.waitFor(() => expect(uploadA).toHaveBeenCalledTimes(1));
    expect(await b.process(FILE_ID)).toEqual({ status: 'busy' });
    const firstKey = (uploadA.mock.calls[0] as unknown as [{ idempotencyKey: string }])[0].idempotencyKey;

    // Tab A closes mid-upload: the browser releases its locks and its code stops.
    locks.closeTab('a');
    a.dispose();
    await expect(running).rejects.toMatchObject({ code: 'FILEFN_QUEUE_DISPOSED' });

    expect(await b.process(FILE_ID)).toMatchObject({ status: 'published', entry: { attempts: 2, upload: { versionId: 'ver_1' } } });
    expect(uploaderB.calls.map((c) => c.idempotencyKey)).toEqual([firstKey]);
    expect(publishB).toHaveBeenCalledTimes(1);

    // Tab A's late upload result is fenced: it writes nothing.
    hanging.resolve({ fileId: FILE_ID, versionId: 'ver_late' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await b.get(FILE_ID)).toMatchObject({ phase: 'published', upload: { versionId: 'ver_1' } });
  });

  it('never applies an older generation’s upload, verification or publication to a newer one', async () => {
    const upload = deferred<{ fileId: string; versionId: string }>();
    const verify = vi.fn(async () => ({ verified: true as const }));
    const publish = vi.fn(async () => ({}));
    const a = tab('a', { uploader: { upload: () => upload.promise }, hooks: { verify, publish: { run: publish } } });
    const b = tab('b');
    await stage(a, 'old');
    const running = a.process(FILE_ID);
    await vi.waitFor(() => expect(locks.heldNames().some((n) => n.includes(':entry:'))).toBe(true));
    await stage(b, 'new');

    upload.resolve({ fileId: FILE_ID, versionId: 'ver_old' });
    expect(await running).toEqual({ status: 'superseded' });
    expect(verify).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(await b.get(FILE_ID)).toMatchObject({ generation: 2, phase: 'staged', state: 'provisional' });
    expect(dataFiles()).toEqual([expect.stringMatching(/\/g2\.bin$/)]);
  });
});

describe('crash and reload', () => {
  it('leaves no entry when staging is interrupted before the journal commits, and reclaims the orphaned data', async () => {
    const a = tab('a');
    storage.storage.fault = (path, step) => {
      if (path.endsWith('journal.json') && step === 'close') throw new Error('crash');
    };
    await expect(stage(a)).rejects.toThrow('crash');
    storage.storage.fault = undefined;

    const reloaded = tab('a2');
    expect(await reloaded.list()).toEqual([]);
    await reloaded.reclaim();
    // Only the partition's generation counter remains.
    expect(storage.root.files()).toEqual([expect.stringMatching(/\/partition\.json$/)]);
  });

  it('recovers an entry whose first journal was left empty by a killed tab, and reclaims its bytes', async () => {
    const a = tab('a', { limits: { maxEntries: 2, maxBytes: 100 } });
    await stage(a, 'first-bytes');
    await stage(a, 'other', { entryId: 'other' });
    // A tab killed between creating journal.json and closing its writable leaves it empty.
    journalOf(FILE_ID).content = new Uint8Array();
    const reloaded = tab('a2', { limits: { maxEntries: 2, maxBytes: 100 } });
    expect((await reloaded.list()).map((e) => e.entryId)).toEqual(['other']);

    const restaged = await stage(reloaded, 'second');
    expect(restaged.entry).toMatchObject({ entryId: FILE_ID, phase: 'staged' });
    expect(await reloaded.process(FILE_ID)).toMatchObject({ status: 'published' });

    journalOf('other').content = new TextEncoder().encode('{"journalVer');
    expect(await reloaded.usage()).toMatchObject({ entries: 2 });
    expect(await reloaded.reclaim()).toMatchObject({ freedBytes: 5 });
    // The published entry stays for its retention; the never-committed one is gone.
    expect(await reloaded.usage()).toEqual({ entries: 1, bytes: 0 });
  });

  it('retries an ambiguous upload after reload with the same recorded key', async () => {
    let fail = true;
    const keys: string[] = [];
    const uploader: OfflineQueueUploader = {
      async upload(input) {
        keys.push(input.idempotencyKey);
        if (fail) throw new TypeError('fetch failed');
        return { fileId: input.fileId, versionId: 'ver_1' };
      },
    };
    await stage(tab('a', { uploader }), 'v1', { idempotencyKey: 'test-replay-key-0001' });
    expect(await tab('a', { uploader }).process(FILE_ID)).toMatchObject({
      status: 'provisional',
      reason: 'ambiguous',
      entry: { state: 'provisional', pending: { stage: 'upload', reason: 'ambiguous' } },
    });

    fail = false;
    const reloaded = tab('a2', { uploader });
    expect((await reloaded.list())[0]).toMatchObject({ phase: 'uploading', state: 'provisional' });
    expect(await reloaded.process(FILE_ID)).toMatchObject({ status: 'published' });
    expect(keys).toEqual(['test-replay-key-0001', 'test-replay-key-0001']);
  });

  it('records a fresh key before replaying a session the server confirmed expired', async () => {
    const keys: string[] = [];
    const uploader: OfflineQueueUploader = {
      async upload(input) {
        keys.push(input.idempotencyKey);
        if (keys.length === 1) throw Object.assign(new Error('expired'), { code: UPLOAD_SESSION_ENDED_ERROR });
        return { fileId: input.fileId, versionId: 'ver_1' };
      },
    };
    await stage(tab('a', { uploader }), 'v1', { idempotencyKey: 'test-replay-key-0002' });
    expect(await tab('a', { uploader }).process(FILE_ID)).toMatchObject({ status: 'published' });
    expect(keys[0]).toBe('test-replay-key-0002');
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('keeps an ambiguous or rejected verification provisional across reload and in completion notifications', async () => {
    let outcome: () => Promise<{ verified: true } | { verified: false; reason: string }> = async () => {
      throw new Error('verifier offline');
    };
    const publish = vi.fn(async () => ({}));
    const hooks: OfflineQueueHooks = { verify: () => outcome(), publish: { run: publish } };
    const a = tab('a', { hooks });
    const staged = await stage(a);
    const events: string[] = [];
    a.subscribe((event) => events.push(`${event.type}:${event.entry.phase}`));
    let settled = false;
    void a.whenSettled(FILE_ID, staged.entry.generation).then(() => (settled = true), () => (settled = true));

    expect(await a.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'ambiguous' });
    const reloaded = tab('a2', { hooks });
    expect((await reloaded.list())[0]).toMatchObject({ phase: 'verifying', state: 'provisional', pending: { stage: 'verification' } });
    expect(settled).toBe(false);
    expect(events.every((e) => e.startsWith('provisional:'))).toBe(true);

    outcome = async () => ({ verified: false, reason: 'checksum mismatch' });
    const rejected = reloaded.whenSettled(FILE_ID, 1);
    expect(await reloaded.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'rejected', entry: { state: 'provisional' } });
    await expect(rejected).rejects.toMatchObject({ code: 'FILEFN_QUEUE_REJECTED' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('never retries an unconfirmed publication without reconciliation, and shows one result once reconciled', async () => {
    const run = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await stage(tab('a', { hooks: { publish: { run } } }));
    expect(await tab('a', { hooks: { publish: { run } } }).process(FILE_ID)).toMatchObject({ reason: 'ambiguous' });

    const reloaded = tab('a2', { hooks: { publish: { run } } });
    expect(await reloaded.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'needs-reconcile' });
    expect(run).toHaveBeenCalledTimes(1);
    await expect(reloaded.stage({ policy: 'p', file: new Blob(['v2']), fileId: FILE_ID })).resolves.toMatchObject({
      status: 'refused',
      reason: 'publication-pending',
    });

    const published: string[] = [];
    reloaded.subscribe((event) => event.type === 'published' && published.push(event.entry.operationId));
    await reloaded.reconcile(FILE_ID, 1, { published: true, result: { recordId: 'rec-1' } });
    await reloaded.processAll();
    const entries = await reloaded.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ state: 'published', publication: { result: { recordId: 'rec-1' } } });
    expect(published).toHaveLength(1);
    expect(dataFiles()).toEqual([]);
  });

  it('asks the reconcile hook before running publication again after a crash, with the same operation identity', async () => {
    const hanging = deferred<{ result?: unknown }>();
    const firstRun = vi.fn((_ctx: { operationId: string }) => hanging.promise);
    const a = tab('a', { hooks: { publish: { run: firstRun } } });
    await stage(a);
    const running = a.process(FILE_ID);
    await vi.waitFor(() => expect(firstRun).toHaveBeenCalledTimes(1));
    locks.closeTab('a');
    a.dispose();
    await expect(running).rejects.toMatchObject({ code: 'FILEFN_QUEUE_DISPOSED' });

    const reconcile = vi.fn(async () => ({ published: false as const }));
    const secondRun = vi.fn(async (_ctx: { operationId: string }) => ({ result: 'ok' }));
    const b = tab('b', { hooks: { publish: { run: secondRun, reconcile } } });
    expect(await b.process(FILE_ID)).toMatchObject({ status: 'published' });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(secondRun.mock.calls[0][0].operationId).toBe(firstRun.mock.calls[0][0].operationId);
  });

  it('finishes an interrupted cleanup after reload without publishing again', async () => {
    const run = vi.fn(async () => ({}));
    let journalWrites = 0;
    storage.storage.fault = (path, step) => {
      // Journal writes: staged, uploading, uploaded, verified, publishing, published, then cleanup (the 7th).
      if (path.endsWith('journal.json') && step === 'close' && ++journalWrites === 7) throw new Error('crash');
    };
    await stage(tab('a', { hooks: { publish: { run } } }));
    await expect(tab('a', { hooks: { publish: { run } } }).process(FILE_ID)).rejects.toThrow('crash');
    storage.storage.fault = undefined;

    const reloaded = tab('a2', { hooks: { publish: { run } } });
    expect((await reloaded.list())[0]).toMatchObject({ state: 'published' });
    await reloaded.processAll();
    expect(run).toHaveBeenCalledTimes(1);
    expect(dataFiles()).toEqual([]);
  });
});

describe('principal partitions', () => {
  it('keeps one principal’s entries invisible and untouchable to another, and returns them to their owner', async () => {
    const alice = tab('a');
    await stage(alice);
    alice.dispose();

    // Same tab, new account.
    const bobUploader = recordingUploader();
    const bob = tab('a', { partition: BOB, uploader: bobUploader });
    expect(await bob.list()).toEqual([]);
    expect(await bob.get(FILE_ID)).toBeNull();
    expect(await bob.process(FILE_ID)).toEqual({ status: 'not-found' });
    expect(await bob.cancel(FILE_ID)).toBe(false);
    await expect(bob.hold(FILE_ID, 1)).rejects.toMatchObject({ code: 'FILEFN_QUEUE_NOT_FOUND' });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });
    expect(await bob.getPendingLocalDescriptor(FILE_ID)).toBeNull();
    await bob.processAll();
    await bob.reclaim();
    expect(bobUploader.calls).toEqual([]);

    // A second tab still signed in as Alice keeps working on her entry.
    const aliceAgain = tab('b');
    expect(await aliceAgain.list()).toMatchObject([{ entryId: FILE_ID, state: 'provisional' }]);
    expect(await aliceAgain.process(FILE_ID)).toMatchObject({ status: 'published' });
  });

  it.each([
    [{ serviceId: 'a', principal: { kind: 'user', principalId: 'b:c' } }, { serviceId: 'a:b', principal: { kind: 'user', principalId: 'c' } }],
    [{ serviceId: 's', principal: { kind: 'user', principalId: 'x' } }, { serviceId: 's', principal: { kind: 'guest', namespace: 'x' } }],
    [{ serviceId: 's', principal: { kind: 'user', principalId: 'x' } }, { serviceId: 's', principal: { kind: 'user', principalId: 'x', tenantId: 't' } }],
  ] as Array<[OfflineQueuePartition, OfflineQueuePartition]>)('separates overlapping identifiers %j and %j', async (first, second) => {
    await stage(tab('a', { partition: first }));
    expect(await tab('a', { partition: second }).list()).toEqual([]);
    expect(await tab('a', { partition: first }).list()).toHaveLength(1);
  });

  it('fences late upload and hook results of a disposed principal’s queue', async () => {
    const upload = deferred<{ fileId: string; versionId: string }>();
    const publish = vi.fn(async () => ({}));
    const alice = tab('a', { uploader: { upload: () => upload.promise }, hooks: { publish: { run: publish } } });
    await stage(alice);
    const running = alice.process(FILE_ID);
    await vi.waitFor(() => expect(locks.heldNames().some((n) => n.includes(':entry:'))).toBe(true));
    const journalBefore = storage.root.files();
    alice.dispose();
    tab('a', { partition: BOB });
    upload.resolve({ fileId: FILE_ID, versionId: 'ver_late' });
    await expect(running).rejects.toMatchObject({ code: 'FILEFN_QUEUE_DISPOSED' });
    expect(publish).not.toHaveBeenCalled();
    expect(storage.root.files()).toEqual(journalBefore);
    expect(await tab('a3').get(FILE_ID)).toMatchObject({ phase: 'uploading', state: 'provisional' });
    await expect(alice.list()).rejects.toMatchObject({ code: 'FILEFN_QUEUE_DISPOSED' });
  });

  it('quarantines unscoped legacy uploads until migrated with ownership evidence', async () => {
    const legacy = await (await storage.root.getDirectoryHandle('filefn-pending-uploads', { create: true }))
      .getDirectoryHandle('offline_1731000000000_legacy001', { create: true });
    const data = await (await legacy.getFileHandle('data.bin', { create: true })).createWritable();
    await data.write(new TextEncoder().encode('old bytes').buffer);
    await data.close();
    const meta = await (await legacy.getFileHandle('metadata.json', { create: true })).createWritable();
    await meta.write(JSON.stringify({ uploadSessionId: 'offline_1731000000000_legacy001', fileId: FILE_ID, policy: 'p', fileName: 'old.txt', size: 9, mimeType: 'text/plain', createdAt: '2026-11-01T00:00:00.000Z', retryCount: 0, metadataVersion: 2 }));
    await meta.close();
    const uploader = recordingUploader();
    const queue = tab('a', { uploader });

    expect(await queue.list()).toEqual([]);
    await queue.processAll();
    expect(uploader.calls).toEqual([]);
    expect(await queue.listLegacyUploads()).toMatchObject([{ uploadSessionId: 'offline_1731000000000_legacy001', fileId: FILE_ID }]);
    await expect(queue.migrateLegacyUpload('offline_1731000000000_legacy001', {} as never)).rejects.toMatchObject({
      code: 'FILEFN_QUEUE_MIGRATION_UNVERIFIED',
    });

    expect(await queue.migrateLegacyUpload('offline_1731000000000_legacy001', { ownershipVerified: true })).toMatchObject({ status: 'staged' });
    expect(await queue.listLegacyUploads()).toEqual([]);
    expect(await queue.process(FILE_ID)).toMatchObject({ status: 'published' });
    expect(uploader.calls).toMatchObject([{ fileId: FILE_ID, body: 'old bytes' }]);
  });
});

describe('capacity and reclamation', () => {
  it('refuses new work past the entry and byte limits after reclaiming what it safely can', async () => {
    const queue = tab('a', { limits: { maxEntries: 2, maxBytes: 10 } });
    await stage(queue, 'aaaa', { entryId: 'one' });
    await stage(queue, 'bbbb', { entryId: 'two' });
    expect(await queue.stage({ policy: 'p', file: new Blob(['c']), entryId: 'three' })).toMatchObject({
      status: 'refused',
      reason: 'capacity',
      limit: 'entries',
      usage: { entries: 2, bytes: 8 },
    });
    expect(await queue.stage({ policy: 'p', file: new Blob(['ccccccc']), entryId: 'one' })).toMatchObject({ limit: 'bytes' });

    // A published entry is reclaimed under pressure; provisional ones never are.
    expect(await queue.process('one')).toMatchObject({ status: 'published' });
    expect(await queue.stage({ policy: 'p', file: new Blob(['cc']), entryId: 'three' })).toMatchObject({ status: 'staged' });
    expect((await queue.list()).map((e) => e.entryId).sort()).toEqual(['three', 'two']);
  });

  it('reclaims orphaned data and expired published entries but keeps provisional ones', async () => {
    const queue = tab('a', { terminalRetentionMs: 0 });
    await stage(queue, 'keep', { entryId: 'pending' });
    await stage(queue, 'done', { entryId: 'done' });
    await queue.process('done');
    const partition = (await (await storage.root.getDirectoryHandle('filefn-offline-queue')).getDirectoryHandle('v1')).entries.values().next().value as MemoryDirectory;
    const orphanDir = await partition.getDirectoryHandle('e_orphan', { create: true });
    await (await (await orphanDir.getFileHandle('g1.bin', { create: true })).createWritable()).write('orphan');

    expect(await queue.reclaim()).toMatchObject({ removedEntries: 2 });
    expect((await queue.list()).map((e) => e.entryId)).toEqual(['pending']);
    expect(dataFiles()).toHaveLength(1);
  });

  it('reports quota exhaustion as a typed refusal and keeps pending work', async () => {
    const queue = tab('a');
    await stage(queue, 'first', { entryId: 'first' });
    storage.storage.fault = (path, step) => {
      if (path.endsWith('.bin') && step === 'write') throw quotaExceeded();
    };
    expect(await queue.stage({ policy: 'p', file: new Blob(['second']), entryId: 'second' })).toMatchObject({
      status: 'refused',
      reason: 'capacity',
      limit: 'quota',
    });
    storage.storage.fault = undefined;
    expect((await queue.list()).map((e) => e.entryId)).toEqual(['first']);
    expect(dataFiles()).toHaveLength(1);
  });
});

describe('Web Locks', () => {
  it('fails closed without Web Locks or a coordinator and leaves staged work for later', async () => {
    await stage(tab('a'));
    const unlocked = new OfflineQueue({ partition: ALICE, currentPrincipal: () => ALICE.principal, uploader: recordingUploader(), getRoot: async () => storage.root });
    expect(unlocked.capabilities()).toEqual({ durable: false, storage: 'custom', locks: 'unavailable', reason: 'locks-unavailable' });
    expect(await unlocked.stage({ policy: 'p', file: new Blob(['x']) })).toEqual({ status: 'refused', reason: 'locks-unavailable' });
    await expect(unlocked.list()).rejects.toMatchObject({ code: 'FILEFN_QUEUE_LOCKS_UNAVAILABLE' });
    await expect(unlocked.process(FILE_ID)).rejects.toMatchObject({ code: 'FILEFN_QUEUE_LOCKS_UNAVAILABLE' });
    expect(await tab('b').list()).toMatchObject([{ entryId: FILE_ID, state: 'provisional' }]);
  });

  it('uses navigator.locks for every journal write and replay claim when present', async () => {
    const webLocks = new SharedLockManager();
    vi.stubGlobal('navigator', { locks: webLocks.forTab('page') });
    const queue = new OfflineQueue({ partition: ALICE, currentPrincipal: () => ALICE.principal, uploader: recordingUploader(), coordinator: locks.forTab('unused'), getRoot: async () => storage.root });
    expect(queue.capabilities()).toMatchObject({ durable: true, locks: 'web-locks' });
    await stage(queue);
    await queue.process(FILE_ID);
    expect(locks.requests).toEqual([]);
    expect(webLocks.requests.some((name) => name.includes(':entry:'))).toBe(true);
    expect(new Set(webLocks.requests.filter((name) => !name.includes(':entry:'))).size).toBe(1);
  });
});

describe('replay outcomes and identities', () => {
  it.each([
    ['a completion still running in another tab', { status: 409, code: 'FILEFN_UPLOAD_COMPLETION_IN_PROGRESS', details: { retryable: true } }, 'ambiguous'],
    ['a session another tab already completed', { status: 409, code: 'FILEFN_UPLOAD_ALREADY_COMPLETED' }, 'ambiguous'],
    ['a key reused with a different payload', { status: 409, code: 'FILEFN_IDEMPOTENCY_CONFLICT' }, 'failed'],
  ] as const)('keeps %s under the same key only when a replay can settle it', async (_label, failure, reason) => {
    const keys: string[] = [];
    let fail = true;
    const uploader: OfflineQueueUploader = {
      async upload(input) {
        keys.push(input.idempotencyKey);
        if (fail) throw Object.assign(new Error('conflict'), failure);
        return { fileId: input.fileId, versionId: 'ver_1' };
      },
    };
    const queue = tab('a', { uploader });
    await stage(queue, 'v1', { idempotencyKey: 'test-replay-key-0101' });
    expect(await queue.process(FILE_ID)).toMatchObject({ status: 'provisional', reason });
    fail = false;
    if (reason === 'ambiguous') {
      expect(await queue.process(FILE_ID)).toMatchObject({ status: 'published' });
      expect(keys).toEqual(['test-replay-key-0101', 'test-replay-key-0101']);
    } else {
      expect(await queue.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'failed' });
      expect(keys).toHaveLength(1);
    }
  });

  it('refuses a replay key that an earlier generation of the entry used', async () => {
    const queue = tab('a');
    await stage(queue, 'v1', { idempotencyKey: 'test-replay-key-0102' });
    const reuse = () => queue.stage({ policy: 'p', file: new Blob(['v2']), fileId: FILE_ID, idempotencyKey: 'test-replay-key-0102' });
    expect(await reuse()).toMatchObject({ status: 'refused', reason: 'idempotency-key-reused' });
    await stage(queue, 'v2', { idempotencyKey: 'test-replay-key-0103' });
    expect(await reuse()).toMatchObject({ status: 'refused', reason: 'idempotency-key-reused' });
    expect(await queue.get(FILE_ID)).toMatchObject({ size: 2 });
  });

  it('never lets a reference to a removed incarnation act on the entry that replaces it', async () => {
    const a = tab('a', { terminalRetentionMs: 0 });
    const first = await stage(a, 'old');
    const firstWaiter = a.whenSettled(FILE_ID, first.entry.generation);
    expect(await a.cancel(FILE_ID, first.entry.generation)).toBe(true);
    await expect(firstWaiter).rejects.toMatchObject({ code: 'FILEFN_QUEUE_CANCELLED' });

    const second = await stage(tab('b'), 'new', { expectedGeneration: 0 });
    expect(second.entry.generation).not.toBe(first.entry.generation);
    expect(await a.cancel(FILE_ID, first.entry.generation)).toBe(false);
    await expect(a.hold(FILE_ID, first.entry.generation)).rejects.toMatchObject({ code: 'FILEFN_QUEUE_STALE_GENERATION' });
    await expect(a.whenSettled(FILE_ID, first.entry.generation)).rejects.toMatchObject({ code: 'FILEFN_QUEUE_SUPERSEDED' });
    expect(await a.get(FILE_ID)).toMatchObject({ generation: second.entry.generation, size: 3 });

    // The same holds after a published entry is reclaimed.
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'published' });
    await a.reclaim();
    const third = await stage(a, 'newer', { expectedGeneration: 0 });
    expect([first.entry.generation, second.entry.generation]).not.toContain(third.entry.generation);
  });
});

describe('verification and publication boundaries', () => {
  it('leaves a generation provisional in an instance that lacks the hooks it was staged with', async () => {
    const verify = vi.fn(async () => ({ verified: true as const }));
    const run = vi.fn(async () => ({}));
    const withHooks = tab('a', { hooks: { verify, publish: { run } } });
    await stage(withHooks);
    const bare = tab('b');
    expect(await bare.process(FILE_ID)).toMatchObject({
      status: 'provisional',
      reason: 'hook-unavailable',
      entry: { phase: 'uploaded', state: 'provisional' },
    });
    expect(await tab('c', { hooks: { verify } }).process(FILE_ID)).toMatchObject({ reason: 'hook-unavailable', entry: { phase: 'verified' } });
    expect(run).not.toHaveBeenCalled();
    expect(await withHooks.process(FILE_ID)).toMatchObject({ status: 'published' });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('fences reconcile and hold against a publication another tab is running, and publishes once', async () => {
    const hanging = deferred<{ result?: unknown }>();
    const run = vi.fn(() => hanging.promise);
    const a = tab('a', { hooks: { publish: { run } } });
    const b = tab('b', { hooks: { publish: { run } } });
    const { entry } = await stage(a);
    const published: string[] = [];
    for (const queue of [a, b]) queue.subscribe((event) => event.type === 'published' && published.push(event.entry.operationId));
    const running = a.process(FILE_ID);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    await expect(b.reconcile(FILE_ID, entry.generation, { published: true })).rejects.toMatchObject({ code: 'FILEFN_QUEUE_BUSY' });
    expect(await b.hold(FILE_ID, entry.generation)).toEqual({ status: 'refused', reason: 'publication-started', phase: 'publishing' });
    await expect(b.reconcile(FILE_ID, entry.generation, {} as never)).rejects.toMatchObject({ code: 'FILEFN_QUEUE_INVALID_INPUT' });

    hanging.resolve({ result: 'linked' });
    expect(await running).toMatchObject({ status: 'published', entry: { publication: { result: 'linked' } } });
    expect(published).toEqual([entry.operationId]);
    expect(await b.hold(FILE_ID, entry.generation)).toMatchObject({ status: 'refused', reason: 'final' });
  });
});

describe('lifecycle and principal binding', () => {
  it('starts no upload once disposed between journaling the claim and sending the request', async () => {
    const upload = vi.fn(async (input: { fileId: string }) => ({ fileId: input.fileId, versionId: 'ver_1' }));
    const a = tab('a', { uploader: { upload } });
    await stage(a);
    storage.storage.fault = (path, step) => {
      if (path.endsWith('journal.json') && step === 'close') {
        storage.storage.fault = undefined;
        a.dispose();
      }
    };
    await expect(a.process(FILE_ID)).rejects.toMatchObject({ code: 'FILEFN_QUEUE_DISPOSED' });
    expect(upload).not.toHaveBeenCalled();
  });

  it('aborts the upload a disposed OfflineSync was driving and leaves the entry for later', async () => {
    const signals: AbortSignal[] = [];
    const hanging = deferred<{ fileId: string; versionId: string }>();
    const a = tab('a', { uploader: { upload: (input) => (signals.push(input.signal), hanging.promise) } });
    await stage(a);
    const sync = onlineSync(a);
    const pass = sync.syncAll();
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    sync.dispose();
    expect(signals[0].aborted).toBe(true);
    await pass;
    expect(a.isDisposed).toBe(false);
    expect(await a.get(FILE_ID)).toMatchObject({ phase: 'uploading', state: 'provisional' });
  });

  it('runs no upload or hook while the credentials act for another principal', async () => {
    let signedIn: OfflineQueuePrincipal | null = ALICE.principal;
    const keys: string[] = [];
    const run = vi.fn(async () => ({}));
    const uploader: OfflineQueueUploader = {
      async upload(input) {
        keys.push(input.idempotencyKey);
        // Another tab sharing cookies switches the account while this upload runs.
        signedIn = BOB.principal;
        return { fileId: input.fileId, versionId: 'ver_1' };
      },
    };
    const a = tab('a', { uploader, hooks: { publish: { run } }, currentPrincipal: () => signedIn });
    await stage(a);

    signedIn = null;
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'principal-mismatch', entry: { attempts: 0 } });
    expect(keys).toEqual([]);
    signedIn = ALICE.principal;
    expect(await a.process(FILE_ID)).toMatchObject({ reason: 'principal-mismatch', entry: { phase: 'uploaded' } });
    expect(run).not.toHaveBeenCalled();

    signedIn = ALICE.principal;
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'published' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('sync and cross-tab observation', () => {
  it('runs a follow-up pass for work staged while a pass is running', async () => {
    const slow = deferred<{ fileId: string; versionId: string }>();
    const uploaded: string[] = [];
    const a = tab('a', {
      uploader: {
        async upload(input) {
          uploaded.push(input.fileId);
          return input.fileId === 'file_00000000slow0001' ? slow.promise : { fileId: input.fileId, versionId: 'ver_2' };
        },
      },
    });
    await a.stage({ policy: 'p', file: new Blob(['slow']), fileId: 'file_00000000slow0001' });
    const sync = onlineSync(a);
    const pass = sync.syncAll();
    await vi.waitFor(() => expect(uploaded).toEqual(['file_00000000slow0001']));

    const late = await a.stage({ policy: 'p', file: new Blob(['late']), fileId: 'file_00000000late0001' });
    if (late.status !== 'staged') throw new Error('refused');
    const settled = a.whenSettled('file_00000000late0001', late.entry.generation);
    await sync.syncAll();
    slow.resolve({ fileId: 'file_00000000slow0001', versionId: 'ver_1' });
    await pass;
    await expect(settled).resolves.toMatchObject({ state: 'published' });
    sync.dispose();
  });

  it('settles a waiter in one tab when another tab publishes the generation', async () => {
    const a = tab('a', { observeIntervalMs: 5 });
    const { entry } = await stage(a);
    const settled = a.whenSettled(FILE_ID, entry.generation);
    expect(await tab('b').process(FILE_ID)).toMatchObject({ status: 'published' });
    await expect(settled).resolves.toMatchObject({ state: 'published' });
  });

  it('retries an entry another tab was processing and takes it over once that tab closes', async () => {
    const uploadA = vi.fn(() => new Promise<never>(() => {}));
    const a = tab('a', { uploader: { upload: uploadA } });
    const { entry } = await stage(a);
    void a.process(FILE_ID).catch(() => {});
    await vi.waitFor(() => expect(uploadA).toHaveBeenCalled());

    const b = tab('b');
    const settled = b.whenSettled(FILE_ID, entry.generation);
    const sync = onlineSync(b, { retryDelayMs: 5 });
    expect(await sync.syncAll()).toMatchObject({ totalProcessed: 0 });
    locks.closeTab('a');
    a.dispose();
    await expect(settled).resolves.toMatchObject({ state: 'published', attempts: 2 });
    sync.dispose();
  });

  it('reports the retry limit durably to waiters, listeners and the sync, and retries after reconcile with the same key', async () => {
    let fail = true;
    const keys: string[] = [];
    const uploader: OfflineQueueUploader = {
      async upload(input) {
        keys.push(input.idempotencyKey);
        if (fail) throw new TypeError('fetch failed');
        return { fileId: input.fileId, versionId: 'ver_1' };
      },
    };
    const a = tab('a', { uploader, maxUploadAttempts: 2 });
    const { entry } = await stage(a);
    const settled = a.whenSettled(FILE_ID, entry.generation);
    void settled.catch(() => {});
    const events: string[] = [];
    a.subscribe((event) => events.push(`${event.type}:${event.entry.pending?.reason}`));
    await a.process(FILE_ID);
    await a.process(FILE_ID);

    const codes: string[] = [];
    const sync = onlineSync(a, { onSyncError: (error) => codes.push((error as Error & { code?: string }).code ?? '') });
    await sync.syncAll();
    expect(codes).toEqual(['retry-limit']);
    await expect(settled).rejects.toMatchObject({ code: 'FILEFN_QUEUE_RETRY_LIMIT' });
    expect(events).toContain('provisional:retry-limit');
    expect(await tab('a2').get(FILE_ID)).toMatchObject({ state: 'provisional', pending: { reason: 'retry-limit' } });

    fail = false;
    await a.reconcile(FILE_ID, entry.generation);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'published' });
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    sync.dispose();
  });
});

describe('storage reclamation boundaries', () => {
  it('keeps the entry being restaged when reclaiming under pressure', async () => {
    const queue = tab('a', { limits: { maxEntries: 5, maxBytes: 10 } });
    await stage(queue, 'one', { entryId: 'one' });
    expect(await queue.process('one')).toMatchObject({ status: 'published' });
    await writeCommitted(await (await partitionDir()).getDirectoryHandle('e_orphan', { create: true }), 'g1.bin', 'orphan');

    const restaged = await queue.stage({ policy: 'p', file: new Blob(['eightbyt']), entryId: 'one' });
    expect(restaged).toMatchObject({ status: 'staged', entry: { entryId: 'one', phase: 'staged' } });
    expect(await queue.list()).toMatchObject([{ entryId: 'one', phase: 'staged', size: 8 }]);
    expect(await queue.process('one')).toMatchObject({ status: 'published' });
  });

  it('revokes a preview URL once its generation is published or the entry is removed in another tab', async () => {
    const revoked: string[] = [];
    let created = 0;
    vi.stubGlobal('URL', { createObjectURL: () => `blob:preview-${++created}`, revokeObjectURL: (url: string) => revoked.push(url) });
    const a = tab('a');
    await stage(a);
    await stage(a, 'two', { entryId: 'two', fileId: 'file_00000000entry02' });
    expect(await a.getPendingLocalDescriptor(FILE_ID)).toMatchObject({ source: { url: 'blob:preview-1' } });
    expect(await a.getPendingLocalDescriptor('file_00000000entry02')).toMatchObject({ source: { url: 'blob:preview-2' } });

    await a.process(FILE_ID);
    expect(revoked).toEqual(['blob:preview-1']);
    await tab('b').cancel('two');
    await a.list();
    expect(revoked).toEqual(['blob:preview-1', 'blob:preview-2']);
  });

  it('refuses to migrate a legacy upload whose file ID is invalid', async () => {
    const legacy = await (await storage.root.getDirectoryHandle('filefn-pending-uploads', { create: true }))
      .getDirectoryHandle('offline_1731000000000_legacy002', { create: true });
    await writeCommitted(legacy, 'data.bin', 'old bytes');
    await writeCommitted(legacy, 'metadata.json', JSON.stringify({ uploadSessionId: 'offline_1731000000000_legacy002', fileId: 'not a file id', policy: 'p', fileName: 'old.txt', size: 9, mimeType: 'text/plain', createdAt: '2026-11-01T00:00:00.000Z', retryCount: 0, metadataVersion: 2 }));
    const queue = tab('a');
    await expect(queue.migrateLegacyUpload('offline_1731000000000_legacy002', { ownershipVerified: true })).rejects.toMatchObject({
      code: expect.stringContaining('INVALID_FILE_ID'),
    });
    expect(await queue.list()).toEqual([]);
  });
});

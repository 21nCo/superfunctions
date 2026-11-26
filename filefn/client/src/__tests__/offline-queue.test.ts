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
  ChannelBus,
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
let bus: ChannelBus;

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
    channel: bus.channel,
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
  bus = new ChannelBus();
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

    // A disposed tab's interrupted upload uses up no attempt.
    expect(await b.process(FILE_ID)).toMatchObject({ status: 'published', entry: { attempts: 0, upload: { versionId: 'ver_1' } } });
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
    expect(keys[0]).toMatch(/^test-replay-key-0001:op_/);
    expect(keys).toEqual([keys[0], keys[0]]);
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
    expect(keys[0]).toMatch(/^test-replay-key-0002:op_/);
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
    const [unconfirmed] = await reloaded.list();
    await reloaded.reconcile(FILE_ID, 1, { published: true, result: { recordId: 'rec-1' }, attemptId: unconfirmed.publicationAttemptId! });
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
      expect(keys[0]).toMatch(/^test-replay-key-0101:/);
      expect(keys).toEqual([keys[0], keys[0]]);
    } else {
      expect(await queue.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'failed' });
      expect(keys).toHaveLength(1);
    }
  });

  it('sends a distinct key for every generation, across entries, cancels and reclaims, whatever key the caller passes', async () => {
    const uploader = recordingUploader();
    const queue = tab('a', { uploader, terminalRetentionMs: 0 });
    const sameKey = { idempotencyKey: 'test-replay-key-0102' };
    await stage(queue, 'v1', sameKey);
    await stage(queue, 'v2', sameKey);
    await stage(queue, 'v3', { ...sameKey, entryId: 'other-entry' });
    await queue.processAll();
    await queue.reclaim();
    expect(await queue.list()).toEqual([]);
    await stage(queue, 'v4', sameKey);
    await queue.processAll();
    const keys = uploader.calls.map((call) => call.idempotencyKey);
    expect(uploader.calls.map((call) => call.body)).toEqual(['v2', 'v3', 'v4']);
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key).toMatch(/^test-replay-key-0102:op_/);
  });

  it.each([' padded-key ', 'key with spaces', 'k\u00e9y', '', 'x'.repeat(201)])('refuses a key the header would change or reject: %j', async (key) => {
    await expect(tab('a').stage({ policy: 'p', file: new Blob(['x']), idempotencyKey: key })).rejects.toMatchObject({
      code: 'FILEFN_QUEUE_INVALID_INPUT',
    });
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

    await expect(b.reconcile(FILE_ID, entry.generation, { published: true, attemptId: 'pub_unknown' })).rejects.toMatchObject({
      code: 'FILEFN_QUEUE_BUSY',
    });
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
        // Another tab sharing cookies switches the account while the first upload runs.
        if (keys.length === 1) signedIn = BOB.principal;
        return { fileId: input.fileId, versionId: 'ver_1' };
      },
    };
    const a = tab('a', { uploader, hooks: { publish: { run } }, currentPrincipal: () => signedIn });
    await stage(a);

    signedIn = null;
    // No entry data is returned to another principal.
    expect(await a.process(FILE_ID)).toEqual({ status: 'stopped', reason: 'principal-mismatch' });
    expect(keys).toEqual([]);
    signedIn = ALICE.principal;
    // The outcome returned after the switch is not recorded: the claim stays as journaled.
    expect(await a.process(FILE_ID)).toEqual({ status: 'stopped', reason: 'principal-mismatch' });
    expect(run).not.toHaveBeenCalled();
    signedIn = ALICE.principal;
    expect(await a.get(FILE_ID)).toMatchObject({ phase: 'uploading', attempts: 0 });

    signedIn = ALICE.principal;
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'published' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(keys).toEqual([keys[0], keys[0]]);
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
    await expect(settled).resolves.toMatchObject({ state: 'published', attempts: 0 });
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

describe('principal binding of a live tab', () => {
  it('refuses every local read and write while the tab’s principal is another, and keeps the work for its owner', async () => {
    let signedIn: OfflineQueuePrincipal | null = ALICE.principal;
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });
    const uploader = recordingUploader();
    const a = tab('a', { uploader, currentPrincipal: () => signedIn });
    const { entry } = await stage(a);
    const hold = heldId(await a.hold(FILE_ID, entry.generation));

    signedIn = BOB.principal;
    const mismatch = { code: 'FILEFN_QUEUE_PRINCIPAL_MISMATCH' };
    await expect(a.list()).rejects.toMatchObject(mismatch);
    await expect(a.get(FILE_ID)).rejects.toMatchObject(mismatch);
    await expect(a.getPendingLocalDescriptor(FILE_ID)).rejects.toMatchObject(mismatch);
    await expect(a.cancel(FILE_ID)).rejects.toMatchObject(mismatch);
    await expect(a.release(FILE_ID, entry.generation, hold)).rejects.toMatchObject(mismatch);
    await expect(a.hold(FILE_ID, entry.generation)).rejects.toMatchObject(mismatch);
    await expect(a.reconcile(FILE_ID, entry.generation)).rejects.toMatchObject(mismatch);
    await expect(a.usage()).rejects.toMatchObject(mismatch);
    await expect(a.reclaim()).rejects.toMatchObject(mismatch);
    await expect(a.listLegacyUploads()).rejects.toMatchObject(mismatch);
    expect(await a.stage({ policy: 'p', file: new Blob(['bob']), fileId: FILE_ID })).toEqual({ status: 'refused', reason: 'principal-mismatch' });
    signedIn = null;
    await expect(a.list()).rejects.toMatchObject(mismatch);

    signedIn = ALICE.principal;
    expect(await a.release(FILE_ID, entry.generation, hold)).toBe(true);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'published', entry: { size: 2 } });
    expect(uploader.calls).toHaveLength(1);
  });

  it('does not fail a generation for an authorization refusal: it stays pending and publishes once its principal is back', async () => {
    let signedIn: OfflineQueuePrincipal = ALICE.principal;
    const keys: string[] = [];
    const uploader: OfflineQueueUploader = {
      async upload(input) {
        keys.push(input.idempotencyKey);
        if (keys.length === 1) {
          // The session switched under this upload: the server refuses the next request.
          signedIn = BOB.principal;
          throw Object.assign(new Error('HTTP 403'), { status: 403, code: 'FILEFN_FORBIDDEN' });
        }
        return { fileId: input.fileId, versionId: 'ver_1' };
      },
    };
    const a = tab('a', { uploader, currentPrincipal: () => signedIn });
    await stage(a);
    expect(await a.process(FILE_ID)).toEqual({ status: 'stopped', reason: 'principal-mismatch' });
    signedIn = ALICE.principal;
    expect(await tab('a2').get(FILE_ID)).toMatchObject({ phase: 'uploading', attempts: 0 });
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'published' });
    expect(keys).toEqual([keys[0], keys[0]]);
  });
});

describe('fencing a stopped pass', () => {
  it('journals nothing for a pass whose signal is already aborted', async () => {
    const upload = vi.fn(async (input: { fileId: string }) => ({ fileId: input.fileId, versionId: 'ver_1' }));
    const a = tab('a', { uploader: { upload } });
    await stage(a);
    const before = journalOf(FILE_ID).content;
    const controller = new AbortController();
    controller.abort();
    expect(await a.process(FILE_ID, { signal: controller.signal })).toEqual({ status: 'stopped', reason: 'aborted' });
    expect(journalOf(FILE_ID).content).toBe(before);
    expect(upload).not.toHaveBeenCalled();
  });

  it('stops plan-only transitions when the driving sync is disposed during the principal check', async () => {
    const gate = deferred<OfflineQueuePrincipal>();
    let paused = false;
    const run = vi.fn(async () => ({}));
    const a = tab('a', {
      hooks: { publish: { run } },
      currentPrincipal: () => {
        let phase = 'none';
        try {
          phase = JSON.parse(new TextDecoder().decode(journalOf(FILE_ID).content)).current.phase;
        } catch {
          // No committed journal yet.
        }
        if (phase !== 'uploaded' || paused) return ALICE.principal;
        paused = true;
        return gate.promise;
      },
    });
    await stage(a);
    const sync = onlineSync(a);
    const pass = sync.syncAll();
    await vi.waitFor(() => expect(paused).toBe(true));
    sync.dispose();
    gate.resolve(ALICE.principal);
    await pass;
    expect(await a.get(FILE_ID)).toMatchObject({ phase: 'uploaded', state: 'provisional' });
    expect(run).not.toHaveBeenCalled();

    expect(await onlineSync(a).syncAll()).toMatchObject({ succeeded: [FILE_ID] });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('records no late outcome when the queue is disposed while the outcome is being committed', async () => {
    const gate = deferred<OfflineQueuePrincipal>();
    let uploaded = false;
    let paused = false;
    const a = tab('a', {
      uploader: {
        async upload(input) {
          uploaded = true;
          return { fileId: input.fileId, versionId: 'ver_1' };
        },
      },
      currentPrincipal: () => {
        if (!uploaded || paused) return ALICE.principal;
        paused = true;
        return gate.promise;
      },
    });
    await stage(a);
    const running = a.process(FILE_ID);
    await vi.waitFor(() => expect(paused).toBe(true));
    a.dispose();
    gate.resolve(ALICE.principal);
    await expect(running).rejects.toMatchObject({ code: 'FILEFN_QUEUE_DISPOSED' });
    expect(await tab('b').get(FILE_ID)).toMatchObject({ phase: 'uploading', state: 'provisional' });
  });

  it('keeps the entry claimed until a publication hook that ignores its abort settles', async () => {
    const hanging = deferred<{ result?: unknown }>();
    const run = vi.fn((_ctx: unknown) => hanging.promise);
    const a = tab('a', { hooks: { publish: { run } } });
    const reconcileHook = vi.fn(async () => ({ published: true as const, result: 'found' }));
    const b = tab('b', { hooks: { publish: { run, reconcile: reconcileHook } } });
    const { entry } = await stage(a);
    const controller = new AbortController();
    const running = a.process(FILE_ID, { signal: controller.signal });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(await running).toEqual({ status: 'stopped', reason: 'aborted' });

    expect(await b.process(FILE_ID)).toEqual({ status: 'busy' });
    await expect(b.reconcile(FILE_ID, entry.generation)).rejects.toMatchObject({ code: 'FILEFN_QUEUE_BUSY' });
    expect(reconcileHook).not.toHaveBeenCalled();

    hanging.resolve({ result: 'late' });
    await vi.waitFor(async () => expect(await b.process(FILE_ID)).toMatchObject({ status: 'published', entry: { publication: { result: 'found' } } }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(reconcileHook).toHaveBeenCalledTimes(1);
  });
});

describe('publication attempts', () => {
  it('binds manual outcomes to their attempt, refuses a stale one, and reports a confirmed publication once', async () => {
    let fail = true;
    const run = vi.fn(async () => {
      if (fail) throw new TypeError('fetch failed');
      return {};
    });
    const a = tab('a', { hooks: { publish: { run } } });
    const { entry } = await stage(a);
    const events: string[] = [];
    a.subscribe((event) => event.type === 'published' && events.push(event.entry.operationId));
    await a.process(FILE_ID);
    expect(await a.process(FILE_ID)).toMatchObject({ reason: 'needs-reconcile' });
    const first = (await a.get(FILE_ID))!.publicationAttemptId!;

    await a.reconcile(FILE_ID, entry.generation, { published: false, attemptId: first });
    await a.process(FILE_ID);
    const second = (await a.get(FILE_ID))!.publicationAttemptId!;
    expect(second).not.toBe(first);
    // A late negative readback of the first attempt cannot reopen the second.
    await expect(a.reconcile(FILE_ID, entry.generation, { published: false, attemptId: first })).rejects.toMatchObject({
      code: 'FILEFN_QUEUE_STALE_ATTEMPT',
    });
    expect(run).toHaveBeenCalledTimes(2);

    await a.reconcile(FILE_ID, entry.generation, { published: true, result: 'rec-2', attemptId: second });
    await a.reconcile(FILE_ID, entry.generation, { published: true, result: 'other', attemptId: second });
    await a.reconcile(FILE_ID, entry.generation);
    expect(await a.get(FILE_ID)).toMatchObject({ state: 'published', publication: { result: 'rec-2' } });
    expect(events).toEqual([entry.operationId]);
  });

  it('never confirms an upload result that names no version', async () => {
    const a = tab('a', { uploader: { upload: async (input) => ({ fileId: input.fileId }) as never } });
    const { entry } = await stage(a);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'uploading' } });
    expect(await a.get(FILE_ID)).toMatchObject({ generation: entry.generation, state: 'provisional' });
    expect(dataFiles()).toHaveLength(1);
  });

  it('keeps a verification another instance started required for every later instance', async () => {
    const verify = vi.fn(async (): Promise<{ verified: true }> => {
      throw new Error('verifier offline');
    });
    await stage(tab('bare'));
    expect(await tab('verifier', { hooks: { verify } }).process(FILE_ID)).toMatchObject({ reason: 'ambiguous' });
    expect(await tab('bare2').process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'hook-unavailable', entry: { phase: 'verifying' } });
    expect(await tab('bare3').get(FILE_ID)).toMatchObject({ state: 'provisional' });
  });
});

describe('durable partition state', () => {
  it('reports a published generation to another tab’s waiter after pressure reclaims its entry', async () => {
    const a = tab('a', { limits: { maxEntries: 1, maxBytes: 100 } });
    const b = tab('b', { observeIntervalMs: 0 });
    const { entry } = await stage(a);
    const settled = b.whenSettled(FILE_ID, entry.generation);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'published' });
    await stage(a, 'next', { entryId: 'next', fileId: 'file_00000000entry02' });
    await b.list();
    await expect(settled).resolves.toMatchObject({ entryId: FILE_ID, generation: entry.generation, state: 'published' });
  });

  it('credits only bytes still present when an interrupted cleanup left the journal behind', async () => {
    let journalWrites = 0;
    storage.storage.fault = (path, step) => {
      // staged, uploading, uploaded, verified, published, then cleanup (the 6th) fails after the data is removed.
      if (path.endsWith('journal.json') && step === 'close' && ++journalWrites === 6) throw new Error('crash');
    };
    const a = tab('a', { limits: { maxEntries: 5, maxBytes: 5 } });
    await stage(a, 'abc');
    await expect(a.process(FILE_ID)).rejects.toThrow('crash');
    storage.storage.fault = undefined;
    expect(dataFiles()).toEqual([]);
    expect(await a.stage({ policy: 'p', file: new Blob(['abcdef']), fileId: FILE_ID })).toMatchObject({
      status: 'refused',
      reason: 'capacity',
      limit: 'bytes',
    });
  });

  it('admits a legacy upload once across tabs and entry IDs, and never again after its entry is gone', async () => {
    const writeLegacy = async () => {
      const legacy = await (await storage.root.getDirectoryHandle('filefn-pending-uploads', { create: true }))
        .getDirectoryHandle('offline_1731000000000_legacy003', { create: true });
      await writeCommitted(legacy, 'data.bin', 'old bytes');
      await writeCommitted(legacy, 'metadata.json', JSON.stringify({ uploadSessionId: 'offline_1731000000000_legacy003', fileId: FILE_ID, policy: 'p', fileName: 'old.txt', size: 9, mimeType: 'text/plain', createdAt: '2026-11-01T00:00:00.000Z', retryCount: 0, metadataVersion: 2, idempotencyKey: 'test-legacy-key-0003' }));
    };
    await writeLegacy();
    const a = tab('a');
    const b = tab('b');
    const results = await Promise.all([
      a.migrateLegacyUpload('offline_1731000000000_legacy003', { ownershipVerified: true, entryId: 'm1' }),
      b.migrateLegacyUpload('offline_1731000000000_legacy003', { ownershipVerified: true, entryId: 'm2' }),
    ]);
    const entries = await a.list();
    expect(entries).toHaveLength(1);
    expect(results.map((r) => r.status === 'staged' && r.entry.entryId)).toEqual([entries[0].entryId, entries[0].entryId]);

    // Its cleanup was interrupted, and the migrated entry was cancelled since.
    await writeLegacy();
    expect(await a.cancel(entries[0].entryId)).toBe(true);
    expect(await a.migrateLegacyUpload('offline_1731000000000_legacy003', { ownershipVerified: true })).toEqual({
      status: 'refused',
      reason: 'already-migrated',
    });
    expect(await a.list()).toEqual([]);
    expect(await a.listLegacyUploads()).toEqual([]);
  });
});

describe('sync wakeups', () => {
  it('drives a generation that replaced the one it was uploading, without another online event', async () => {
    const first = deferred<{ fileId: string; versionId: string }>();
    let calls = 0;
    const a = tab('a', {
      uploader: {
        upload: async (input) => (++calls === 1 ? first.promise : { fileId: input.fileId, versionId: 'ver_2' }),
      },
    });
    await stage(a, 'v1');
    const sync = onlineSync(a);
    const pass = sync.syncAll();
    await vi.waitFor(() => expect(calls).toBe(1));
    const b = tab('b');
    const { entry } = await stage(b, 'v2');
    const settled = a.whenSettled(FILE_ID, entry.generation);
    locks.closeTab('b');
    b.dispose();
    first.resolve({ fileId: FILE_ID, versionId: 'ver_1' });
    await pass;
    await expect(settled).resolves.toMatchObject({ generation: entry.generation, upload: { versionId: 'ver_2' } });
    sync.dispose();
  });

  it.each(['the whole pass', 'one entry'])('retries %s held back by a principal mismatch once the principal is back', async (scope) => {
    let signedIn: OfflineQueuePrincipal | null = ALICE.principal;
    const a = tab('a', { currentPrincipal: () => signedIn });
    const { entry } = await stage(a);
    const settled = a.whenSettled(FILE_ID, entry.generation);
    if (scope === 'the whole pass') signedIn = null;
    else {
      // The pass lists the entries as Alice, then the account switches before the entry is planned.
      const process = a.process.bind(a);
      vi.spyOn(a, 'process').mockImplementationOnce((...args) => {
        signedIn = null;
        return process(...args);
      });
    }
    const sync = onlineSync(a, { retryDelayMs: 5 });
    await sync.syncAll();
    expect(await tab('a2').get(FILE_ID)).toMatchObject({ phase: 'staged' });
    signedIn = ALICE.principal;
    await expect(settled).resolves.toMatchObject({ state: 'published' });
    sync.dispose();
  });
});

/** The committed phase of FILE_ID's journal, or 'none'. */
function committedPhase(): string {
  try {
    return JSON.parse(new TextDecoder().decode(journalOf(FILE_ID).content)).current.phase;
  } catch {
    return 'none';
  }
}

describe('principal checked at each effect', () => {
  it('returns no entry data from processing a held entry once the principal changed', async () => {
    let signedIn: OfflineQueuePrincipal = ALICE.principal;
    const a = tab('a', { currentPrincipal: () => signedIn });
    await stage(a, 'v1', { hold: true, metadata: { title: 'alice-private' } });
    signedIn = BOB.principal;
    expect(await a.process(FILE_ID)).toEqual({ status: 'stopped', reason: 'principal-mismatch' });
  });

  it('refuses a listing when the principal changes while the journals are read', async () => {
    let armed = false;
    let checks = 0;
    const a = tab('a', { currentPrincipal: () => (armed && ++checks > 1 ? BOB.principal : ALICE.principal) });
    await stage(a, 'v1', { metadata: { title: 'alice-private' } });
    armed = true;
    await expect(a.list()).rejects.toMatchObject({ code: 'FILEFN_QUEUE_PRINCIPAL_MISMATCH' });
  });

  it('starts no verification when the principal changes as its claim is written', async () => {
    let switched = true;
    const verify = vi.fn(async () => ({ verified: true as const }));
    const a = tab('a', {
      hooks: { verify },
      currentPrincipal: () => (switched && committedPhase() === 'verifying' ? BOB.principal : ALICE.principal),
    });
    await stage(a);
    expect(await a.process(FILE_ID)).toEqual({ status: 'stopped', reason: 'principal-mismatch' });
    expect(verify).not.toHaveBeenCalled();
    switched = false;
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'published' });
    expect(verify).toHaveBeenCalledTimes(1);
  });
});

describe('durable step boundaries', () => {
  it('keeps publication required when the instance that started verification closes', async () => {
    const pending = deferred<{ verified: true }>();
    const run = vi.fn(async () => ({}));
    await stage(tab('bare'));
    const full = tab('full', { hooks: { verify: () => pending.promise, publish: { run } } });
    void full.process(FILE_ID).catch(() => {});
    await vi.waitFor(() => expect(committedPhase()).toBe('verifying'));
    locks.closeTab('full');
    full.dispose();
    const verifier = tab('verifier', { hooks: { verify: async () => ({ verified: true as const }) } });
    expect(await verifier.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'hook-unavailable', entry: { phase: 'verified' } });
    expect(run).not.toHaveBeenCalled();
  });

  it('commits no outcome when the pass stops while its journal write is prepared', async () => {
    const controller = new AbortController();
    let armed = false;
    const a = tab('a', {
      uploader: {
        async upload(input) {
          armed = true;
          return { fileId: input.fileId, versionId: 'ver_1' };
        },
      },
    });
    await stage(a);
    storage.storage.fault = (path, step) => {
      if (armed && path.endsWith('journal.json') && step === 'write') {
        armed = false;
        controller.abort();
      }
    };
    expect(await a.process(FILE_ID, { signal: controller.signal })).toEqual({ status: 'stopped', reason: 'aborted' });
    storage.storage.fault = undefined;
    expect(await a.get(FILE_ID)).toMatchObject({ phase: 'uploading', state: 'provisional' });
  });

  it('never confirms an upload result whose version is blank', async () => {
    const a = tab('a', { uploader: { upload: async (input) => ({ fileId: input.fileId, versionId: '  ' }) } });
    await stage(a);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'uploading' } });
  });

  it('gives every idempotent rerun its own attempt, so an outcome of an earlier one never settles it', async () => {
    const run = vi.fn(async (_ctx: { publicationAttemptId?: string }): Promise<{ result?: unknown }> => {
      throw new Error('publisher unreachable');
    });
    const a = tab('a', { hooks: { publish: { run, idempotent: true } } });
    const { entry } = await stage(a);
    expect(await a.process(FILE_ID)).toMatchObject({ reason: 'ambiguous' });
    const first = (await a.get(FILE_ID))!.publicationAttemptId!;
    expect(await a.process(FILE_ID)).toMatchObject({ reason: 'ambiguous' });
    const second = (await a.get(FILE_ID))!.publicationAttemptId!;
    expect(second).not.toBe(first);
    expect(run.mock.calls.map(([ctx]) => ctx.publicationAttemptId)).toEqual([first, second]);
    await expect(a.reconcile(FILE_ID, entry.generation, { attemptId: first, published: false })).rejects.toMatchObject({
      code: 'FILEFN_QUEUE_STALE_ATTEMPT',
    });
  });

  it('resolves a waiter of a published generation that a newer generation replaced', async () => {
    const a = tab('a', { observeIntervalMs: 0 });
    const b = tab('b');
    const { entry } = await stage(b);
    const settled = a.whenSettled(FILE_ID, entry.generation);
    expect(await b.process(FILE_ID)).toMatchObject({ status: 'published' });
    await stage(b, 'v2');
    await a.get(FILE_ID);
    await expect(settled).resolves.toMatchObject({ generation: entry.generation, state: 'published' });
  });

  it('takes over no replay key that two legacy uploads share: each gets a key of its own', async () => {
    for (const n of ['4', '5']) {
      const id = `offline_1731000000000_legacy00${n}`;
      const legacy = await (await storage.root.getDirectoryHandle('filefn-pending-uploads', { create: true })).getDirectoryHandle(id, { create: true });
      await writeCommitted(legacy, 'data.bin', `bytes ${n}`);
      await writeCommitted(legacy, 'metadata.json', JSON.stringify({ uploadSessionId: id, fileId: `file_00000000legacy0${n}`, policy: 'p', fileName: 'old.txt', size: 7, mimeType: 'text/plain', createdAt: '2026-11-01T00:00:00.000Z', retryCount: 0, metadataVersion: 2, idempotencyKey: 'test-legacy-key-shared' }));
    }
    const uploader = recordingUploader();
    const a = tab('a', { uploader });
    for (const n of ['4', '5']) {
      expect(await a.migrateLegacyUpload(`offline_1731000000000_legacy00${n}`, { ownershipVerified: true })).toMatchObject({ status: 'staged' });
    }
    await a.processAll();
    expect(uploader.calls).toHaveLength(2);
    const keys = uploader.calls.map((call) => call.idempotencyKey);
    expect(keys).not.toContain('test-legacy-key-shared');
    expect(new Set(keys).size).toBe(2);
  });
});

describe('capacity boundaries', () => {
  it('refuses with a typed quota result when reclamation runs out of storage, and keeps the published record', async () => {
    const a = tab('a', { limits: { maxEntries: 1, maxBytes: 100 } });
    await stage(a);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'published' });
    storage.storage.fault = (path, step) => {
      if (path.endsWith('partition.json') && step === 'write') throw quotaExceeded();
    };
    expect(await a.stage({ policy: 'p', file: new Blob(['next']), entryId: 'next', fileId: 'file_00000000entry02' })).toMatchObject({
      status: 'refused',
      reason: 'capacity',
      limit: 'quota',
    });
    storage.storage.fault = undefined;
    expect(await a.get(FILE_ID)).toMatchObject({ state: 'published' });
  });

  it('reclaims unreferenced files beside the restaged entry before refusing for bytes', async () => {
    const a = tab('a', { limits: { maxEntries: 5, maxBytes: 10 } });
    await stage(a, 'aaaa');
    // An interrupted replacement left a file the journal does not name.
    const entryDir = [...(await partitionDir()).entries.values()].find((entry) => entry instanceof MemoryDirectory) as MemoryDirectory;
    await writeCommitted(entryDir, 'g99.bin', 'oooooo');
    expect(await a.stage({ policy: 'p', file: new Blob(['bbbbbbbb']), fileId: FILE_ID })).toMatchObject({ status: 'staged' });
    expect(await a.usage()).toEqual({ entries: 1, bytes: 8 });
  });
});

describe('sync passes', () => {
  it.each(['this tab', 'another tab'])('drives a generation once a hold is released in %s', async (where) => {
    const a = tab('a');
    const { holdId, entry } = await stage(a, 'v1', { hold: true });
    const sync = onlineSync(a, { retryDelayMs: 5 });
    sync.start();
    await vi.waitFor(async () => expect(await a.get(FILE_ID)).toMatchObject({ phase: 'staged' }));
    expect(await (where === 'this tab' ? a : tab('b')).release(FILE_ID, entry.generation, holdId!)).toBe(true);
    await vi.waitFor(async () => expect(await a.get(FILE_ID)).toMatchObject({ state: 'published' }), { timeout: 2000 });
    sync.dispose();
  });

  it('goes on to the next entry when one entry fails to journal, and reports that entry', async () => {
    const a = tab('a');
    await stage(a, 'one', { entryId: 'one', fileId: 'file_00000000entry01' });
    await stage(a, 'two', { entryId: 'two', fileId: 'file_00000000entry02' });
    const brokenJournal = journalOf('one').path;
    storage.storage.fault = (path, step) => {
      if (path === brokenJournal && step === 'write') throw new Error('disk error');
    };
    const onSyncError = vi.fn();
    const sync = onlineSync(a, { onSyncError, retryDelayMs: 60_000 });
    expect(await sync.syncAll()).toMatchObject({ succeeded: ['two'], failed: ['one'] });
    expect(onSyncError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk error' }), 'one');
    sync.dispose();
    storage.storage.fault = undefined;
  });

  it('delivers no callback once the sync is disposed inside an earlier one', async () => {
    const a = tab('a');
    await stage(a, 'one', { entryId: 'one', fileId: 'file_00000000entry01' });
    await stage(a, 'two', { entryId: 'two', fileId: 'file_00000000entry02' });
    const progress = vi.fn();
    const complete = vi.fn();
    const sync: OfflineSync = onlineSync(a, {
      onSyncProgress: (p) => {
        progress(p);
        sync.dispose();
      },
      onSyncComplete: complete,
    });
    await sync.syncAll();
    expect(progress).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('principal fenced after every read', () => {
  /** A principal check that answers for Alice `allowed` more times, then for Bob. */
  function switching() {
    const state = { allowed: Infinity };
    return { state, currentPrincipal: () => (state.allowed-- > 0 ? ALICE.principal : BOB.principal) };
  }

  it('returns no snapshot of a held entry when the principal changes while its journal is read', async () => {
    const principal = switching();
    const a = tab('a', { currentPrincipal: principal.currentPrincipal });
    await stage(a, 'v1', { hold: true, metadata: { title: 'alice-private' } });
    // The check on entering the transaction passes; the one after the read does not.
    principal.state.allowed = 1;
    expect(await a.process(FILE_ID)).toEqual({ status: 'stopped', reason: 'principal-mismatch' });
  });

  it('stops a processAll batch at a principal mismatch and returns none of its results', async () => {
    let signedIn: OfflineQueuePrincipal = ALICE.principal;
    const a = tab('a', {
      currentPrincipal: () => signedIn,
      uploader: {
        async upload(input) {
          // The account switches once the first entry is uploaded.
          signedIn = BOB.principal;
          return { fileId: input.fileId, versionId: 'ver_1' };
        },
      },
    });
    await stage(a, 'first', { entryId: 'e1', fileId: 'file_00000000entry0a' });
    await stage(a, 'second', { entryId: 'e2', fileId: 'file_00000000entry0b', hold: true, metadata: { title: 'alice-private' } });
    await expect(a.processAll()).rejects.toMatchObject({ code: 'FILEFN_QUEUE_PRINCIPAL_MISMATCH' });
  });

  it('rejects a hook\'s principal check once its step is stopped', async () => {
    const checked = deferred<unknown>();
    const reached = deferred<void>();
    const a = tab('a', {
      hooks: {
        verify: async (context) => {
          reached.resolve();
          await new Promise((resolve) => context.signal.addEventListener('abort', resolve));
          checked.resolve(await context.assertPrincipal().then(() => 'passed', (error: Error) => error.name));
          return { verified: true };
        },
      },
    });
    await stage(a);
    void a.process(FILE_ID).catch(() => {});
    await reached.promise;
    a.dispose();
    expect(await checked.promise).toBe('AbortError');
  });
});

describe('cross-tab wakeups', () => {
  it('drives work another tab staged and left when it closed, with no online event', async () => {
    const uploader = recordingUploader();
    const b = tab('b', { uploader });
    const sync = onlineSync(b, { idlePollMs: 0 });
    sync.start();
    await vi.waitFor(() => expect(locks.requests.length).toBeGreaterThan(0));
    const a = tab('a');
    await stage(a, 'from-a');
    locks.closeTab('a');
    a.dispose();
    await vi.waitFor(async () => expect((await b.get(FILE_ID))?.state).toBe('published'));
    expect(uploader.calls.map((call) => call.body)).toEqual(['from-a']);
    sync.dispose();
  });

  it('finds such work on an idle poll when no channel is available', async () => {
    const b = tab('b', { channel: () => undefined });
    const sync = onlineSync(b, { idlePollMs: 10 });
    sync.start();
    const a = tab('a', { channel: () => undefined });
    await stage(a);
    a.dispose();
    await vi.waitFor(async () => expect((await b.get(FILE_ID))?.state).toBe('published'));
    sync.dispose();
  });

  it('a sync of a disposed queue disposes itself instead of reporting and retrying', async () => {
    const onSyncError = vi.fn();
    const a = tab('a');
    const sync = onlineSync(a, { onSyncError, retryDelayMs: 1 });
    a.dispose();
    await sync.syncAll();
    expect(sync.isDisposed).toBe(true);
    expect(onSyncError).not.toHaveBeenCalled();
  });
});

describe('verification provenance', () => {
  it('runs a verifier that became required on a generation verified without one, before publishing it', async () => {
    const run = vi.fn(async () => ({}));
    const verify = vi.fn(async () => ({ verified: true as const }));
    // Staged where only publication was required; uploaded where no hook exists.
    await stage(tab('publisher-only', { hooks: { publish: { run: async () => ({}) } } }));
    expect(await tab('bare').process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'hook-unavailable', entry: { phase: 'verified' } });
    const full = tab('full', { hooks: { verify, publish: { run } } });
    expect(await full.process(FILE_ID)).toMatchObject({ status: 'published' });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]);
  });
});

describe('hook and upload outcomes outside their contract', () => {
  it.each([
    ['a version with a path separator', { versionId: '/' }],
    ['a file ID outside the server grammar', { fileId: '../file' }],
  ])('keeps an upload result naming %s ambiguous under the same key', async (_label, result) => {
    const a = tab('a', { uploader: { upload: async (input) => ({ fileId: input.fileId, versionId: 'ver_1', ...result }) } });
    await stage(a);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'uploading' } });
  });

  it.each([
    ['false', false],
    ['null', null],
    ['a result that is not JSON', { result: { count: BigInt(1) } }],
  ])('never confirms a publication that resolved with %s', async (_label, value) => {
    const a = tab('a', { hooks: { publish: { run: async () => value as never } } });
    await stage(a);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'publishing' } });
  });
});

describe('waiters across a cancel', () => {
  it('resolves a waiter of a generation published and replaced since, when the entry is cancelled', async () => {
    const a = tab('a', { observeIntervalMs: 0 });
    const b = tab('b');
    const { entry } = await stage(b);
    const settled = a.whenSettled(FILE_ID, entry.generation);
    // Read while provisional: the waiter stays.
    await a.get(FILE_ID);
    expect(await b.process(FILE_ID)).toMatchObject({ status: 'published' });
    await stage(b, 'v2', { hold: true });
    expect(await a.cancel(FILE_ID)).toBe(true);
    await expect(settled).resolves.toMatchObject({ generation: entry.generation, state: 'published' });
  });
});

describe('legacy migration admission', () => {
  async function writeLegacy(id: string, key: string, fileId = FILE_ID) {
    const legacy = await (await storage.root.getDirectoryHandle('filefn-pending-uploads', { create: true })).getDirectoryHandle(id, { create: true });
    await writeCommitted(legacy, 'data.bin', 'old bytes');
    await writeCommitted(legacy, 'metadata.json', JSON.stringify({ uploadSessionId: id, fileId, policy: 'p', fileName: 'old.txt', size: 9, mimeType: 'text/plain', createdAt: '2026-11-01T00:00:00.000Z', retryCount: 0, metadataVersion: 2, idempotencyKey: key }));
  }

  it('keeps the legacy key for a retry after a staging that failed', async () => {
    await writeLegacy('offline_1731000000000_legacy011', 'test-legacy-key-0011');
    const uploader = recordingUploader();
    const a = tab('a', { uploader });
    storage.storage.fault = (path, step) => {
      if (path.endsWith('.bin') && path.includes('filefn-offline-queue') && step === 'close') throw quotaExceeded();
    };
    expect(await a.migrateLegacyUpload('offline_1731000000000_legacy011', { ownershipVerified: true })).toMatchObject({ status: 'refused', limit: 'quota' });
    storage.storage.fault = undefined;
    expect(await a.migrateLegacyUpload('offline_1731000000000_legacy011', { ownershipVerified: true })).toMatchObject({ status: 'staged' });
    await a.processAll();
    expect(uploader.calls.map((call) => call.idempotencyKey)).toEqual(['test-legacy-key-0011']);
  });

  // Out of storage while preparing the claims directory, writing the claim or
  // opening the legacy store: the typed capacity refusal, nothing removed, and
  // a retry completes the migration.
  it.each([
    { at: 'claims directory', fault: (path: string, step: string) => step === 'mkdir' && path.includes('legacy-claims') },
    { at: 'claim write', fault: (path: string, step: string) => step === 'close' && path.includes('legacy-claims') },
    { at: 'legacy store root', fault: (path: string, step: string) => step === 'mkdir' && path === '/filefn-pending-uploads' },
  ])('returns the typed quota refusal when storage runs out at the $at, keeping the legacy upload', async ({ fault }) => {
    const id = 'offline_1731000000000_legacy013';
    if (!fault('/filefn-pending-uploads', 'mkdir')) await writeLegacy(id, 'test-legacy-key-0013');
    const uploader = recordingUploader();
    const a = tab('a', { uploader });
    storage.storage.fault = (path, step) => {
      if (fault(path, step)) throw quotaExceeded();
    };
    const refused = await a.migrateLegacyUpload(id, { ownershipVerified: true });
    expect(refused).toEqual({
      status: 'refused',
      reason: 'capacity',
      limit: 'quota',
      usage: expect.objectContaining({ entries: 0 }),
      limits: expect.any(Object),
    });
    storage.storage.fault = undefined;
    if (fault('/filefn-pending-uploads', 'mkdir')) await writeLegacy(id, 'test-legacy-key-0013');
    expect(await a.listLegacyUploads()).toEqual([expect.objectContaining({ uploadSessionId: id })]);
    expect(await a.migrateLegacyUpload(id, { ownershipVerified: true })).toMatchObject({ status: 'staged' });
    await a.processAll();
    expect(uploader.calls.map((call) => call.idempotencyKey)).toEqual(['test-legacy-key-0013']);
  });

  it('never returns a later generation as the entry a legacy upload became', async () => {
    await writeLegacy('offline_1731000000000_legacy012', 'test-legacy-key-0012');
    const a = tab('a');
    expect(await a.migrateLegacyUpload('offline_1731000000000_legacy012', { ownershipVerified: true })).toMatchObject({ status: 'staged' });
    await stage(a, 'new bytes', { expectedGeneration: 1 });
    // Its cleanup was interrupted: the legacy record is back.
    await writeLegacy('offline_1731000000000_legacy012', 'test-legacy-key-0012');
    expect(await a.migrateLegacyUpload('offline_1731000000000_legacy012', { ownershipVerified: true })).toEqual({
      status: 'refused',
      reason: 'already-migrated',
    });
  });

  it('admits a legacy upload into one partition only, even across services', async () => {
    await writeLegacy('offline_1731000000000_legacy013', 'test-legacy-key-0013');
    const notes = tab('notes');
    const other: OfflineQueuePartition = { serviceId: 'svc-other', principal: ALICE.principal };
    const otherService = tab('other', { partition: other });
    const results = await Promise.all([
      notes.migrateLegacyUpload('offline_1731000000000_legacy013', { ownershipVerified: true }),
      otherService.migrateLegacyUpload('offline_1731000000000_legacy013', { ownershipVerified: true }),
    ]);
    expect(results.filter((result) => result.status === 'staged')).toHaveLength(1);
    expect((await notes.list()).length + (await otherService.list()).length).toBe(1);
  });
});

describe('a verifier required after publication started', () => {
  it('reruns no publication until that verifier ran, and keeps it required across a reopened publication', async () => {
    const first = tab('first', { hooks: { publish: { run: async () => { throw new Error('network lost'); } } } });
    await stage(first);
    expect(await first.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'publishing' } });
    const verify = vi.fn(async () => ({ verified: false as const, reason: 'malware' }));
    const run = vi.fn(async () => ({}));
    const second = tab('second', { hooks: { verify, publish: { run, idempotent: true } } });
    // Another idempotent run would publish an unverified generation: the earlier attempt is reconciled first.
    expect(await second.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'needs-reconcile' });
    expect(run).not.toHaveBeenCalled();
    const attemptId = (await second.get(FILE_ID))!.publicationAttemptId!;
    await second.reconcile(FILE_ID, 1, { published: false, attemptId });
    // Reopened at verified: an instance without the verifier cannot publish it.
    expect(await tab('bare', { hooks: { publish: { run } } }).process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'hook-unavailable' });
    expect(await second.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'rejected' });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('journals the requirements of an instance that only reconciles, so a later publisher-only instance cannot publish unverified', async () => {
    const first = tab('first', { hooks: { publish: { run: async () => { throw new Error('network lost'); } } } });
    await stage(first);
    expect(await first.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'publishing' } });
    // B holds a verifier but never processes: it only settles the attempt by hand.
    const verify = vi.fn(async () => ({ verified: true as const }));
    const b = tab('b', { hooks: { verify, publish: { run: async () => ({}) } } });
    const attemptId = (await b.get(FILE_ID))!.publicationAttemptId!;
    expect(await b.reconcile(FILE_ID, 1, { published: false, attemptId })).toMatchObject({ phase: 'verified' });
    const run = vi.fn(async () => ({}));
    expect(await tab('publisher', { hooks: { publish: { run } } }).process(FILE_ID)).toMatchObject({
      status: 'provisional',
      reason: 'hook-unavailable',
    });
    expect(run).not.toHaveBeenCalled();
    expect(await b.process(FILE_ID)).toMatchObject({ status: 'published' });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('runs that verifier after a reconciliation hook reopens the publication, before publishing again', async () => {
    const first = tab('first', { hooks: { publish: { run: async () => { throw new Error('network lost'); } } } });
    await stage(first);
    await first.process(FILE_ID);
    const reconcile = vi.fn(async () => ({ published: false as const }));
    const verify = vi.fn(async () => ({ verified: true as const }));
    const run = vi.fn(async () => ({}));
    expect(await tab('second', { hooks: { verify, publish: { run, reconcile } } }).process(FILE_ID)).toMatchObject({ status: 'published' });
    expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(verify.mock.invocationCallOrder[0]);
    expect(verify.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]);
  });
});

describe('upload failures that cannot settle the FileFn session', () => {
  it('keeps a 4xx without a FileFn code (a signed storage URL) ambiguous under the same key', async () => {
    const keys: string[] = [];
    let fail = true;
    const a = tab('a', {
      uploader: {
        async upload(input) {
          keys.push(input.idempotencyKey);
          if (fail) throw Object.assign(new Error('Upload failed: HTTP 404'), { status: 404 });
          return { fileId: input.fileId, versionId: 'ver_1' };
        },
      },
    });
    await stage(a);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'uploading' } });
    fail = false;
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'published' });
    expect(new Set(keys).size).toBe(1);
  });

  it('still fails a generation that FileFn itself refused with a coded 4xx', async () => {
    const a = tab('a', {
      uploader: { upload: async () => { throw Object.assign(new Error('Policy not found'), { status: 404, code: 'FILEFN_POLICY_NOT_FOUND' }); } },
    });
    await stage(a);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'failed', entry: { phase: 'failed' } });
  });
});

describe('publication results a JSON round trip would change', () => {
  const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
  it.each([
    ['NaN', { result: Number.NaN }],
    ['Infinity in an object', { result: { count: Number.POSITIVE_INFINITY } }],
    ['a function member', { result: { id: 'r1', toString: () => 'x' } }],
    ['an undefined member', { result: { id: 'r1', extra: undefined } }],
    ['a symbol key', { result: { id: 'r1', [Symbol('k')]: 1 } }],
    ['a Date', { result: new Date(0) }],
    ['a sparse array', { result: sparse }],
    ['a toJSON method', { result: { toJSON: () => 'other' } }],
  ])('never confirms a publication whose result has %s', async (_label, value) => {
    const a = tab('a', { hooks: { publish: { run: async () => value as never } } });
    await stage(a);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'publishing' } });
  });

  class Outcome {
    result = { id: 'r1' };
    published = true;
  }
  it.each([
    ['a Date envelope', new Date(0)],
    ['a Map envelope', new Map([['result', { id: 'r1' }]])],
    ['a class instance envelope', new Outcome()],
    ['an accessor result', Object.defineProperty({}, 'result', { enumerable: true, get: () => ({ id: 'r1' }) })],
    ['-0 in the result', { result: { n: -0 } }],
  ])('never confirms a publication resolved with %s', async (_label, value) => {
    const a = tab('a', { hooks: { publish: { run: async () => value as never } } });
    await stage(a);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'publishing' } });
  });

  it('refuses a reconciliation check or manual outcome that is not a plain object', async () => {
    const reconcile = vi.fn(async () => new Outcome() as never);
    const a = tab('a', { hooks: { publish: { run: async () => { throw new Error('lost'); }, reconcile } } });
    await stage(a);
    await a.process(FILE_ID);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'publishing' } });
    expect(reconcile).toHaveBeenCalled();
    const attemptId = (await a.get(FILE_ID))!.publicationAttemptId!;
    const manual = Object.assign(new Outcome(), { attemptId });
    await expect(a.reconcile(FILE_ID, 1, manual as never)).rejects.toMatchObject({ code: 'FILEFN_QUEUE_INVALID_INPUT' });
    await expect(a.reconcile(FILE_ID, 1, { published: true, attemptId, result: { n: -0 } })).rejects.toMatchObject({
      code: 'FILEFN_QUEUE_INVALID_INPUT',
    });
    expect((await a.get(FILE_ID))!.phase).toBe('publishing');
  });

  it('confirms exact JSON unchanged, and refuses a lossy manual or hook reconciliation', async () => {
    const result = { id: 'r1', tags: ['a', 'b'], nested: { n: 1.5, ok: true, none: null } };
    const a = tab('a', { hooks: { publish: { run: async () => ({ result }) } } });
    await stage(a);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'published', entry: { publication: { result } } });

    const b = tab('b', { hooks: { publish: { run: async () => { throw new Error('lost'); }, reconcile: async () => ({ published: true, result: { count: Number.NaN } }) } } });
    await stage(b, 'v2', { entryId: 'e2', fileId: 'file_00000000entry02' });
    expect(await b.process('e2')).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'publishing' } });
    expect(await b.process('e2')).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'publishing' } });
    const attemptId = (await b.get('e2'))!.publicationAttemptId!;
    await expect(b.reconcile('e2', 1, { published: true, attemptId, result: { count: Number.POSITIVE_INFINITY } })).rejects.toMatchObject({
      code: 'FILEFN_QUEUE_INVALID_INPUT',
    });
    expect((await b.get('e2'))!.phase).toBe('publishing');
  });
});

describe('stopping drivers and helpers with their queue', () => {
  it('delivers nothing more and schedules nothing once the queue is disposed inside a sync callback', async () => {
    const a = tab('a');
    await stage(a, 'one', { entryId: 'one', fileId: 'file_00000000entry01' });
    await stage(a, 'two', { entryId: 'two', fileId: 'file_00000000entry02' });
    const progress = vi.fn();
    const complete = vi.fn();
    const sync = onlineSync(a, {
      onSyncProgress: (p) => {
        progress(p);
        a.dispose();
      },
      onSyncComplete: complete,
    });
    await sync.syncAll();
    expect(progress).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(sync.isDisposed).toBe(true);
  });

  it('rejects a principal check a hook kept once its step ended, and after disposal', async () => {
    let kept: (() => Promise<void>) | undefined;
    const a = tab('a', {
      hooks: {
        verify: async (context) => {
          kept = context.assertPrincipal;
          await context.assertPrincipal();
          return { verified: true };
        },
      },
    });
    await stage(a);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'published' });
    await expect(kept!()).rejects.toMatchObject({ name: 'AbortError' });
    a.dispose();
    await expect(kept!()).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('principal binding at the last storage step', () => {
  it('returns no staged snapshot when the principal changes as the journal commits, and keeps the staging for its owner', async () => {
    let signedIn: OfflineQueuePrincipal = ALICE.principal;
    const a = tab('a', { currentPrincipal: () => signedIn });
    storage.storage.fault = (path, step) => {
      if (step === 'close' && path.endsWith('/journal.json')) signedIn = BOB.principal;
    };
    const result = await a.stage({ policy: 'p', file: new Blob(['v1']), fileName: 'a.txt', fileId: FILE_ID, metadata: { title: 'alice-private' } });
    storage.storage.fault = undefined;
    expect(result).toEqual({ status: 'refused', reason: 'principal-mismatch' });
    signedIn = ALICE.principal;
    expect((await a.list()).map((entry) => entry.metadata)).toEqual([{ title: 'alice-private' }]);
  });

  it('settles no waiter from a cancellation when the principal changes during the removal', async () => {
    let signedIn: OfflineQueuePrincipal = ALICE.principal;
    const a = tab('a', { currentPrincipal: () => signedIn, observeIntervalMs: 0 });
    await stage(a);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'published' });
    await stage(a, 'v2');
    const waiter = vi.fn();
    void a.whenSettled(FILE_ID, 1).then(waiter, waiter);
    await vi.waitFor(() => expect(waiter).toHaveBeenCalledTimes(1));
    waiter.mockClear();
    void a.whenSettled(FILE_ID, 2).then(waiter, waiter);
    const remove = MemoryDirectory.prototype.removeEntry;
    const spy = vi.spyOn(MemoryDirectory.prototype, 'removeEntry').mockImplementation(async function (this: MemoryDirectory, name, options) {
      await remove.call(this, name, options);
      if (name.startsWith('e_')) signedIn = BOB.principal;
    });
    try {
      await expect(a.cancel(FILE_ID)).rejects.toMatchObject({ code: 'FILEFN_QUEUE_PRINCIPAL_MISMATCH' });
    } finally {
      spy.mockRestore();
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(waiter).not.toHaveBeenCalled();
  });

  it('keeps the partition used for binding, hooks and credentials immutable', async () => {
    let seen: OfflineQueuePartition | undefined;
    const a = tab('a', { hooks: { verify: async (context) => ((seen = context.partition), { verified: true }) } });
    expect(() => {
      (a.partition.principal as { principalId: string }).principalId = 'user-bob';
    }).toThrow(TypeError);
    await stage(a);
    await a.process(FILE_ID);
    expect(seen).toBe(a.partition);
    expect(Object.isFrozen(seen) && Object.isFrozen(seen!.principal)).toBe(true);
  });
});

describe('a hold taken while an upload runs', () => {
  it('admits no further upload request once another tab holds the generation, and resumes under the same key on release', async () => {
    const between = deferred<void>();
    const resume = deferred<void>();
    const requests: string[] = [];
    let blocking = true;
    const a = tab('a', {
      uploader: {
        async upload(input) {
          await input.assertPrincipal();
          requests.push(`init ${input.idempotencyKey}`);
          if (blocking) {
            between.resolve();
            await resume.promise;
          }
          await input.assertPrincipal();
          requests.push(`complete ${input.idempotencyKey}`);
          return { fileId: input.fileId, versionId: 'ver_1' };
        },
      },
    });
    const staged = await stage(a);
    const running = a.process(FILE_ID);
    await between.promise;
    const b = tab('b');
    const holdId = heldId(await b.hold(FILE_ID, staged.entry.generation));
    resume.resolve();
    expect(await running).toMatchObject({ status: 'provisional', reason: 'held', entry: { phase: 'uploading', attempts: 0 } });
    expect(requests).toHaveLength(1);
    blocking = false;
    expect(await b.release(FILE_ID, staged.entry.generation, holdId)).toBe(true);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'published' });
    const key = requests[0].split(' ')[1];
    expect(requests).toEqual([`init ${key}`, `init ${key}`, `complete ${key}`]);
  });
});

describe('an account switch inside a callback', () => {
  it('ends the event fan-out and leaves waiters for their own principal', async () => {
    let signedIn: OfflineQueuePrincipal = ALICE.principal;
    const a = tab('a', { currentPrincipal: () => signedIn, observeIntervalMs: 0 });
    const { entry } = await stage(a);
    const settled = a.whenSettled(FILE_ID, entry.generation);
    let outcome: unknown = 'pending';
    settled.then((value) => { outcome = value; }, (error) => { outcome = error; });
    const first = vi.fn(() => {
      signedIn = BOB.principal;
    });
    const second = vi.fn();
    a.subscribe(first);
    a.subscribe(second);

    await a.process(FILE_ID).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first).toHaveBeenCalledTimes(1);
    // The second listener and the waiter never see Alice's entry while Bob is signed in.
    expect(second).not.toHaveBeenCalled();
    expect(outcome).toBe('pending');

    // Alice is back: a read settles her waiter from the durable journal.
    signedIn = ALICE.principal;
    await a.get(FILE_ID);
    // Waiters settle only after the read returned its result.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcome).toMatchObject({ entryId: FILE_ID, state: 'published' });
    a.dispose();
  });

  it('delivers no further sync callback or summary of the old principal', async () => {
    let signedIn: OfflineQueuePrincipal = ALICE.principal;
    const a = tab('a', {
      currentPrincipal: () => signedIn,
      uploader: { upload: async () => { throw new TypeError('fetch failed'); } },
    });
    await a.stage({ policy: 'p', file: new Blob(['one']), entryId: 'alice-one', fileId: 'file_00000000entry01' });
    await a.stage({ policy: 'p', file: new Blob(['two']), entryId: 'alice-two', fileId: 'file_00000000entry02' });
    const onSyncError = vi.fn(() => {
      signedIn = BOB.principal;
    });
    const onSyncProgress = vi.fn();
    const onSyncComplete = vi.fn();
    const sync = onlineSync(a, { onSyncError, onSyncProgress, onSyncComplete, retryDelayMs: 60_000, idlePollMs: 0 });

    const summary = await sync.syncAll();
    expect(onSyncError).toHaveBeenCalledTimes(1);
    expect(onSyncProgress).not.toHaveBeenCalled();
    expect(onSyncComplete).not.toHaveBeenCalled();
    expect(summary).toEqual({ succeeded: [], failed: [], totalProcessed: 0 });
    sync.dispose();
    a.dispose();
  });
});

describe('results returned after a callback switched the account', () => {
  it.each([
    ['a published', { publish: { run: async () => ({}) } }, 'published'],
    ['a provisional (rejected)', { verify: async () => ({ verified: false as const, reason: 'bad' }) }, 'rejected'],
  ] as const)('process returns no entry when %s listener switches', async (_label, hooks, phase) => {
    let signedIn: OfflineQueuePrincipal = ALICE.principal;
    const a = tab('a', { currentPrincipal: () => signedIn, hooks: hooks as OfflineQueueHooks });
    await stage(a);
    a.subscribe(() => {
      signedIn = BOB.principal;
    });
    expect(await a.process(FILE_ID)).toEqual({ status: 'stopped', reason: 'principal-mismatch' });
    // The committed outcome stays with its owner.
    signedIn = ALICE.principal;
    expect(await a.get(FILE_ID)).toMatchObject({ phase });
    a.dispose();
  });

  it('reconcile throws instead of returning the entry when its listener switches', async () => {
    let signedIn: OfflineQueuePrincipal = ALICE.principal;
    const a = tab('a', { currentPrincipal: () => signedIn, hooks: { publish: { run: async () => { throw new Error('lost'); } } } });
    await stage(a);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'provisional', entry: { phase: 'publishing' } });
    const attemptId = (await a.get(FILE_ID))!.publicationAttemptId!;
    a.subscribe(() => {
      signedIn = BOB.principal;
    });
    await expect(a.reconcile(FILE_ID, 1, { published: true, attemptId })).rejects.toMatchObject({ code: 'FILEFN_QUEUE_PRINCIPAL_MISMATCH' });
    signedIn = ALICE.principal;
    expect(await a.get(FILE_ID)).toMatchObject({ state: 'published' });
    a.dispose();
  });

  it('stage refuses instead of returning the entry when a work listener switches', async () => {
    let signedIn: OfflineQueuePrincipal = ALICE.principal;
    const a = tab('a', { currentPrincipal: () => signedIn });
    a.onWork(() => {
      signedIn = BOB.principal;
    });
    expect(await a.stage({ policy: 'p', file: new Blob(['v1']), fileId: FILE_ID })).toEqual({ status: 'refused', reason: 'principal-mismatch' });
    signedIn = ALICE.principal;
    expect(await a.list()).toMatchObject([{ entryId: FILE_ID, state: 'provisional' }]);
    a.dispose();
  });
});

describe('preview URLs after an account switch', () => {
  it('revokes every issued preview once any queue call sees another principal', async () => {
    let signedIn: OfflineQueuePrincipal = ALICE.principal;
    const revoked: string[] = [];
    let created = 0;
    vi.stubGlobal('URL', { createObjectURL: () => `blob:preview-${++created}`, revokeObjectURL: (url: string) => revoked.push(url) });
    const a = tab('a', { currentPrincipal: () => signedIn });
    await stage(a);
    expect(await a.getPendingLocalDescriptor(FILE_ID)).toMatchObject({ source: { url: 'blob:preview-1' } });
    // Switched in another tab: this tab only finds out on its next call.
    signedIn = BOB.principal;
    await expect(a.list()).rejects.toMatchObject({ code: 'FILEFN_QUEUE_PRINCIPAL_MISMATCH' });
    expect(revoked).toEqual(['blob:preview-1']);
    a.dispose();
  });
});

describe('publication envelopes outside the documented keys', () => {
  it.each([
    ['published: false', { published: false }],
    ['ok: false with a null result', { ok: false, result: null }],
    ['an extra key', { result: { id: 'r1' }, extra: 1 }],
  ])('never confirms a run resolved with %s, and cleans nothing up', async (_label, value) => {
    const a = tab('a', { hooks: { publish: { run: async () => value as never } } });
    await stage(a);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'publishing' } });
    expect(dataFiles()).toHaveLength(1);
  });

  it('still confirms a run resolved with published: true and a result', async () => {
    const a = tab('a', { hooks: { publish: { run: async () => ({ published: true, result: { id: 'r1' } }) as never } } });
    await stage(a);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'published', entry: { publication: { result: { id: 'r1' } } } });
  });

  it('refuses a reconcile check or manual outcome with unknown keys', async () => {
    const reconcile = vi.fn(async () => ({ published: false, result: { id: 'r1' } }) as never);
    const a = tab('a', { hooks: { publish: { run: async () => { throw new Error('lost'); }, reconcile } } });
    await stage(a);
    await a.process(FILE_ID);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'publishing' } });
    expect(reconcile).toHaveBeenCalled();
    const attemptId = (await a.get(FILE_ID))!.publicationAttemptId!;
    await expect(a.reconcile(FILE_ID, 1, { published: true, attemptId, ok: false } as never)).rejects.toMatchObject({ code: 'FILEFN_QUEUE_INVALID_INPUT' });
    await expect(a.reconcile(FILE_ID, 1, { published: false, attemptId, result: 1 } as never)).rejects.toMatchObject({ code: 'FILEFN_QUEUE_INVALID_INPUT' });
    expect((await a.get(FILE_ID))!.phase).toBe('publishing');
    expect(dataFiles()).toHaveLength(1);
  });
});

describe('physical quota during staging', () => {
  it('reclaims orphaned data and admits the staging once more', async () => {
    const a = tab('a');
    await stage(a, 'first', { entryId: 'first' });
    // A staging that crashed before its journal committed left its data.
    const orphan = await (await partitionDir()).getDirectoryHandle('orphan', { create: true });
    await writeCommitted(orphan, 'g1.bin', 'orphaned bytes');
    let thrown = false;
    storage.storage.fault = (path, step) => {
      if (!thrown && path.endsWith('.bin') && step === 'write') {
        thrown = true;
        throw quotaExceeded();
      }
    };
    expect(await a.stage({ policy: 'p', file: new Blob(['second']), entryId: 'second', fileId: 'file_00000000entry02' })).toMatchObject({ status: 'staged' });
    storage.storage.fault = undefined;
    expect(thrown).toBe(true);
    expect((await partitionDir()).entries.has('orphan')).toBe(false);
    expect((await a.list()).map((e) => e.entryId).sort()).toEqual(['first', 'second']);
  });

  it('reclaims data a published generation left behind, but never pending data', async () => {
    const a = tab('a');
    await stage(a, 'pending', { entryId: 'pending', fileId: 'file_00000000entry02' });
    await stage(a, 'done', { entryId: 'done' });
    expect(await a.process('done')).toMatchObject({ status: 'published' });
    // An interrupted cleanup left data beside the published journal.
    const doneDir = [...(await partitionDir()).entries.values()].find(
      (entry) => entry instanceof MemoryDirectory && entry.entries.has('journal.json') && journalOf('done').path.startsWith(`${entry.path}/`),
    ) as MemoryDirectory;
    await writeCommitted(doneDir, 'g1.bin', 'published bytes');
    expect(dataFiles()).toHaveLength(2);
    let thrown = false;
    storage.storage.fault = (path, step) => {
      if (!thrown && path.endsWith('.bin') && step === 'write') {
        thrown = true;
        throw quotaExceeded();
      }
    };
    expect(await a.stage({ policy: 'p', file: new Blob(['next']), entryId: 'next', fileId: 'file_00000000entry03' })).toMatchObject({ status: 'staged' });
    storage.storage.fault = undefined;
    expect(await a.get('pending')).toMatchObject({ state: 'provisional', phase: 'staged' });
    expect(dataFiles()).toHaveLength(2);
  });
});

describe('a sync and its queue’s disposal', () => {
  function trackingChecker() {
    const registered = new Set<() => void>();
    return {
      registered,
      checker: {
        isOnline: () => true,
        onOnline: (callback: () => void) => {
          registered.add(callback);
          return () => registered.delete(callback);
        },
        onOffline: () => () => {},
      },
    };
  }

  it('starting against a disposed queue registers nothing', () => {
    const a = tab('a');
    a.dispose();
    const sync = new OfflineSync({ queue: a });
    const { registered, checker } = trackingChecker();
    sync.setConnectivityChecker(checker);
    expect(() => sync.start()).toThrow();
    expect(registered.size).toBe(0);
    expect(sync.isDisposed).toBe(true);
  });

  it('disposing the queue under an idle started sync drops its listener and timers at once', async () => {
    vi.useFakeTimers();
    try {
      const a = tab('a');
      const sync = new OfflineSync({ queue: a, idlePollMs: 1000 });
      const { registered, checker } = trackingChecker();
      sync.setConnectivityChecker(checker);
      sync.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(registered.size).toBe(1);
      a.dispose();
      expect(sync.isDisposed).toBe(true);
      expect(registered.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('round 9: completed reads, previews and envelopes', () => {
  it.each(['list', 'get'] as const)('%s returns its result before a waiter it settles can switch the account', async (method) => {
    let signedIn: OfflineQueuePrincipal = ALICE.principal;
    const a = tab('a', { currentPrincipal: () => signedIn, observeIntervalMs: 0, channel: () => undefined });
    const { entry } = await stage(a);
    const order: string[] = [];
    a.whenSettled(FILE_ID, entry.generation).then(() => {
      order.push('waiter');
      signedIn = BOB.principal;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await tab('b').process(FILE_ID)).toMatchObject({ status: 'published' });

    const result = method === 'list' ? await a.list() : await a.get(FILE_ID);
    order.push(method);
    expect(result).toMatchObject(method === 'list' ? [{ entryId: FILE_ID, state: 'published' }] : { entryId: FILE_ID, state: 'published' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The read was fenced and returned while Alice was signed in; her waiter ran after it.
    expect(order).toEqual([method, 'waiter']);
    a.dispose();
  });

  it('returns no migrated entry when the principal changes during the legacy cleanup, and keeps it for its owner', async () => {
    let signedIn: OfflineQueuePrincipal = ALICE.principal;
    const pendingRoot = await storage.root.getDirectoryHandle('filefn-pending-uploads', { create: true });
    const legacy = await pendingRoot.getDirectoryHandle('offline_1731000000000_legacy009', { create: true });
    await writeCommitted(legacy, 'data.bin', 'old bytes');
    await writeCommitted(legacy, 'metadata.json', JSON.stringify({ uploadSessionId: 'offline_1731000000000_legacy009', fileId: FILE_ID, policy: 'p', fileName: 'old.txt', size: 9, mimeType: 'text/plain', createdAt: '2026-11-01T00:00:00.000Z', retryCount: 0, metadataVersion: 2 }));
    const remove = pendingRoot.removeEntry.bind(pendingRoot);
    pendingRoot.removeEntry = async (name, options) => {
      signedIn = BOB.principal;
      return remove(name, options);
    };
    const a = tab('a', { currentPrincipal: () => signedIn });
    expect(await a.migrateLegacyUpload('offline_1731000000000_legacy009', { ownershipVerified: true })).toEqual({
      status: 'refused',
      reason: 'principal-mismatch',
    });
    signedIn = ALICE.principal;
    expect(await a.list()).toMatchObject([{ entryId: FILE_ID, fileName: 'old.txt', state: 'provisional' }]);
    a.dispose();
  });

  it('previews the highest generation of a file, not the entry touched last', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-26T10:00:00.000Z'));
      vi.stubGlobal('URL', { createObjectURL: (blob: Blob) => `blob:size-${blob.size}`, revokeObjectURL: () => {} });
      const a = tab('a');
      const older = await stage(a, 'old', { entryId: 'older' });
      await stage(a, 'newer!', { entryId: 'newer' });
      vi.setSystemTime(new Date('2026-11-26T10:05:00.000Z'));
      // A hold only touches the older entry's journal.
      heldId(await a.hold('older', older.entry.generation));
      expect(await a.getPendingLocalDescriptor(FILE_ID)).toMatchObject({ source: { url: 'blob:size-6' } });
      a.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates no preview URL when the principal changes while the read waits on the coordinator', async () => {
    let signedIn: OfflineQueuePrincipal = ALICE.principal;
    let created = 0;
    vi.stubGlobal('URL', { createObjectURL: () => `blob:preview-${++created}`, revokeObjectURL: () => {} });
    const inner = locks.forTab('a');
    let gate: Promise<void> | undefined;
    const reached = deferred<void>();
    const coordinator: typeof inner = {
      request: (async (name: string, options: unknown, callback: unknown) => {
        const result = await (inner.request as (...args: unknown[]) => Promise<unknown>)(name, options, callback);
        if (gate) {
          const wait = gate;
          gate = undefined;
          reached.resolve();
          await wait;
        }
        return result;
      }) as typeof inner.request,
    };
    const a = tab('a', { coordinator, currentPrincipal: () => signedIn });
    await stage(a);
    const release = deferred<void>();
    gate = release.promise;
    const pending = a.getPendingLocalDescriptor(FILE_ID);
    await reached.promise;
    signedIn = BOB.principal;
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'FILEFN_QUEUE_PRINCIPAL_MISMATCH' });
    expect(created).toBe(0);
    a.dispose();
  });

  it.each([
    ['an extra key', { verified: true, ok: false }],
    ['a class instance', Object.assign(new (class Verdict {})(), { verified: true })],
    ['a non-string reason', { verified: false, reason: 42 }],
  ])('keeps a generation provisional when the verifier resolves with %s', async (_label, value) => {
    const run = vi.fn(async () => ({}));
    const a = tab('a', { hooks: { verify: async () => value as never, publish: { run } } });
    await stage(a);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'provisional', entry: { phase: 'verifying', state: 'provisional' } });
    expect((await a.get(FILE_ID))?.verification).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    a.dispose();
  });

  it('frees the unjournaled remains of the entry being restaged instead of refusing it on every retry', async () => {
    const a = tab('a', { limits: { maxEntries: 5, maxBytes: 10 } });
    await stage(a, 'eightbyt');
    // A tab killed after writing the data but before the journal file existed
    // leaves only the data (a failed staging cleans up after itself).
    const entryDir = [...(await partitionDir()).entries.values()].find((entry) => entry instanceof MemoryDirectory) as MemoryDirectory;
    entryDir.entries.delete('journal.json');
    expect(await a.list()).toEqual([]);
    expect(dataFiles()).toHaveLength(1);

    expect(await stage(a, 'eightbyt')).toMatchObject({ status: 'staged' });
    expect(await a.usage()).toEqual({ entries: 1, bytes: 8 });
    a.dispose();
  });

  it('frees a published entry’s data before writing its tombstone when out of storage', async () => {
    const a = tab('a');
    await stage(a, 'done', { entryId: 'done' });
    expect(await a.process('done')).toMatchObject({ status: 'published' });
    const doneDir = [...(await partitionDir()).entries.values()].find(
      (entry) => entry instanceof MemoryDirectory && journalOf('done').path.startsWith(`${entry.path}/`),
    ) as MemoryDirectory;
    // An interrupted cleanup left the published data behind, and the disk is full while it is there.
    await writeCommitted(doneDir, 'g1.bin', 'published bytes');
    storage.storage.fault = (path, step) => {
      if (step === 'write' && path.endsWith('partition.json') && doneDir.entries.has('g1.bin')) throw quotaExceeded();
    };
    expect(await a.stage({ policy: 'p', file: new Blob(['next']), entryId: 'next', fileId: 'file_00000000entry02' })).toMatchObject({ status: 'staged' });
    storage.storage.fault = undefined;
    expect((await a.list()).map((e) => e.entryId)).toEqual(['next']);
    // The published generation still reports published to its waiters.
    expect(await a.whenSettled('done', 1)).toMatchObject({ entryId: 'done', state: 'published' });
    a.dispose();
  });
});

/** `tab`'s coordinator, holding back the return (result or error) of the next request whose lock name matches `armed` until released. */
function gatedCoordinator(name: string) {
  const inner = locks.forTab(name);
  const control: { armed?: (lock: string) => boolean; release?: Promise<void>; reached?: ReturnType<typeof deferred<void>> } = {};
  const coordinator: typeof inner = {
    request: (async (lock: string, options: unknown, callback: unknown) => {
      const settled = await (inner.request as (...args: unknown[]) => Promise<unknown>)(lock, options, callback).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (control.armed?.(lock)) {
        control.armed = undefined;
        control.reached?.resolve();
        await control.release;
      }
      if (!settled.ok) throw settled.error;
      return settled.value;
    }) as typeof inner.request,
  };
  const arm = (match: (lock: string) => boolean) => {
    const release = deferred<void>();
    const reached = deferred<void>();
    Object.assign(control, { armed: match, release: release.promise, reached });
    return { reached: reached.promise, release: () => release.resolve() };
  };
  return { coordinator, arm };
}

async function writeLegacy(id: string, key: string) {
  const legacy = await (await storage.root.getDirectoryHandle('filefn-pending-uploads', { create: true })).getDirectoryHandle(id, { create: true });
  await writeCommitted(legacy, 'data.bin', 'old bytes');
  await writeCommitted(legacy, 'metadata.json', JSON.stringify({ uploadSessionId: id, fileId: FILE_ID, policy: 'p', fileName: 'old.txt', size: 9, mimeType: 'text/plain', createdAt: '2026-11-01T00:00:00.000Z', retryCount: 0, metadataVersion: 2, idempotencyKey: key }));
}

const LEGACY = 'offline_1731000000000_legacy101';
const isLegacyLock = (lock: string) => lock.startsWith('filefn-offline-legacy:');

describe('round 10: outermost fences, admissions, observations and read errors', () => {
  it.each(['fresh admission', 'already-admitted recovery'])(
    'returns no entry when the account switches while the legacy lock hands back a %s',
    async (path) => {
      await writeLegacy(LEGACY, 'test-legacy-key-0101');
      let signedIn: OfflineQueuePrincipal = ALICE.principal;
      const gated = gatedCoordinator('a');
      const a = tab('a', { coordinator: gated.coordinator, currentPrincipal: () => signedIn });
      if (path === 'already-admitted recovery') {
        expect(await a.migrateLegacyUpload(LEGACY, { ownershipVerified: true })).toMatchObject({ status: 'staged' });
      }
      const gate = gated.arm(isLegacyLock);
      const migrating = a.migrateLegacyUpload(LEGACY, { ownershipVerified: true });
      await gate.reached;
      signedIn = BOB.principal;
      gate.release();
      expect(await migrating).toEqual({ status: 'refused', reason: 'principal-mismatch' });
      // The admission stays with its owner: back as Alice, the same entry.
      signedIn = ALICE.principal;
      expect(await a.migrateLegacyUpload(LEGACY, { ownershipVerified: true })).toMatchObject({
        status: 'staged',
        entry: { entryId: FILE_ID, generation: 1 },
      });
      expect(await a.list()).toHaveLength(1);
      a.dispose();
    },
  );

  it('rejects a migration whose legacy lock hands back after the queue was disposed', async () => {
    await writeLegacy(LEGACY, 'test-legacy-key-0101');
    const gated = gatedCoordinator('a');
    const a = tab('a', { coordinator: gated.coordinator });
    const gate = gated.arm(isLegacyLock);
    const migrating = a.migrateLegacyUpload(LEGACY, { ownershipVerified: true });
    await gate.reached;
    a.dispose();
    gate.release();
    await expect(migrating).rejects.toMatchObject({ code: 'FILEFN_QUEUE_DISPOSED' });
    // A new instance of the partition finds the admission.
    expect(await tab('b').migrateLegacyUpload(LEGACY, { ownershipVerified: true })).toMatchObject({ status: 'staged', entry: { generation: 1 } });
  });

  it('admits a legacy upload under one queue root only: a retry under another root after an interrupted cleanup is refused', async () => {
    await writeLegacy(LEGACY, 'test-legacy-key-0101');
    const a = tab('a', { rootDir: 'queue-root-a' });
    expect(await a.migrateLegacyUpload(LEGACY, { ownershipVerified: true, entryId: 'entry-from-a' })).toMatchObject({ status: 'staged' });
    // Its cleanup was interrupted: the legacy record is back.
    await writeLegacy(LEGACY, 'test-legacy-key-0101');
    const b = tab('b', { rootDir: 'queue-root-b' });
    expect(await b.migrateLegacyUpload(LEGACY, { ownershipVerified: true })).toEqual({ status: 'refused', reason: 'already-migrated' });
    expect(await b.list()).toEqual([]);
    // The admitting root recovers its own admission (its entry ID), and the cleanup completes.
    expect(await a.migrateLegacyUpload(LEGACY, { ownershipVerified: true, entryId: 'another-entry' })).toMatchObject({
      status: 'staged',
      entry: { entryId: 'entry-from-a', generation: 1 },
    });
    expect(await a.listLegacyUploads()).toEqual([]);
    expect(await a.list()).toHaveLength(1);
  });

  it.each(['get', 'list'])('leaves a waiter of a newer generation pending when an older %s read is applied late', async (read) => {
    const gated = gatedCoordinator('a');
    const a = tab('a', { coordinator: gated.coordinator });
    const b = tab('b');
    await stage(a);
    const gate = gated.arm((lock) => !lock.includes(':entry:'));
    const reading = read === 'get' ? a.get(FILE_ID) : a.list();
    await gate.reached;
    // Another tab stages generation 2 while the read of generation 1 is held back.
    const newer = await stage(b, 'v2', { expectedGeneration: 1 });
    const outcome: { settled?: string } = {};
    const waiter = a.whenSettled(FILE_ID, newer.entry.generation);
    waiter.then(() => (outcome.settled = 'resolved'), (error) => (outcome.settled = error.code));
    gate.release();
    await reading;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(outcome.settled).toBeUndefined();
    expect(await b.process(FILE_ID)).toMatchObject({ status: 'published', entry: { generation: 2 } });
    await a.get(FILE_ID);
    await expect(waiter).resolves.toMatchObject({ generation: 2, state: 'published' });
    a.dispose();
  });

  it('never aborts or revokes a newer generation when the cancel of an older one returns late', async () => {
    const revoked: string[] = [];
    let created = 0;
    vi.stubGlobal('URL', { createObjectURL: () => `blob:preview-${++created}`, revokeObjectURL: (url: string) => revoked.push(url) });
    const started = deferred<AbortSignal>();
    const finish = deferred<void>();
    const uploader: OfflineQueueUploader = {
      async upload(input) {
        started.resolve(input.signal);
        await finish.promise;
        return { fileId: input.fileId, versionId: 'ver_1' };
      },
    };
    const gated = gatedCoordinator('a');
    const a = tab('a', { coordinator: gated.coordinator, uploader });
    const b = tab('b');
    await stage(a);
    const gate = gated.arm((lock) => !lock.includes(':entry:'));
    const cancelling = a.cancel(FILE_ID);
    await gate.reached;
    // Removed: another tab stages the entry again, and this tab previews and uploads that generation.
    const again = await stage(b, 'v2');
    expect(again.entry.generation).toBe(2);
    const preview = await a.getPendingLocalDescriptor(FILE_ID);
    expect(preview?.source.url).toBe('blob:preview-1');
    const processing = a.process(FILE_ID);
    const signal = await started.promise;
    gate.release();
    expect(await cancelling).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(signal.aborted).toBe(false);
    expect(revoked).toEqual([]);
    finish.resolve();
    expect(await processing).toMatchObject({ status: 'published', entry: { generation: 2 } });
    a.dispose();
  });

  it('keeps a committed pending generation when its journal cannot be read during reclaim or restaging', async () => {
    const a = tab('a');
    await stage(a, 'only copy');
    storage.storage.fault = (path, step) => {
      if (path.endsWith('journal.json') && step === 'read') throw new DOMException('read failed', 'NotReadableError');
    };
    await expect(a.reclaim()).rejects.toMatchObject({ name: 'NotReadableError' });
    await expect(a.stage({ policy: 'p', file: new Blob(['replacement']), fileId: FILE_ID })).rejects.toMatchObject({ name: 'NotReadableError' });
    storage.storage.fault = undefined;
    expect(await a.get(FILE_ID)).toMatchObject({ generation: 1, phase: 'staged' });
    expect(dataFiles()).toHaveLength(1);
    const uploader = recordingUploader();
    expect(await tab('b', { uploader }).process(FILE_ID)).toMatchObject({ status: 'published' });
    expect(uploader.calls.map((call) => call.body)).toEqual(['only copy']);
  });

  it('never hands out a generation again when the partition meta cannot be read', async () => {
    const a = tab('a');
    await stage(a);
    await stage(a, 'v2', { expectedGeneration: 1 });
    expect(await a.cancel(FILE_ID)).toBe(true);
    storage.storage.fault = (path, step) => {
      if (path.endsWith('partition.json') && step === 'read') throw new DOMException('read failed', 'NotReadableError');
    };
    await expect(a.stage({ policy: 'p', file: new Blob(['v3']), fileId: FILE_ID })).rejects.toMatchObject({ name: 'NotReadableError' });
    storage.storage.fault = undefined;
    expect((await stage(a, 'v3')).entry.generation).toBe(3);
  });

  it('goes on with the pass when another tab replaces the entry being uploaded, and uploads its new generation', async () => {
    const FIRST = 'file_00000000aaaa0001';
    const SECOND = 'file_00000000bbbb0002';
    const reached = deferred<void>();
    const resume = deferred<void>();
    const calls: Array<{ fileId: string; body: string }> = [];
    const uploader: OfflineQueueUploader = {
      async upload(input) {
        calls.push({ fileId: input.fileId, body: await input.file.text() });
        if (calls.length === 1) {
          reached.resolve();
          await resume.promise;
          // The guard before the next request finds the generation replaced.
          await input.assertPrincipal();
        }
        return { fileId: input.fileId, versionId: `ver_${calls.length}` };
      },
    };
    const a = tab('a', { uploader });
    const b = tab('b');
    await a.stage({ policy: 'p', file: new Blob(['first v1']), fileId: FIRST });
    await a.stage({ policy: 'p', file: new Blob(['second']), fileId: SECOND });
    const pass = a.processAll();
    await reached.promise;
    const replaced = await b.stage({ policy: 'p', file: new Blob(['first v2']), fileId: FIRST, expectedGeneration: 1 });
    if (replaced.status !== 'staged') throw new Error('not staged');
    resume.resolve();
    const results = await pass;
    expect(results).toEqual([
      { entryId: FIRST, result: expect.objectContaining({ status: 'published', entry: expect.objectContaining({ generation: replaced.entry.generation }) }) },
      { entryId: SECOND, result: expect.objectContaining({ status: 'published' }) },
    ]);
    expect(calls.map((call) => call.body)).toEqual(['first v1', 'first v2', 'second']);
    expect((await a.get(FIRST))?.attempts).toBe(0);
  });
});

describe('round 11: outer fences on every call, claims, overtaken previews and envelopes', () => {
  const MISMATCH = { code: 'FILEFN_QUEUE_PRINCIPAL_MISMATCH' };

  it.each(['listLegacyUploads', 'usage', 'reclaim'] as const)(
    '%s returns nothing of the old principal when its coordinator hands back after a switch or a disposal',
    async (method) => {
      await writeLegacy(LEGACY, 'test-legacy-key-0111');
      let signedIn: OfflineQueuePrincipal = ALICE.principal;
      const gated = gatedCoordinator('a');
      const a = tab('a', { coordinator: gated.coordinator, currentPrincipal: () => signedIn });
      await stage(a);
      let gate = gated.arm(() => true);
      let call = a[method]();
      await gate.reached;
      signedIn = BOB.principal;
      gate.release();
      await expect(call).rejects.toMatchObject(MISMATCH);

      signedIn = ALICE.principal;
      gate = gated.arm(() => true);
      call = a[method]();
      await gate.reached;
      a.dispose();
      gate.release();
      await expect(call).rejects.toMatchObject({ code: 'FILEFN_QUEUE_DISPOSED' });
    },
  );

  it.each(['hold', 'reconcile'] as const)('a %s conflict error naming the current generation passes the outer fence', async (method) => {
    let signedIn: OfflineQueuePrincipal = ALICE.principal;
    const gated = gatedCoordinator('a');
    const a = tab('a', { coordinator: gated.coordinator, currentPrincipal: () => signedIn });
    await stage(a);
    await expect(method === 'hold' ? a.hold(FILE_ID, 7) : a.reconcile(FILE_ID, 7)).rejects.toMatchObject({
      code: 'FILEFN_QUEUE_STALE_GENERATION',
      details: { currentGeneration: 1 },
    });
    const gate = gated.arm(() => true);
    const call = method === 'hold' ? a.hold(FILE_ID, 7) : a.reconcile(FILE_ID, 7);
    await gate.reached;
    signedIn = BOB.principal;
    gate.release();
    const error = await call.then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject(MISMATCH);
    expect(JSON.stringify((error as { details?: unknown }).details ?? {})).not.toContain('currentGeneration');
    a.dispose();
  });

  it('frees the claim of a migration refused before anything was admitted, so a free entry ID can be chosen', async () => {
    await writeLegacy(LEGACY, 'test-legacy-key-0112');
    const a = tab('a', { rootDir: 'queue-root-a' });
    // The legacy file ID is taken by an entry of the partition.
    await stage(a, 'taken');
    expect(await a.migrateLegacyUpload(LEGACY, { ownershipVerified: true })).toMatchObject({
      status: 'refused',
      reason: 'generation-conflict',
    });
    expect(await a.migrateLegacyUpload(LEGACY, { ownershipVerified: true, entryId: 'free-entry' })).toMatchObject({
      status: 'staged',
      entry: { entryId: 'free-entry', generation: expect.any(Number) },
    });
    expect(await a.listLegacyUploads()).toEqual([]);
    // That admission is now fixed to its root: another root is refused.
    await writeLegacy(LEGACY, 'test-legacy-key-0112');
    expect(await tab('b', { rootDir: 'queue-root-b' }).migrateLegacyUpload(LEGACY, { ownershipVerified: true, entryId: 'elsewhere' })).toEqual({
      status: 'refused',
      reason: 'already-migrated',
    });
  });

  it('an older preview read handed back late neither revokes nor replaces the newer preview, nor returns its bytes', async () => {
    const revoked: string[] = [];
    let created = 0;
    vi.stubGlobal('URL', {
      createObjectURL: (blob: Blob) => `blob:preview-${++created}-size-${blob.size}`,
      revokeObjectURL: (url: string) => revoked.push(url),
    });
    const gated = gatedCoordinator('a');
    const a = tab('a', { coordinator: gated.coordinator });
    await stage(a, 'v1');
    const gate = gated.arm(() => true);
    const older = a.getPendingLocalDescriptor(FILE_ID);
    await gate.reached;
    await stage(a, 'v2-longer', { expectedGeneration: 1 });
    const newer = await a.getPendingLocalDescriptor(FILE_ID);
    expect(newer?.source.url).toBe('blob:preview-1-size-9');
    gate.release();
    expect((await older)?.source.url).toBe('blob:preview-1-size-9');
    expect(revoked).toEqual([]);
    expect(created).toBe(1);
    a.dispose();
  });

  it.each([
    ['ok: false', { ok: false, fileId: FILE_ID, versionId: 'ver_1' }],
    ['an error', { fileId: FILE_ID, versionId: 'ver_1', error: { code: 'FILEFN_INTERNAL' } }],
  ])('keeps a custom uploader result with %s provisional under the same key', async (_label, failure) => {
    const keys: string[] = [];
    let fail = true;
    const verify = vi.fn(async () => ({ verified: true as const }));
    const a = tab('a', {
      hooks: { verify },
      uploader: {
        async upload(input) {
          keys.push(input.idempotencyKey);
          return (fail ? failure : { fileId: input.fileId, versionId: 'ver_2' }) as never;
        },
      },
    });
    await stage(a);
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'uploading' } });
    expect(verify).not.toHaveBeenCalled();
    expect(dataFiles()).toHaveLength(1);
    fail = false;
    expect(await a.process(FILE_ID)).toMatchObject({ status: 'published', entry: { upload: { versionId: 'ver_2' } } });
    expect(new Set(keys).size).toBe(1);
  });

  it('refuses a file larger than the partition may hold without reading its bytes', async () => {
    const a = tab('a', { limits: { maxBytes: 4 } });
    const file = new Blob(['more than four bytes']);
    const read = vi.spyOn(file, 'arrayBuffer');
    expect(await a.stage({ policy: 'p', file, fileId: FILE_ID })).toMatchObject({
      status: 'refused',
      reason: 'capacity',
      limit: 'bytes',
      usage: { entries: 0, bytes: 0 },
    });
    expect(read).not.toHaveBeenCalled();
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileFn, type FileFnConfig, type Processor } from '../src/index.js';

const owner = { principalId: 'owner', tenantId: 'tenant', requestId: 'runtime_test' };
const NEW_ID = (prefix: string) => new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{20}$`);

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'filefn-runtime-'));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(rootDir, { recursive: true, force: true });
});

function createGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function gatedProcessor(gate: Promise<void>, state: { started: boolean; finished: boolean }): Processor {
  return {
    name: 'gated-uppercase',
    supportedMimeTypes: ['text/plain'],
    async process(input, getData) {
      state.started = true;
      await gate;
      const source = new TextDecoder().decode(await getData());
      state.finished = true;
      return {
        success: true,
        artifacts: [{
          kind: 'uppercase',
          data: new TextEncoder().encode(source.toUpperCase()),
          mimeType: 'text/plain',
          storageKey: `${input.storageKey}.uppercase`,
        }],
      };
    },
  };
}

function createTestFileFn(overrides: Partial<FileFnConfig> = {}) {
  return createFileFn({
    database: memoryAdapter(),
    storage: createLocalStorageAdapter({ rootDir }),
    namespace: 'runtime_test',
    policies: [{ name: 'note', contentTypes: ['text/plain'], visibility: 'private' }],
    ...overrides,
  });
}

async function uploadNote(fileFn: ReturnType<typeof createFileFn>, text = 'deferred bytes') {
  const body = Buffer.from(text);
  const session = await fileFn.createUploadSession({
    policy: 'note', fileName: 'note.txt', size: body.length, mimeType: 'text/plain',
  }, owner);
  const part = await fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, body, body.length, owner);
  await fileFn.completeUploadPart({
    uploadSessionId: session.uploadSessionId, partNumber: 1, etag: part.etag, size: part.size,
  }, owner);
  const result = await fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, owner);
  return { session, result };
}

describe('runtime.defer', () => {
  it('hands queue-less processing to the hook instead of running it inside the request', async () => {
    const gate = createGate();
    const state = { started: false, finished: false };
    const deferred: Promise<unknown>[] = [];
    const startedWhenDeferred: boolean[] = [];
    const fileFn = createTestFileFn({
      processing: { enabled: true, processors: [gatedProcessor(gate.promise, state)] },
      runtime: {
        defer(work) {
          startedWhenDeferred.push(state.started);
          deferred.push(work);
        },
      },
    });
    const completed = vi.fn();
    fileFn.events.on('processing.completed', completed);

    const { result } = await uploadNote(fileFn);

    // The upload completed while processing is still blocked, so it was not awaited inline.
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toBeInstanceOf(Promise);
    expect(startedWhenDeferred).toEqual([false]);
    expect(state.finished).toBe(false);
    expect(completed).not.toHaveBeenCalled();

    gate.release();
    await expect(deferred[0]).resolves.toBeUndefined();

    expect(state.finished).toBe(true);
    expect(completed).toHaveBeenCalledTimes(1);
    const artifacts = await fileFn.services.processing.listArtifactsForFile(result.fileId, owner);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifactId).toMatch(NEW_ID('art'));
  });

  it('still runs the work when the hook itself throws', async () => {
    const fileFn = createTestFileFn({
      processing: { enabled: true, processors: [gatedProcessor(Promise.resolve(), { started: false, finished: false })] },
      runtime: {
        defer() {
          throw new Error('waitUntil unavailable');
        },
      },
    });
    const processed = new Promise<void>((resolve) => fileFn.events.once('processing.completed', () => resolve()));

    const { result } = await uploadNote(fileFn);
    await processed;

    expect(await fileFn.services.processing.listArtifactsForFile(result.fileId, owner)).toHaveLength(1);
  });

  it('hands event fan-out to observability sinks to the hook', async () => {
    const sink = createGate();
    const sinkEvents: string[] = [];
    const deferred: Promise<unknown>[] = [];
    const fileFn = createTestFileFn({
      observability: {
        events: async (event) => {
          sinkEvents.push(event.type);
          await sink.promise;
        },
      },
      runtime: { defer: (work) => deferred.push(work) },
    });

    await fileFn.createUploadSession({ policy: 'note', fileName: 'a.txt', size: 1, mimeType: 'text/plain' }, owner);

    expect(sinkEvents).toEqual(['upload.started']);
    expect(deferred).toHaveLength(1);
    let settled = false;
    void deferred[0].then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    sink.release();
    await expect(deferred[0]).resolves.toBeUndefined();
  });

  it('absorbs a rejecting observability sink instead of leaking an unhandled rejection', async () => {
    const deferred: Promise<unknown>[] = [];
    const fileFn = createTestFileFn({
      observability: {
        events: async () => {
          throw new Error('sink down');
        },
      },
      runtime: { defer: (work) => deferred.push(work) },
    });

    await fileFn.createUploadSession({ policy: 'note', fileName: 'a.txt', size: 1, mimeType: 'text/plain' }, owner);

    expect(deferred).toHaveLength(1);
    await expect(deferred[0]).resolves.toBeUndefined();
  });

  it('keeps setImmediate scheduling on Node when no hook is configured', async () => {
    const setImmediateSpy = vi.spyOn(globalThis, 'setImmediate');
    const fileFn = createTestFileFn({
      processing: { enabled: true, processors: [gatedProcessor(Promise.resolve(), { started: false, finished: false })] },
    });
    const processed = new Promise<void>((resolve) => fileFn.events.once('processing.completed', () => resolve()));

    const { result } = await uploadNote(fileFn);
    await processed;

    expect(setImmediateSpy).toHaveBeenCalled();
    expect(await fileFn.services.processing.listArtifactsForFile(result.fileId, owner)).toHaveLength(1);
  });
});

describe('generated IDs', () => {
  it('issues crypto-random upload, file and version IDs without Math.random', async () => {
    const mathRandom = vi.spyOn(Math, 'random');
    const fileFn = createTestFileFn();

    const { session, result } = await uploadNote(fileFn);

    expect(session.uploadSessionId).toMatch(NEW_ID('upl'));
    expect(result.fileId).toMatch(NEW_ID('file'));
    expect(result.versionId).toMatch(NEW_ID('ver'));
    expect(mathRandom).not.toHaveBeenCalled();
  });

  it('keeps a client-supplied file ID in a legacy shape', async () => {
    const fileFn = createTestFileFn();
    const body = Buffer.from('legacy');
    const session = await fileFn.createUploadSession({
      policy: 'note', fileName: 'legacy.txt', size: body.length, mimeType: 'text/plain', fileId: 'file_lx2k9a_q8w3e1',
    }, owner);
    const part = await fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, body, body.length, owner);
    await fileFn.completeUploadPart({ uploadSessionId: session.uploadSessionId, partNumber: 1, etag: part.etag, size: part.size }, owner);
    const result = await fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, owner);

    expect(result.fileId).toBe('file_lx2k9a_q8w3e1');
    expect((await fileFn.getFile({ fileId: 'file_lx2k9a_q8w3e1' }, owner)).fileId).toBe('file_lx2k9a_q8w3e1');
  });
});

describe('cleanupExpiredSessions', () => {
  it('is callable on the FileFn instance and removes only expired, incomplete sessions', async () => {
    const fileFn = createTestFileFn({ uploadSessionTtlSeconds: 60 });
    const expired = await fileFn.createUploadSession({ policy: 'note', fileName: 'a.txt', size: 1, mimeType: 'text/plain' }, owner);
    const { result } = await uploadNote(fileFn);

    expect(await fileFn.cleanupExpiredSessions()).toEqual({ deletedSessions: 0, abortedMultipart: 0 });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    expect(await fileFn.cleanupExpiredSessions()).toEqual({ deletedSessions: 1, abortedMultipart: 0 });

    await expect(fileFn.getUploadSessionStatus({ uploadSessionId: expired.uploadSessionId }, owner))
      .rejects.toMatchObject({ code: 'FILEFN_SESSION_NOT_FOUND' });
    expect((await fileFn.getFile({ fileId: result.fileId }, owner)).fileId).toBe(result.fileId);
  });
});

describe('basePath with observability', () => {
  it('observes requests under the mount and leaves other paths unobserved', async () => {
    const run = vi.fn(async (_observation: unknown, work: () => unknown) => work());
    const fileFn = createTestFileFn({
      basePath: '/files',
      auth: { resolveSession: async () => ({ principalId: 'owner', tenantId: 'tenant' }) },
      observability: { requestContext: { run: run as never, get: () => undefined } },
    });

    expect(await fileFn.router.handle(new Request('https://host.test/other'))).toBeNull();
    expect(await fileFn.router.handle(new Request('https://host.test/policies'))).toBeNull();
    expect(run).not.toHaveBeenCalled();

    const response = await fileFn.router.handle(new Request('https://host.test/files/policies'));
    expect(response?.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import type { Adapter } from '@superfunctions/db';
import type { StorageAdapter } from '@superfunctions/storage';
import { describe, expect, it, vi } from 'vitest';
import {
  createFileFn,
  createProcessingJobHandler,
  type FileFn,
  type FileFnConfig,
  type Processor,
  type ProcessorInput,
  type ProcessingQueueMessage,
  PROCESSING_RUN_KIND,
} from '../src/index.js';
import { createMemoryStorage } from './workers/memory-storage.js';

const owner = { principalId: 'owner', tenantId: 'tenant', requestId: 'req_upload' };

interface CapturedQueue {
  jobs: Record<string, unknown>[];
  add: ReturnType<typeof vi.fn>;
}

/** A FlowFn queue that keeps each job as a JSON round trip, as Cloudflare Queues delivers it. */
function createCapturingQueue(): CapturedQueue & { name: string } {
  const jobs: Record<string, unknown>[] = [];
  return {
    name: 'filefn.processing',
    jobs,
    add: vi.fn(async (job: unknown) => {
      const jobId = `job_${jobs.length + 1}`;
      jobs.push(JSON.parse(JSON.stringify({ ...(job as object), jobId })));
      return { jobId };
    }),
  };
}

interface ProcessorSpy extends Processor {
  inputs: ProcessorInput[];
}

function textProcessor(
  name: string,
  options: {
    kinds?: string[];
    fail?: (call: number) => Error | string | null;
    delayMs?: number;
    gate?: Promise<void>;
    storageKeyFor?: (input: ProcessorInput, kind: string) => string;
  } = {},
): ProcessorSpy {
  const inputs: ProcessorInput[] = [];
  const kinds = options.kinds ?? [name];
  return {
    name,
    supportedMimeTypes: ['text/plain'],
    inputs,
    async process(input, getData) {
      inputs.push(input);
      if (options.gate) await options.gate;
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      const failure = options.fail?.(inputs.length) ?? null;
      if (failure instanceof Error) throw failure;
      if (typeof failure === 'string') return { success: false, artifacts: [], error: failure };
      const source = new TextDecoder().decode(await getData());
      return {
        success: true,
        artifacts: kinds.map((kind) => ({
          kind,
          data: new TextEncoder().encode(`${kind}:${source.toUpperCase()}`),
          mimeType: 'text/plain',
          storageKey: options.storageKeyFor?.(input, kind) ?? `${input.storageKey}.${kind}`,
          metadata: { source: name },
        })),
      };
    },
  };
}

/**
 * The memory adapter only keeps its own `id` unique. Postgres also enforces the
 * schema's unique `artifactId`, which concurrent deliveries rely on.
 */
function withUniqueArtifactIds(database: Adapter): Adapter {
  const claimed = new Set<string>();
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property !== 'create') return Reflect.get(target, property, receiver);
      return async (params: Parameters<Adapter['create']>[0]) => {
        const artifactId = (params.data as { artifactId?: string }).artifactId;
        if (params.model === 'fileArtifacts' && artifactId) {
          if (claimed.has(artifactId)) {
            throw new Error(`duplicate key value violates unique constraint (artifactId=${artifactId})`);
          }
          claimed.add(artifactId);
        }
        return target.create(params);
      };
    },
  });
}

function setup(processors: Processor[], overrides: Partial<FileFnConfig> = {}) {
  const queue = createCapturingQueue();
  const database = withUniqueArtifactIds(memoryAdapter());
  const fileFn = createFileFn({
    database,
    storage: createMemoryStorage(),
    namespace: 'jobs_test',
    policies: [
      { name: 'note', contentTypes: ['text/plain'], visibility: 'private' },
      { name: 'archived-note', contentTypes: ['text/plain'], visibility: 'private', artifactStorageTarget: 'archive' },
    ],
    processing: {
      enabled: true,
      processors,
      flowFn: { getQueue: (name) => (name === 'filefn.processing' ? queue : undefined) },
    },
    ...overrides,
  });
  return { fileFn, queue, database };
}

async function uploadNote(fileFn: FileFn, text = 'queued bytes', policy = 'note') {
  const body = Buffer.from(text);
  const session = await fileFn.createUploadSession({
    policy, fileName: 'note.txt', size: body.length, mimeType: 'text/plain',
  }, owner);
  const part = await fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, body, body.length, owner);
  await fileFn.completeUploadPart({
    uploadSessionId: session.uploadSessionId, partNumber: 1, etag: part.etag, size: part.size,
  }, owner);
  return fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, owner);
}

function listArtifacts(fileFn: FileFn, fileId: string) {
  return fileFn.services.processing.listArtifactsForFile(fileId, owner);
}

async function readArtifact(fileFn: FileFn, fileId: string, artifactId: string): Promise<string> {
  const { stream } = await fileFn.services.processing.getArtifactDownloadStreamForFile(fileId, artifactId, owner);
  return new Response(stream).text();
}

function message(body: unknown, attempts: number): ProcessingQueueMessage & {
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
} {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}

/**
 * Holds the first `deleteMany` of `model` until released: `before` holds it
 * before the rows go, `after` once they are gone.
 */
function pauseDeleteMany(database: Adapter, model: string, when: 'before' | 'after') {
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let armed = true;
  const adapter = new Proxy(database, {
    get(target, property, receiver) {
      if (property !== 'deleteMany') return Reflect.get(target, property, receiver);
      return async (params: Parameters<Adapter['deleteMany']>[0]) => {
        const pause = armed && params.model === model;
        if (pause) armed = false;
        if (pause && when === 'before') {
          reached();
          await released;
        }
        const result = await target.deleteMany(params);
        if (pause && when === 'after') {
          reached();
          await released;
        }
        return result;
      };
    },
  });
  return { adapter, reached: reachedPromise, release };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('processing jobs', () => {
  it('enqueues a filefn.processing job on upload completion instead of processing in the request', async () => {
    const processor = textProcessor('uppercase');
    const { fileFn, queue } = setup([processor]);

    const { fileId, versionId } = await uploadNote(fileFn);
    await nextTurn();

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.jobs[0]).toMatchObject({
      fileId,
      versionId,
      idempotencyKey: `processing:${fileId}:${versionId}:uppercase`,
      requestId: 'req_upload',
      jobId: 'job_1',
    });
    expect(processor.inputs).toHaveLength(0);
    expect(await listArtifacts(fileFn, fileId)).toEqual([]);
  });

  it('runs the processors for a job and records each artifact with its processing duration', async () => {
    const processor = textProcessor('uppercase', { delayMs: 30 });
    const { fileFn, queue } = setup([processor]);
    const completed = vi.fn();
    fileFn.events.on('processing.completed', completed);
    const { fileId, versionId } = await uploadNote(fileFn);
    const version = await fileFn.services.files.getVersion(fileId, versionId, owner);
    // The handler reads file details from the database, not from the queued body.
    const job = { ...queue.jobs[0], storageKey: 'uploads/someone-else/secret.txt', mimeType: 'image/png' };

    const outcome = await createProcessingJobHandler(fileFn).handle(job, { attempts: 1 });

    expect(outcome).toEqual({ status: 'completed', artifactsCreated: 1, skippedProcessors: [] });
    expect(processor.inputs).toEqual([expect.objectContaining({
      fileId, versionId, storageKey: version.storageKey, mimeType: 'text/plain', fileName: 'note.txt', tenantId: 'tenant',
    })]);
    const artifacts = await listArtifacts(fileFn, fileId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ fileId, versionId, kind: 'uppercase', mimeType: 'text/plain' });
    expect(artifacts[0].metadata).toEqual({
      source: 'uppercase',
      processing: {
        processor: 'uppercase',
        durationMs: expect.any(Number),
        idempotencyKey: queue.jobs[0].idempotencyKey,
        storageTarget: 'durable',
      },
    });
    expect((artifacts[0].metadata as any).processing.durationMs).toBeGreaterThanOrEqual(25);
    expect(await readArtifact(fileFn, fileId, artifacts[0].artifactId)).toBe('uppercase:QUEUED BYTES');
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req_upload', fileId, versionId, artifactsCreated: 1,
    }));
  });

  it('records one artifact set when the same job is delivered again', async () => {
    const processor = textProcessor('uppercase');
    const { fileFn, queue } = setup([processor]);
    const completed = vi.fn();
    fileFn.events.on('processing.completed', completed);
    const { fileId } = await uploadNote(fileFn);
    const handler = createProcessingJobHandler(fileFn);
    const first = message(queue.jobs[0], 1);
    const redelivered = message(queue.jobs[0], 1);

    await handler.queue({ messages: [first] });
    const firstArtifacts = await listArtifacts(fileFn, fileId);
    await handler.queue({ messages: [redelivered] });

    expect(await handler.handle(queue.jobs[0])).toEqual({ status: 'duplicate' });
    expect(processor.inputs).toHaveLength(1);
    expect(first.ack).toHaveBeenCalledTimes(1);
    expect(redelivered.ack).toHaveBeenCalledTimes(1);
    expect(redelivered.retry).not.toHaveBeenCalled();
    expect(completed).toHaveBeenCalledTimes(1);
    expect(await listArtifacts(fileFn, fileId)).toEqual(firstArtifacts);
  });

  it('records one artifact set when two deliveries of a job run at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processor = textProcessor('uppercase', { gate });
    const { fileFn, queue } = setup([processor]);
    const { fileId } = await uploadNote(fileFn);
    const handler = createProcessingJobHandler(fileFn);

    const both = Promise.all([handler.handle(queue.jobs[0]), handler.handle(queue.jobs[0])]);
    await vi.waitFor(() => expect(processor.inputs).toHaveLength(2));
    release();
    const outcomes = await both;

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['completed', 'completed']);
    const artifacts = await listArtifacts(fileFn, fileId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].kind).toBe('uppercase');
  });

  it('reruns a processor whose artifact set an earlier delivery recorded only in part', async () => {
    const processor = textProcessor('pair', { kinds: ['first', 'second'] });
    const storage = createMemoryStorage();
    let failSecondUpload = true;
    const flakyStorage: StorageAdapter = {
      ...storage,
      async openUploadStream(input) {
        if (failSecondUpload && input.key.endsWith('.second')) {
          failSecondUpload = false;
          throw new Error('storage write interrupted');
        }
        return storage.openUploadStream!(input);
      },
    };
    const { fileFn, queue } = setup([processor], { storage: flakyStorage });
    const { fileId } = await uploadNote(fileFn);
    const handler = createProcessingJobHandler(fileFn);

    const interrupted = await handler.handle(queue.jobs[0], { attempts: 1 });
    expect(interrupted).toEqual({ status: 'retry', errors: ['pair: storage write interrupted'] });
    expect((await listArtifacts(fileFn, fileId)).map((artifact) => artifact.kind)).toEqual(['first']);

    const retried = await handler.handle(queue.jobs[0], { attempts: 2 });

    expect(retried).toEqual({ status: 'completed', artifactsCreated: 2, skippedProcessors: [] });
    expect(processor.inputs).toHaveLength(2);
    expect((await listArtifacts(fileFn, fileId)).map((artifact) => artifact.kind).sort()).toEqual(['first', 'second']);
  });

  it('acknowledges and drops a job whose file version was deleted', async () => {
    const processor = textProcessor('uppercase');
    const { fileFn, queue } = setup([processor]);
    const failed = vi.fn();
    fileFn.events.on('processing.failed', failed);
    const { fileId } = await uploadNote(fileFn);
    await fileFn.deleteFile({ fileId }, owner);
    const delivery = message(queue.jobs[0], 1);

    await createProcessingJobHandler(fileFn).queue({ messages: [delivery] });

    expect(await createProcessingJobHandler(fileFn).handle(queue.jobs[0])).toEqual({
      status: 'dropped', reason: 'version-deleted',
    });
    expect(delivery.ack).toHaveBeenCalledTimes(1);
    expect(delivery.retry).not.toHaveBeenCalled();
    expect(processor.inputs).toHaveLength(0);
    expect(failed).not.toHaveBeenCalled();
  });

  it('records no artifacts when the version is deleted while its processor runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processor = textProcessor('uppercase', { gate });
    const { fileFn, queue, database } = setup([processor]);
    const { fileId } = await uploadNote(fileFn);

    const running = createProcessingJobHandler(fileFn).handle(queue.jobs[0]);
    await vi.waitFor(() => expect(processor.inputs).toHaveLength(1));
    await fileFn.deleteFile({ fileId }, owner);
    release();

    expect(await running).toEqual({ status: 'dropped', reason: 'version-deleted' });
    expect(await database.findMany({ model: 'fileArtifacts', where: [], namespace: 'jobs_test' })).toEqual([]);
  });

  it('retries a failed processor without rerunning the processors that succeeded', async () => {
    const stable = textProcessor('stable');
    const flaky = textProcessor('flaky', { fail: (call) => (call === 1 ? new Error('decoder crashed') : null) });
    const { fileFn, queue } = setup([stable, flaky]);
    const failed = vi.fn();
    fileFn.events.on('processing.failed', failed);
    const { fileId } = await uploadNote(fileFn);
    const handler = createProcessingJobHandler(fileFn, { retryDelaySeconds: 15 });
    const firstDelivery = message(queue.jobs[0], 1);
    const secondDelivery = message(queue.jobs[0], 2);

    await handler.queue({ messages: [firstDelivery] });

    expect(firstDelivery.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
    expect(firstDelivery.ack).not.toHaveBeenCalled();
    expect((await listArtifacts(fileFn, fileId)).map((artifact) => artifact.kind)).toEqual(['stable']);

    await handler.queue({ messages: [secondDelivery] });

    expect(secondDelivery.ack).toHaveBeenCalledTimes(1);
    expect(secondDelivery.retry).not.toHaveBeenCalled();
    expect(stable.inputs).toHaveLength(1);
    expect(flaky.inputs).toHaveLength(2);
    expect((await listArtifacts(fileFn, fileId)).map((artifact) => artifact.kind).sort()).toEqual(['flaky', 'stable']);
    expect(failed).not.toHaveBeenCalled();
  });

  it('records processing.failed once the queue retry limit is exhausted', async () => {
    const broken = textProcessor('broken', { fail: () => 'unsupported encoding' });
    const { fileFn, queue } = setup([broken]);
    const failed = vi.fn();
    fileFn.events.on('processing.failed', failed);
    const { fileId, versionId } = await uploadNote(fileFn);
    const handler = createProcessingJobHandler(fileFn, { maxRetries: 2 });
    const deliveries = [1, 2, 3].map((attempts) => message(queue.jobs[0], attempts));

    await handler.queue({ messages: deliveries.slice(0, 2) });

    expect(deliveries[0].retry).toHaveBeenCalledTimes(1);
    expect(deliveries[1].retry).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();

    await handler.queue({ messages: [deliveries[2]] });

    expect(deliveries[2].retry).not.toHaveBeenCalled();
    expect(deliveries[2].ack).toHaveBeenCalledTimes(1);
    expect(broken.inputs).toHaveLength(3);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req_upload', fileId, versionId, error: 'broken: unsupported encoding',
    }));
    expect(await handler.handle(queue.jobs[0], { attempts: 4 })).toEqual({
      status: 'failed', errors: ['broken: unsupported encoding'],
    });
    expect(await listArtifacts(fileFn, fileId)).toEqual([]);
  });

  it('acknowledges and drops a body that is not a processing job', async () => {
    const processor = textProcessor('uppercase');
    const { fileFn } = setup([processor]);
    const handler = createProcessingJobHandler(fileFn);
    const deliveries = ['file_1', null, [], { fileId: 'file_1' }, { fileId: 'file_1', versionId: 7 }]
      .map((body) => message(body, 1));

    await handler.queue({ messages: deliveries });

    for (const delivery of deliveries) {
      expect(delivery.ack).toHaveBeenCalledTimes(1);
      expect(delivery.retry).not.toHaveBeenCalled();
    }
    expect(await handler.handle({ versionId: 'ver_1' })).toEqual({ status: 'dropped', reason: 'invalid-job' });
    expect(processor.inputs).toHaveLength(0);
  });

  it('runs each of two processors that share a name until both have recorded their output', async () => {
    // The bundled gzip and deflate compression processors are both named `compression`.
    const gzip = textProcessor('compression', { kinds: ['compressed-gzip'] });
    const deflate = textProcessor('compression', {
      kinds: ['compressed-deflate'],
      fail: (call) => (call === 1 ? new Error('deflate stream error') : null),
    });
    const { fileFn, queue } = setup([gzip, deflate]);
    const { fileId } = await uploadNote(fileFn);
    const handler = createProcessingJobHandler(fileFn);

    expect(await handler.handle(queue.jobs[0], { attempts: 1 })).toEqual({
      status: 'retry', errors: ['compression (instance 2): deflate stream error'],
    });
    expect(await handler.handle(queue.jobs[0], { attempts: 2 })).toEqual({
      // The job's whole output: the skipped instance recorded one artifact in the first delivery.
      status: 'completed', artifactsCreated: 2, skippedProcessors: [{ processor: 'compression', instance: 1 }],
    });
    expect(await handler.handle(queue.jobs[0], { attempts: 1 })).toEqual({ status: 'duplicate' });

    expect(gzip.inputs).toHaveLength(1);
    expect(deflate.inputs).toHaveLength(2);
    expect((await listArtifacts(fileFn, fileId)).map((artifact) => artifact.kind).sort())
      .toEqual(['compressed-deflate', 'compressed-gzip']);
  });

  it('keeps a failed processor pending when another processor is literally named like its instance', async () => {
    const first = textProcessor('compression', { kinds: ['first'] });
    const second = textProcessor('compression', {
      kinds: ['second'],
      fail: (call) => (call === 1 ? new Error('second failed') : null),
    });
    const literal = textProcessor('compression#2', { kinds: ['literal'] });
    const { fileFn, queue } = setup([first, second, literal]);
    const { fileId } = await uploadNote(fileFn);
    const handler = createProcessingJobHandler(fileFn);

    expect(await handler.handle(queue.jobs[0], { attempts: 1 })).toEqual({
      status: 'retry', errors: ['compression (instance 2): second failed'],
    });
    expect(await handler.handle(queue.jobs[0], { attempts: 2 })).toEqual({
      status: 'completed',
      artifactsCreated: 3,
      skippedProcessors: [{ processor: 'compression', instance: 1 }, { processor: 'compression#2', instance: 1 }],
    });

    expect([first.inputs.length, second.inputs.length, literal.inputs.length]).toEqual([1, 2, 1]);
    expect((await listArtifacts(fileFn, fileId)).map((artifact) => artifact.kind).sort())
      .toEqual(['first', 'literal', 'second']);
  });

  it('does not rerun a processor that produced no artifacts when its job is delivered again', async () => {
    const empty = textProcessor('incompressible', { kinds: [] });
    const { fileFn, queue, database } = setup([empty]);
    const completed = vi.fn();
    fileFn.events.on('processing.completed', completed);
    const { fileId } = await uploadNote(fileFn);
    const handler = createProcessingJobHandler(fileFn);

    expect(await handler.handle(queue.jobs[0])).toEqual({ status: 'completed', artifactsCreated: 0, skippedProcessors: [] });
    expect(await handler.handle(queue.jobs[0])).toEqual({ status: 'duplicate' });

    expect(empty.inputs).toHaveLength(1);
    expect(completed).toHaveBeenCalledTimes(1);
    // The run record is not an artifact: the list, lookup and download operations hide it.
    expect(await listArtifacts(fileFn, fileId)).toEqual([]);
    const [run] = await database.findMany<{ artifactId: string; kind: string }>({
      model: 'fileArtifacts', where: [], namespace: 'jobs_test',
    });
    expect(run.kind).toBe(PROCESSING_RUN_KIND);
    await expect(readArtifact(fileFn, fileId, run.artifactId)).rejects.toMatchObject({ code: 'FILEFN_NOT_FOUND' });
    await expect(fileFn.services.processing.getArtifactDownloadUrlForFile(fileId, run.artifactId, owner))
      .rejects.toMatchObject({ code: 'FILEFN_NOT_FOUND' });
  });

  describe('when the version is deleted while its artifacts are written', () => {
    async function expectNothingLeft(
      database: Adapter,
      storage: StorageAdapter,
      uploads: { key: string; target?: string }[],
    ) {
      expect(await database.findMany({ model: 'fileArtifacts', where: [], namespace: 'jobs_test' })).toEqual([]);
      expect(uploads.length).toBeGreaterThan(0);
      for (const upload of uploads) {
        await expect(storage.statObject(upload)).rejects.toThrow('object not found');
      }
    }

    it('drops the job and removes the uploaded object and row when the delete lands during the upload', async () => {
      const storage = createMemoryStorage();
      const uploads: { key: string; target?: string }[] = [];
      let deleteDuringUpload: (() => Promise<void>) | undefined;
      const deletingStorage: StorageAdapter = {
        ...storage,
        async openUploadStream(input) {
          if (input.key.endsWith('.uppercase')) {
            uploads.push({ key: input.key, target: input.target });
            const pending = deleteDuringUpload;
            deleteDuringUpload = undefined;
            await pending?.();
          }
          return storage.openUploadStream!(input);
        },
      };
      const completed = vi.fn();
      const { fileFn, queue, database } = setup([textProcessor('uppercase')], { storage: deletingStorage });
      fileFn.events.on('processing.completed', completed);
      const { fileId } = await uploadNote(fileFn);
      deleteDuringUpload = () => fileFn.deleteFile({ fileId }, owner);

      expect(await createProcessingJobHandler(fileFn).handle(queue.jobs[0])).toEqual({
        status: 'dropped', reason: 'version-deleted',
      });
      expect(completed).not.toHaveBeenCalled();
      await expectNothingLeft(database, storage, uploads);
    });

    it('drops the job and removes the object and row when the delete lands during the row write', async () => {
      const storage = createMemoryStorage();
      const uploads: { key: string; target?: string }[] = [];
      const recordingStorage: StorageAdapter = {
        ...storage,
        async openUploadStream(input) {
          if (input.key.endsWith('.uppercase')) uploads.push({ key: input.key, target: input.target });
          return storage.openUploadStream!(input);
        },
      };
      let deleteDuringRowWrite: (() => Promise<void>) | undefined;
      const base = withUniqueArtifactIds(memoryAdapter());
      const database = new Proxy(base, {
        get(target, property, receiver) {
          if (property !== 'create') return Reflect.get(target, property, receiver);
          return async (params: Parameters<Adapter['create']>[0]) => {
            const created = await target.create(params);
            if (params.model === 'fileArtifacts' && (params.data as { kind?: string }).kind === 'uppercase') {
              const pending = deleteDuringRowWrite;
              deleteDuringRowWrite = undefined;
              await pending?.();
            }
            return created;
          };
        },
      });
      const { fileFn, queue } = setup([textProcessor('uppercase')], { storage: recordingStorage, database });
      const { fileId } = await uploadNote(fileFn);
      deleteDuringRowWrite = () => fileFn.deleteFile({ fileId }, owner);

      expect(await createProcessingJobHandler(fileFn).handle(queue.jobs[0])).toEqual({
        status: 'dropped', reason: 'version-deleted',
      });
      await expectNothingLeft(database, storage, uploads);
    });

    it('removes the artifacts a job finished while the delete was in progress', async () => {
      const storage = createMemoryStorage();
      const uploads: { key: string; target?: string }[] = [];
      const recordingStorage: StorageAdapter = {
        ...storage,
        async openUploadStream(input) {
          if (input.key.endsWith('.uppercase')) uploads.push({ key: input.key, target: input.target });
          return storage.openUploadStream!(input);
        },
      };
      // The delete has read the file's rows but not yet removed its versions.
      const paused = pauseDeleteMany(withUniqueArtifactIds(memoryAdapter()), 'fileVersions', 'before');
      const { fileFn, queue } = setup([textProcessor('uppercase')], { storage: recordingStorage, database: paused.adapter });
      const { fileId } = await uploadNote(fileFn);

      const deleting = fileFn.deleteFile({ fileId }, owner);
      await paused.reached;
      expect(await createProcessingJobHandler(fileFn).handle(queue.jobs[0])).toMatchObject({ status: 'completed' });
      paused.release();
      await deleting;

      await expectNothingLeft(paused.adapter, storage, uploads);
    });

    it('drops a job whose writes land after the delete removed the version', async () => {
      const storage = createMemoryStorage();
      const uploads: { key: string; target?: string }[] = [];
      let deleteDuringUpload: (() => Promise<void>) | undefined;
      const deletingStorage: StorageAdapter = {
        ...storage,
        async openUploadStream(input) {
          if (input.key.endsWith('.uppercase')) {
            uploads.push({ key: input.key, target: input.target });
            const pending = deleteDuringUpload;
            deleteDuringUpload = undefined;
            await pending?.();
          }
          return storage.openUploadStream!(input);
        },
      };
      // The delete has removed the versions but not yet listed the artifacts.
      const paused = pauseDeleteMany(withUniqueArtifactIds(memoryAdapter()), 'fileVersions', 'after');
      const completed = vi.fn();
      const { fileFn, queue } = setup([textProcessor('uppercase')], { storage: deletingStorage, database: paused.adapter });
      fileFn.events.on('processing.completed', completed);
      const { fileId } = await uploadNote(fileFn);
      let deleting: Promise<void> | undefined;
      deleteDuringUpload = async () => {
        deleting = fileFn.deleteFile({ fileId }, owner);
        await paused.reached;
      };

      expect(await createProcessingJobHandler(fileFn).handle(queue.jobs[0])).toEqual({
        status: 'dropped', reason: 'version-deleted',
      });
      paused.release();
      await deleting;

      expect(completed).not.toHaveBeenCalled();
      await expectNothingLeft(paused.adapter, storage, uploads);
    });

    it('deletes an object whose key another file uses only in a different storage target', async () => {
      const storage = createMemoryStorage();
      let deleteDuringUpload: (() => Promise<void>) | undefined;
      const deletingStorage: StorageAdapter = {
        ...storage,
        async openUploadStream(input) {
          const pending = deleteDuringUpload;
          deleteDuringUpload = undefined;
          await pending?.();
          return storage.openUploadStream!(input);
        },
      };
      const shared = textProcessor('stamp', { storageKeyFor: () => 'artifacts/shared-stamp' });
      const { fileFn, queue } = setup([shared], { storage: deletingStorage });
      // The archived file's artifact has the same key in the `archive` target.
      const archived = await uploadNote(fileFn, 'archived', 'archived-note');
      const removed = await uploadNote(fileFn, 'removed');
      const handler = createProcessingJobHandler(fileFn);
      expect(await handler.handle(queue.jobs[0])).toMatchObject({ status: 'completed' });
      deleteDuringUpload = () => fileFn.deleteFile({ fileId: removed.fileId }, owner);

      expect(await handler.handle(queue.jobs[1])).toEqual({ status: 'dropped', reason: 'version-deleted' });

      await expect(storage.statObject({ key: 'artifacts/shared-stamp', target: 'durable' }))
        .rejects.toThrow('object not found');
      const [artifact] = await listArtifacts(fileFn, archived.fileId);
      await expect(readArtifact(fileFn, archived.fileId, artifact.artifactId)).resolves.toBe('stamp:ARCHIVED');
    });

    it('keeps an object another file still references in the same storage target', async () => {
      const storage = createMemoryStorage();
      let deleteDuringUpload: (() => Promise<void>) | undefined;
      const deletingStorage: StorageAdapter = {
        ...storage,
        async openUploadStream(input) {
          const pending = deleteDuringUpload;
          deleteDuringUpload = undefined;
          await pending?.();
          return storage.openUploadStream!(input);
        },
      };
      const shared = textProcessor('stamp', { storageKeyFor: () => 'artifacts/shared-stamp' });
      const { fileFn, queue } = setup([shared], { storage: deletingStorage });
      const kept = await uploadNote(fileFn, 'kept');
      const removed = await uploadNote(fileFn, 'removed');
      const handler = createProcessingJobHandler(fileFn);
      expect(await handler.handle(queue.jobs[0])).toMatchObject({ status: 'completed' });
      deleteDuringUpload = () => fileFn.deleteFile({ fileId: removed.fileId }, owner);

      expect(await handler.handle(queue.jobs[1])).toEqual({ status: 'dropped', reason: 'version-deleted' });

      const [artifact] = await listArtifacts(fileFn, kept.fileId);
      expect(artifact.storageKey).toBe('artifacts/shared-stamp');
      await expect(readArtifact(fileFn, kept.fileId, artifact.artifactId)).resolves.toBeTypeOf('string');
    });
  });

  describe('when cleanup of a version deleted during the run is interrupted', () => {
    type Fault = 'version-read' | 'reference-scan' | 'object-delete';

    /**
     * The file (with an `archive` artifact target) is deleted while the job
     * uploads its artifact, so the delete lists no artifacts; once it is done,
     * `fault` fails once in the job.
     */
    async function interruptedCleanup(fault: Fault, logError: (message: string, context?: unknown) => void = () => {}) {
      const storage = createMemoryStorage();
      const uploads: { key: string; target?: string }[] = [];
      let armed = false;
      let deleteDuringUpload: (() => Promise<void>) | undefined;
      const faultyStorage: StorageAdapter = {
        ...storage,
        async openUploadStream(input) {
          if (input.key.endsWith('.uppercase')) {
            uploads.push({ key: input.key, target: input.target });
            const pending = deleteDuringUpload;
            deleteDuringUpload = undefined;
            await pending?.();
            armed = true;
          }
          return storage.openUploadStream!(input);
        },
        async deleteObject(input) {
          if (armed && fault === 'object-delete') {
            armed = false;
            throw new Error('storage unavailable');
          }
          return storage.deleteObject(input);
        },
      };
      const failsNow = (matches: boolean) => {
        if (!armed || !matches) return false;
        armed = false;
        return true;
      };
      const database = new Proxy(withUniqueArtifactIds(memoryAdapter()), {
        get(target, property, receiver) {
          if (property === 'findOne') {
            return async (params: Parameters<Adapter['findOne']>[0]) => {
              if (failsNow(fault === 'version-read' && params.model === 'fileVersions')) {
                throw new Error('database connection lost');
              }
              return target.findOne(params);
            };
          }
          if (property === 'findMany') {
            return async (params: Parameters<Adapter['findMany']>[0]) => {
              if (failsNow(fault === 'reference-scan' && params.model === 'fileVersions' && params.where.length === 0)) {
                throw new Error('database connection lost');
              }
              return target.findMany(params);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const completed = vi.fn();
      const failed = vi.fn();
      const { fileFn, queue } = setup([textProcessor('uppercase')], {
        storage: faultyStorage,
        database,
        observability: { logger: { error: logError } },
      });
      fileFn.events.on('processing.completed', completed);
      fileFn.events.on('processing.failed', failed);
      const { fileId } = await uploadNote(fileFn, 'archived', 'archived-note');
      deleteDuringUpload = () => fileFn.deleteFile({ fileId }, owner);
      const handler = createProcessingJobHandler(fileFn);
      return { handler, queue, database, storage, uploads, completed, failed };
    }

    async function artifactRows(database: Adapter) {
      return database.findMany<{ kind: string }>({ model: 'fileArtifacts', where: [], namespace: 'jobs_test' });
    }

    it.each<[Fault, string]>([
      ['version-read', 'its version check after the writes fails'],
      ['reference-scan', 'the reference scan of its cleanup fails'],
      ['object-delete', 'an object delete of its cleanup fails'],
    ])('removes the rows and objects on redelivery when %s (%s)', async (fault) => {
      const { handler, queue, database, storage, uploads, completed, failed } = await interruptedCleanup(fault);

      expect(await handler.handle(queue.jobs[0], { attempts: 1 })).toMatchObject({ status: 'retry' });
      // The rows are the cleanup journal: they stay until their objects are gone.
      expect((await artifactRows(database)).map((row) => row.kind)).toContain('uppercase');
      expect(uploads).toEqual([expect.objectContaining({ target: 'archive' })]);

      expect(await handler.handle(queue.jobs[0], { attempts: 2 })).toEqual({ status: 'dropped', reason: 'version-deleted' });

      expect(await artifactRows(database)).toEqual([]);
      for (const upload of uploads) {
        await expect(storage.statObject(upload)).rejects.toThrow('object not found');
      }
      expect(completed).not.toHaveBeenCalled();
      expect(failed).not.toHaveBeenCalled();
    });

    it.each<Fault>(['reference-scan', 'object-delete'])(
      'drops the job without processing.failed and logs the kept rows when the %s fails on the last delivery',
      async (fault) => {
        const logError = vi.fn();
        const { handler, queue, database, completed, failed } = await interruptedCleanup(fault, logError);

        // The default retry limit is 3, so the 4th delivery is the last.
        expect(await handler.handle(queue.jobs[0], { attempts: 4 })).toEqual({ status: 'dropped', reason: 'version-deleted' });

        expect(failed).not.toHaveBeenCalled();
        expect(completed).not.toHaveBeenCalled();
        const kept = await database.findMany<{ artifactId: string; kind: string }>({
          model: 'fileArtifacts', where: [], namespace: 'jobs_test',
        });
        expect(kept.map((row) => row.kind)).toContain('uppercase');
        expect(logError).toHaveBeenCalledWith(
          expect.stringContaining('cleanup not finished'),
          expect.objectContaining({ keptArtifactIds: expect.arrayContaining(kept.map((row) => row.artifactId)) }),
        );
      },
    );
  });

  describe('when a file delete fails after its versions are removed', () => {
    /** Throws once from the first `findMany` that `matches` after the delete removed the versions. */
    function failOnceAfterVersionDelete(
      database: Adapter,
      matches: (params: Parameters<Adapter['findMany']>[0]) => boolean,
    ) {
      let versionsDeleted = false;
      let failed = false;
      return new Proxy(database, {
        get(target, property, receiver) {
          if (property === 'deleteMany') {
            return async (params: Parameters<Adapter['deleteMany']>[0]) => {
              const result = await target.deleteMany(params);
              if (params.model === 'fileVersions') versionsDeleted = true;
              return result;
            };
          }
          if (property === 'findMany') {
            return async (params: Parameters<Adapter['findMany']>[0]) => {
              if (versionsDeleted && !failed && matches(params)) {
                failed = true;
                throw new Error('database connection lost');
              }
              return target.findMany(params);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
    }

    async function expectRetryRemovesEverything(matches: (params: Parameters<Adapter['findMany']>[0]) => boolean) {
      const storage = createMemoryStorage();
      let usedBytes = 0;
      const recordUsage = vi.fn(async ({ bytes }: { bytes: number }) => {
        usedBytes += bytes;
      });
      const database = failOnceAfterVersionDelete(withUniqueArtifactIds(memoryAdapter()), matches);
      const { fileFn, queue } = setup([textProcessor('uppercase')], {
        storage,
        database,
        quota: { checkQuota: async () => ({ allowed: true, current: usedBytes, limit: 1_000_000 }), recordUsage },
      });
      const { fileId, versionId } = await uploadNote(fileFn, 'source bytes');
      expect(await createProcessingJobHandler(fileFn).handle(queue.jobs[0])).toMatchObject({ status: 'completed' });
      const version = await fileFn.services.files.getVersion(fileId, versionId, owner);
      const [artifact] = await listArtifacts(fileFn, fileId);
      expect(usedBytes).toBe(version.size);

      await expect(fileFn.deleteFile({ fileId }, owner)).rejects.toThrow('database connection lost');
      await fileFn.deleteFile({ fileId }, owner);

      await expect(storage.statObject({ key: version.storageKey, target: 'durable' })).rejects.toThrow('object not found');
      await expect(storage.statObject({ key: artifact.storageKey, target: 'durable' })).rejects.toThrow('object not found');
      expect(usedBytes).toBe(0);
      expect(recordUsage).toHaveBeenLastCalledWith(expect.objectContaining({ bytes: -version.size }));
      expect(await database.findMany({ model: 'fileArtifacts', where: [], namespace: 'jobs_test' })).toEqual([]);
      expect(await database.findMany({ model: 'files', where: [], namespace: 'jobs_test' })).toEqual([]);
    }

    it('removes the source object and releases its quota on retry after the artifact listing fails', async () => {
      await expectRetryRemovesEverything((params) => params.model === 'fileArtifacts' && params.where.length > 0);
    });

    it('removes the source object and releases its quota on retry after the reference scan fails', async () => {
      await expectRetryRemovesEverything((params) => params.model === 'fileVersions' && params.where.length === 0);
    });
  });

  describe('when a delivery fails after every processor finished', () => {
    async function expectOneCompletion(options: { failVersionRead?: boolean; failListener?: boolean }) {
      const processor = textProcessor('uppercase');
      let failNextVersionRead = false;
      const database = new Proxy(withUniqueArtifactIds(memoryAdapter()), {
        get(target, property, receiver) {
          if (property === 'create') {
            return async (params: Parameters<Adapter['create']>[0]) => {
              const created = await target.create(params);
              const metadata = (params.data as { metadata?: Record<string, unknown> }).metadata;
              // Fail the version read that follows the last processor's run row.
              if (options.failVersionRead && metadata?.processingRun) failNextVersionRead = true;
              return created;
            };
          }
          if (property === 'findOne') {
            return async (params: Parameters<Adapter['findOne']>[0]) => {
              if (failNextVersionRead && params.model === 'fileVersions') {
                failNextVersionRead = false;
                throw new Error('database connection lost');
              }
              return target.findOne(params);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const { fileFn, queue } = setup([processor], { database });
      const completed = vi.fn();
      const failed = vi.fn();
      let listenerFailures = options.failListener ? 1 : 0;
      fileFn.events.on('processing.completed', (event) => {
        if (listenerFailures > 0) {
          listenerFailures -= 1;
          throw new Error('listener unavailable');
        }
        completed(event);
      });
      fileFn.events.on('processing.failed', failed);
      const { fileId, versionId } = await uploadNote(fileFn);
      const handler = createProcessingJobHandler(fileFn);

      expect(await handler.handle(queue.jobs[0], { attempts: 1 })).toMatchObject({ status: 'retry' });
      expect(completed).not.toHaveBeenCalled();

      expect(await handler.handle(queue.jobs[0], { attempts: 2 })).toEqual({
        status: 'completed', artifactsCreated: 1, skippedProcessors: [{ processor: 'uppercase', instance: 1 }],
      });
      expect(await handler.handle(queue.jobs[0], { attempts: 3 })).toEqual({ status: 'duplicate' });

      expect(completed).toHaveBeenCalledTimes(1);
      expect(completed).toHaveBeenCalledWith(expect.objectContaining({ fileId, versionId, artifactsCreated: 1 }));
      expect(failed).not.toHaveBeenCalled();
      expect(processor.inputs).toHaveLength(1);
      expect(await listArtifacts(fileFn, fileId)).toHaveLength(1);
    }

    it('emits processing.completed on redelivery when the version check after the writes failed', async () => {
      await expectOneCompletion({ failVersionRead: true });
    });

    it('emits processing.completed on redelivery when a listener threw', async () => {
      await expectOneCompletion({ failListener: true });
    });
  });

  it('removes the completion row of a job whose version is deleted while the row is written', async () => {
    const storage = createMemoryStorage();
    let deleteDuringCompletion: (() => Promise<void>) | undefined;
    const database = new Proxy(withUniqueArtifactIds(memoryAdapter()), {
      get(target, property, receiver) {
        if (property !== 'create') return Reflect.get(target, property, receiver);
        return async (params: Parameters<Adapter['create']>[0]) => {
          const metadata = (params.data as { metadata?: Record<string, unknown> }).metadata;
          if (params.model === 'fileArtifacts' && metadata?.processingCompleted) {
            // The delete lists and removes the job's other rows before this one exists.
            const pending = deleteDuringCompletion;
            deleteDuringCompletion = undefined;
            await pending?.();
          }
          return target.create(params);
        };
      },
    });
    const { fileFn, queue } = setup([textProcessor('uppercase')], { storage, database });
    const { fileId, versionId } = await uploadNote(fileFn);
    const version = await fileFn.services.files.getVersion(fileId, versionId, owner);
    deleteDuringCompletion = () => fileFn.deleteFile({ fileId }, owner);

    expect(await createProcessingJobHandler(fileFn).handle(queue.jobs[0])).toEqual({
      status: 'dropped', reason: 'version-deleted',
    });

    expect(await database.findMany({ model: 'fileArtifacts', where: [], namespace: 'jobs_test' })).toEqual([]);
    await expect(storage.statObject({ key: `${version.storageKey}.uppercase`, target: 'durable' }))
      .rejects.toThrow('object not found');
  });

  it.each([
    [1, [{ status: 'retry' }, { status: 'duplicate' }]],
    [4, [{ status: 'completed', artifactsCreated: 1 }]],
  ])('reports no failure after processing.completed when the version read after the completion row fails (attempt %i)', async (attempts, outcomes) => {
    let failNextVersionRead = false;
    const database = new Proxy(withUniqueArtifactIds(memoryAdapter()), {
      get(target, property, receiver) {
        if (property === 'create') {
          return async (params: Parameters<Adapter['create']>[0]) => {
            const created = await target.create(params);
            const metadata = (params.data as { metadata?: Record<string, unknown> }).metadata;
            if (metadata?.processingCompleted) failNextVersionRead = true;
            return created;
          };
        }
        if (property === 'findOne') {
          return async (params: Parameters<Adapter['findOne']>[0]) => {
            if (failNextVersionRead && params.model === 'fileVersions') {
              failNextVersionRead = false;
              throw new Error('database connection lost');
            }
            return target.findOne(params);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const { fileFn, queue } = setup([textProcessor('uppercase')], { database });
    const completed = vi.fn();
    const failed = vi.fn();
    fileFn.events.on('processing.completed', completed);
    fileFn.events.on('processing.failed', failed);
    await uploadNote(fileFn);
    const handler = createProcessingJobHandler(fileFn);

    for (const [index, outcome] of outcomes.entries()) {
      expect(await handler.handle(queue.jobs[0], { attempts: attempts + index })).toMatchObject(outcome);
    }

    expect(completed).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it('runs a processor added to the configured list after the FileFn was created', async () => {
    const first = textProcessor('first');
    const late = textProcessor('late');
    const processors: Processor[] = [first];
    const { fileFn, queue } = setup(processors);
    processors.push(late);
    const { fileId } = await uploadNote(fileFn);

    expect(await createProcessingJobHandler(fileFn).handle(queue.jobs[0])).toMatchObject({
      status: 'completed', artifactsCreated: 2,
    });

    expect(late.inputs).toHaveLength(1);
    expect((await listArtifacts(fileFn, fileId)).map((artifact) => artifact.kind).sort()).toEqual(['first', 'late']);
  });

  it('enqueues and runs a job whose request ID or processor list is longer than a job field allows', async () => {
    const longName = `uppercase-${'x'.repeat(600)}`;
    const processor = textProcessor(longName, { kinds: ['uppercase'] });
    const { fileFn, queue } = setup([processor]);
    const body = Buffer.from('long ids');
    const longRequest = { ...owner, requestId: `req_${'r'.repeat(509)}` };
    expect(longRequest.requestId).toHaveLength(513);
    const session = await fileFn.createUploadSession({
      policy: 'note', fileName: 'note.txt', size: body.length, mimeType: 'text/plain',
    }, longRequest);
    const part = await fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, body, body.length, longRequest);
    await fileFn.completeUploadPart({
      uploadSessionId: session.uploadSessionId, partNumber: 1, etag: part.etag, size: part.size,
    }, longRequest);
    const { fileId, versionId } = await fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, longRequest);

    const [job] = queue.jobs;
    expect(job.requestId).toBeUndefined();
    expect(job.idempotencyKey).toMatch(new RegExp(`^processing:${fileId}:${versionId}:sha256:[0-9a-f]{64}$`));
    expect((job.idempotencyKey as string).length).toBeLessThanOrEqual(512);

    const handler = createProcessingJobHandler(fileFn);
    expect(await handler.handle(job)).toEqual({ status: 'completed', artifactsCreated: 1, skippedProcessors: [] });
    // A body another producer wrote with over-long optional fields still runs; they are ignored.
    expect(await handler.handle({ ...job, requestId: 'r'.repeat(513), jobId: 'j'.repeat(513) })).toEqual({ status: 'duplicate' });
    expect(processor.inputs).toHaveLength(1);
  });

  it('counts the artifacts recorded before a later artifact write fails', async () => {
    const processor = textProcessor('pair', { kinds: ['first', 'second'] });
    const storage = createMemoryStorage();
    const flakyStorage: StorageAdapter = {
      ...storage,
      async openUploadStream(input) {
        if (input.key.endsWith('.second')) throw new Error('storage write interrupted');
        return storage.openUploadStream!(input);
      },
    };
    // Without a queue, FileFn runs the processors after the response and reports the count.
    const { fileFn } = setup([processor], { storage: flakyStorage, processing: { enabled: true, processors: [processor] } });
    const completed = vi.fn();
    fileFn.events.on('processing.completed', completed);
    const { fileId, versionId } = await uploadNote(fileFn);

    await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ fileId, versionId, artifactsCreated: 1 }));
    expect((await listArtifacts(fileFn, fileId)).map((artifact) => artifact.kind)).toEqual(['first']);
  });

  it('refuses a FileFn it cannot run jobs for', () => {
    const { fileFn } = setup([textProcessor('uppercase')]);
    const disabled = createFileFn({ database: memoryAdapter(), storage: createMemoryStorage() });

    expect(() => createProcessingJobHandler({ ...fileFn })).toThrow('FILEFN_PROCESSING_HANDLER_UNBOUND');
    expect(() => createProcessingJobHandler(disabled)).toThrow('FILEFN_PROCESSING_DISABLED');
    expect(() => createProcessingJobHandler(fileFn, { maxRetries: -1 })).toThrow('FILEFN_PROCESSING_HANDLER_CONFIG_INVALID');
    // Cloudflare Queues accepts message delays of at most 12 hours.
    expect(() => createProcessingJobHandler(fileFn, { retryDelaySeconds: 43_200 })).not.toThrow();
    expect(() => createProcessingJobHandler(fileFn, { retryDelaySeconds: 43_201 })).toThrow('FILEFN_PROCESSING_HANDLER_CONFIG_INVALID');
  });
});

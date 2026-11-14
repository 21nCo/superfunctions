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
  options: { kinds?: string[]; fail?: (call: number) => Error | string | null; delayMs?: number; gate?: Promise<void> } = {},
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
          storageKey: `${input.storageKey}.${kind}`,
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
    policies: [{ name: 'note', contentTypes: ['text/plain'], visibility: 'private' }],
    processing: {
      enabled: true,
      processors,
      flowFn: { getQueue: (name) => (name === 'filefn.processing' ? queue : undefined) },
    },
    ...overrides,
  });
  return { fileFn, queue, database };
}

async function uploadNote(fileFn: FileFn, text = 'queued bytes') {
  const body = Buffer.from(text);
  const session = await fileFn.createUploadSession({
    policy: 'note', fileName: 'note.txt', size: body.length, mimeType: 'text/plain',
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
        idempotencyKey: `processing:${fileId}:${versionId}:uppercase`,
        artifactCount: 1,
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

  it('refuses a FileFn it cannot run jobs for', () => {
    const { fileFn } = setup([textProcessor('uppercase')]);
    const disabled = createFileFn({ database: memoryAdapter(), storage: createMemoryStorage() });

    expect(() => createProcessingJobHandler({ ...fileFn })).toThrow('FILEFN_PROCESSING_HANDLER_UNBOUND');
    expect(() => createProcessingJobHandler(disabled)).toThrow('FILEFN_PROCESSING_DISABLED');
    expect(() => createProcessingJobHandler(fileFn, { maxRetries: -1 })).toThrow('FILEFN_PROCESSING_HANDLER_CONFIG_INVALID');
  });
});

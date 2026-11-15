/**
 * Cloudflare Queues producer for FileFn's `flowFn` hook.
 *
 * `@filefn/server` enqueues `filefn.processing` jobs through
 * `processing.flowFn.getQueue(name).add(job)`. This module adapts a Workers
 * Queue producer binding (`env.<BINDING>`) to that interface. It has no
 * runtime dependencies, so a Worker can import it from
 * `@filefn/processing/queues/cloudflare` without bundling the image and OCR
 * processors the package root exports.
 */

/** Queue name `@filefn/server` uses for processing jobs. */
export const PROCESSING_QUEUE_NAME = 'filefn.processing';

/** Message encodings a Workers Queue binding accepts. */
export type CloudflareQueueContentType = 'json' | 'text' | 'bytes' | 'v8';

export interface CloudflareQueueSendOptions {
  contentType?: CloudflareQueueContentType;
  delaySeconds?: number;
}

/** The part of a Workers `Queue` producer binding this producer uses. */
export interface CloudflareQueueBinding {
  send(body: unknown, options?: CloudflareQueueSendOptions): Promise<unknown>;
}

/** Structurally the `FlowFnQueue` interface `@filefn/server` calls. */
export interface CloudflareFlowFnQueue {
  name: string;
  add(job: unknown): Promise<{ jobId: string }>;
}

/** Structurally the `FlowFnProvider` interface `@filefn/server` calls. */
export interface CloudflareFlowFnProvider {
  getQueue(name: string): CloudflareFlowFnQueue | undefined;
}

/** The longest delay Cloudflare Queues accepts for a message: 24 hours. */
export const MAX_QUEUE_DELAY_SECONDS = 86_400;

export interface CloudflareQueueProducerSettings {
  /** Delays first delivery of every message by this many seconds, at most 86400 (24 hours). */
  delaySeconds?: number;
  /** Generates the `jobId` added to each message; defaults to `crypto.randomUUID()`. */
  generateJobId?: () => string;
}

export interface CloudflareQueueProducerOptions extends CloudflareQueueProducerSettings {
  /** The Queue producer binding, e.g. `env.FILEFN_PROCESSING_QUEUE`. */
  queue: CloudflareQueueBinding;
  /** The FlowFn queue name this producer serves; defaults to `filefn.processing`. */
  name?: string;
}

function defaultJobId(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof webCrypto?.randomUUID !== 'function') {
    throw new Error(
      'FILEFN_QUEUE_JOB_ID_UNAVAILABLE: crypto.randomUUID is not available; pass generateJobId',
    );
  }
  return webCrypto.randomUUID();
}

function assertBinding(queue: unknown, name: string): asserts queue is CloudflareQueueBinding {
  if (!queue || typeof (queue as CloudflareQueueBinding).send !== 'function') {
    throw new TypeError(`FILEFN_QUEUE_BINDING_INVALID: queue "${name}" needs a binding with send()`);
  }
}

function assertSettings(settings: CloudflareQueueProducerSettings): void {
  const { delaySeconds, generateJobId } = settings;
  if (
    delaySeconds !== undefined &&
    (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_QUEUE_DELAY_SECONDS)
  ) {
    throw new TypeError(
      `FILEFN_QUEUE_DELAY_INVALID: delaySeconds must be an integer from 0 to ${MAX_QUEUE_DELAY_SECONDS}`,
    );
  }
  if (generateJobId !== undefined && typeof generateJobId !== 'function') {
    throw new TypeError('FILEFN_QUEUE_JOB_ID_INVALID: generateJobId must be a function');
  }
}

function isPlainJob(job: unknown): job is Record<string, unknown> {
  return typeof job === 'object' && job !== null && !Array.isArray(job);
}

/**
 * Creates a FlowFn queue that sends each job to a Workers Queue as a JSON
 * message. The message body is the job with a generated `jobId` added; the
 * same `jobId` is returned to FileFn. A rejected `send` rejects `add`, which
 * FileFn reports as `PROCESSING_ENQUEUE_FAILED`.
 */
export function createCloudflareQueueProducer(options: CloudflareQueueProducerOptions): CloudflareFlowFnQueue {
  const name = options.name ?? PROCESSING_QUEUE_NAME;
  assertBinding(options.queue, name);
  assertSettings(options);
  const { queue, delaySeconds } = options;
  const generateJobId = options.generateJobId ?? defaultJobId;

  return {
    name,
    async add(job: unknown): Promise<{ jobId: string }> {
      if (!isPlainJob(job)) {
        throw new TypeError(`FILEFN_QUEUE_JOB_INVALID: queue "${name}" jobs must be objects`);
      }
      const jobId = generateJobId();
      if (typeof jobId !== 'string' || jobId.length === 0) {
        throw new TypeError('FILEFN_QUEUE_JOB_ID_INVALID: generateJobId must return a non-empty string');
      }
      const sendOptions: CloudflareQueueSendOptions = { contentType: 'json' };
      if (delaySeconds !== undefined) {
        sendOptions.delaySeconds = delaySeconds;
      }
      await queue.send({ ...job, jobId }, sendOptions);
      return { jobId };
    },
  };
}

/**
 * Creates a FlowFn provider over Workers Queue bindings keyed by FlowFn queue
 * name, e.g. `{ 'filefn.processing': env.FILEFN_PROCESSING_QUEUE }`. A name
 * without a binding returns `undefined`, so FileFn falls back to processing
 * after the response.
 */
export function createCloudflareFlowFnProvider(
  queues: Record<string, CloudflareQueueBinding | undefined>,
  settings: CloudflareQueueProducerSettings = {},
): CloudflareFlowFnProvider {
  assertSettings(settings);
  const producers = new Map<string, CloudflareFlowFnQueue>();
  for (const [name, queue] of Object.entries(queues)) {
    if (queue === undefined) continue;
    producers.set(name, createCloudflareQueueProducer({ ...settings, queue, name }));
  }

  return {
    getQueue(name: string): CloudflareFlowFnQueue | undefined {
      return producers.get(name);
    },
  };
}

import type { FileFn } from '../index.js';
import type { ProcessingJobOutcome, ProcessingService } from './service.js';

/** Processing services of the FileFn instances `createFileFn` returned. */
const processingServices = new WeakMap<object, ProcessingService>();

/** Called by `createFileFn` so the handler runs on the instance's own services. */
export function bindProcessingJobs(fileFn: object, service: ProcessingService): void {
  processingServices.set(fileFn, service);
}

/** Cloudflare's default consumer `max_retries`. */
const DEFAULT_MAX_RETRIES = 3;

/** The longest delay Cloudflare Queues accepts for a message: 12 hours. */
const MAX_RETRY_DELAY_SECONDS = 43_200;

export interface ProcessingJobHandlerOptions {
  /**
   * Redeliveries the queue makes after the first attempt: the consumer's
   * `max_retries` (Cloudflare's default is 3). The delivery whose attempt
   * number exceeds it is the last; a processor failure on it is recorded as
   * `processing.failed` instead of being retried.
   */
  maxRetries?: number;
  /**
   * Delay in seconds for a redelivered message, at most 43200 (12 hours,
   * Cloudflare's limit); omitted uses the queue's `retry_delay`.
   */
  retryDelaySeconds?: number;
}

export interface ProcessingJobDeliveryInfo {
  /** 1-based delivery attempt, a Cloudflare message's `attempts`; defaults to 1. */
  attempts?: number;
}

/** The part of a Workers queue `Message` the handler uses. */
export interface ProcessingQueueMessage {
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

/** The part of a Workers queue `MessageBatch` the handler uses. */
export interface ProcessingQueueBatch {
  readonly messages: readonly ProcessingQueueMessage[];
}

export interface ProcessingJobHandler {
  /**
   * Runs one queued `filefn.processing` job and returns its outcome; never
   * throws. `retry` means the queue should redeliver the job; every other
   * outcome means it is done (acknowledge it).
   */
  handle(body: unknown, delivery?: ProcessingJobDeliveryInfo): Promise<ProcessingJobOutcome>;
  /**
   * Cloudflare Queues consumer: runs each message in turn, then acknowledges
   * it or, for a `retry` outcome, asks the queue to redeliver it.
   */
  queue(batch: ProcessingQueueBatch): Promise<void>;
}

function assertNonNegativeInteger(name: string, value: number | undefined, max = Number.MAX_SAFE_INTEGER): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > max)) {
    throw new TypeError(`FILEFN_PROCESSING_HANDLER_CONFIG_INVALID: ${name} must be an integer from 0 to ${max}`);
  }
}

function normalizeAttempts(attempts: number | undefined): number {
  return typeof attempts === 'number' && Number.isInteger(attempts) && attempts >= 1 ? attempts : 1;
}

/**
 * Creates the consumer for FileFn's `filefn.processing` queue. It runs the
 * FileFn instance's configured processors for one job and records artifacts
 * through that instance's services, once per job idempotency key: each
 * processor that finishes records a run (kind `filefn.processing-run`) after
 * its artifacts, and a redelivered job skips processors with a recorded run.
 *
 * A job whose file version was deleted, before or during the run, is dropped
 * and leaves no artifacts for that version. A processor failure asks
 * the queue to retry until the last delivery (see `maxRetries`), which records
 * `processing.failed`.
 */
export function createProcessingJobHandler(
  fileFn: FileFn,
  options: ProcessingJobHandlerOptions = {},
): ProcessingJobHandler {
  const service = processingServices.get(fileFn);
  if (!service) {
    throw new TypeError('FILEFN_PROCESSING_HANDLER_UNBOUND: pass a FileFn instance created by createFileFn');
  }
  if (!service.isEnabled()) {
    throw new Error('FILEFN_PROCESSING_DISABLED: enable processing and configure processors to consume processing jobs');
  }
  assertNonNegativeInteger('maxRetries', options.maxRetries);
  assertNonNegativeInteger('retryDelaySeconds', options.retryDelaySeconds, MAX_RETRY_DELAY_SECONDS);
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryOptions = options.retryDelaySeconds === undefined
    ? undefined
    : { delaySeconds: options.retryDelaySeconds };

  async function handle(body: unknown, delivery: ProcessingJobDeliveryInfo = {}): Promise<ProcessingJobOutcome> {
    const attempts = normalizeAttempts(delivery.attempts);
    return service!.processJob(body, { attempts, finalAttempt: attempts > maxRetries });
  }

  return {
    handle,
    async queue(batch) {
      for (const message of batch.messages) {
        let outcome: ProcessingJobOutcome;
        try {
          outcome = await handle(message.body, { attempts: message.attempts });
        } catch {
          // `handle` does not throw; if it ever does, let the queue's retry limit bound it.
          message.retry(retryOptions);
          continue;
        }
        if (outcome.status === 'retry') {
          message.retry(retryOptions);
        } else {
          message.ack();
        }
      }
    },
  };
}

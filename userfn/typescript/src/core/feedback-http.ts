import { v4 as uuid } from 'uuid';
import type { FeedbackContext, FeedbackReceipt, FeedbackService, FeedbackSubmission, UserFnOptions } from '../types';
import { FeedbackDeliveryError } from './feedback';

export class FeedbackHTTPError extends FeedbackDeliveryError {
  constructor(public readonly status: number) { super(`Feedback request failed with HTTP ${status}`); this.name = 'FeedbackHTTPError'; }
}
const transient = (status: number) => status === 408 || status === 429 || status >= 500;

export class HttpFeedbackService implements FeedbackService {
  private url: string;
  private attempts: number;
  private timeout: number;
  constructor(private options: UserFnOptions) {
    const endpoint = new URL(options.endpoint!);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new TypeError('Invalid UserFn endpoint');
    if (!options.apiKey?.trim()) throw new TypeError('UserFn apiKey is required');
    this.url = endpoint.toString().replace(/\/$/, '') + '/feedback';
    this.attempts = options.feedbackMaxAttempts ?? 3;
    this.timeout = options.feedbackTimeoutMs ?? 10000;
    if (!Number.isInteger(this.attempts) || this.attempts < 1 || this.attempts > 5 || !Number.isInteger(this.timeout) || this.timeout < 1 || this.timeout > 60000) throw new TypeError('Invalid feedback retry/timeout configuration');
  }
  async submit(feedback: FeedbackSubmission, context: FeedbackContext): Promise<FeedbackReceipt> {
    const key = context.idempotencyKey ?? uuid();
    const body = JSON.stringify({ feedback, context: { source: context.source, user: context.user } });
    if (new TextEncoder().encode(body).byteLength > 65536) throw new RangeError('Feedback request exceeds 65536 bytes');
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      try {
        const response = await fetch(this.url, { method: 'POST', headers: {
          authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json', 'idempotency-key': key,
        }, body, signal: controller.signal, redirect: 'error', credentials: 'omit' });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new FeedbackHTTPError(response.status);
        }
        // Malformed successful responses are not acknowledgments and must not be retried blindly.
        let receipt: FeedbackReceipt;
        try { receipt = await readReceipt(response); }
        catch (error) { if (controller.signal.aborted || error instanceof FeedbackDeliveryError) throw error; throw new FeedbackDeliveryError('Feedback service returned an invalid receipt'); }
        if (!receipt || receipt.accepted !== true || typeof receipt.id !== 'string' || !receipt.id.trim()) throw new FeedbackDeliveryError('Feedback service did not acknowledge acceptance');
        return receipt;
      } catch (error) {
        if (attempt + 1 >= this.attempts || (error instanceof FeedbackHTTPError && !transient(error.status)) || (error instanceof FeedbackDeliveryError && !(error instanceof FeedbackHTTPError))) throw error;
      } finally { clearTimeout(timer); }
      await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
    }
    throw new FeedbackDeliveryError('Feedback delivery exhausted');
  }
}


async function readReceipt(response: Response): Promise<FeedbackReceipt> {
  const reader = response.body?.getReader();
  if (!reader) throw new FeedbackDeliveryError('Feedback service returned an empty receipt');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) {
        void reader.cancel().catch(() => undefined);
        throw new FeedbackDeliveryError('Feedback service returned an oversized receipt');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as FeedbackReceipt;
}

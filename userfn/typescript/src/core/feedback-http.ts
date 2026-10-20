import { v4 as uuid } from 'uuid';
import type { FeedbackContext, FeedbackReceipt, FeedbackBoardOptions, FeedbackBoardPage, FeedbackVote, FeedbackStatus, FeedbackMetadataPatch, FeedbackMetadataResult, FeedbackStatusResult, FeedbackService, FeedbackSubmission, UserFnOptions } from '../types';
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
    const receipt = await this.request<FeedbackReceipt>('', 'POST', body, key);
    if (!receipt || receipt.accepted !== true || typeof receipt.id !== 'string' || !receipt.id.trim()) throw new FeedbackDeliveryError('Feedback service did not acknowledge acceptance');
    return receipt;
  }
  async list(options: FeedbackBoardOptions = {}): Promise<FeedbackBoardPage> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) if (value !== undefined) query.set(key, String(value));
    const page = await this.request<FeedbackBoardPage>('?' + query, 'GET');
    if (!page || !Array.isArray(page.items) || !(page.nextCursor === null || (typeof page.nextCursor === 'string' && /^uf_[a-f0-9]{64}$/.test(page.nextCursor))) || page.items.length > 100 || page.items.some(item => !item || !/^uf_[a-f0-9]{64}$/.test(item.id) || typeof item.title !== 'string' || typeof item.body !== 'string' || !Number.isInteger(item.votes) || ![-1, 0, 1].includes(item.viewerVote!) || !['open', 'planned', 'in_progress', 'done', 'closed'].includes(item.status) || typeof item.createdAt !== 'string')) throw new FeedbackDeliveryError('Invalid feedback board response');
    return page;
  }
  async vote(id: string, direction: -1 | 0 | 1): Promise<FeedbackVote> {
    if (!/^uf_[a-f0-9]{64}$/.test(id) || ![-1, 0, 1].includes(direction)) throw new TypeError('Invalid feedback vote');
    const result = await this.request<FeedbackVote>('/' + id + '/vote', 'POST', JSON.stringify({ direction }));
    if (!result || result.id !== id || !Number.isInteger(result.votes) || ![-1, 0, 1].includes(result.viewerVote)) throw new FeedbackDeliveryError('Invalid feedback vote response');
    return result;
  }
  async setMetadata(id: string, patch: FeedbackMetadataPatch): Promise<FeedbackMetadataResult> {
    if (!/^uf_[a-f0-9]{64}$/.test(id) || !patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !['tags', 'productArea'].includes(key))) throw new TypeError('Invalid feedback metadata');
    const validText = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
    if (('tags' in patch && (!Array.isArray(patch.tags) || patch.tags.length > 20 || patch.tags.some(tag => !validText(tag, 64)))) || ('productArea' in patch && patch.productArea !== null && !validText(patch.productArea, 100))) throw new TypeError('Invalid feedback metadata');
    const result = await this.request<FeedbackMetadataResult>('/' + id + '/metadata', 'PATCH', JSON.stringify(patch));
    if (!result || result.id !== id || !Array.isArray(result.tags) || result.tags.length > 20 || result.tags.some(tag => !validText(tag, 64)) || (result.productArea !== null && !validText(result.productArea, 100))) throw new FeedbackDeliveryError('Invalid feedback metadata response');
    const normalizedTags = (tags: string[]) => [...new Set(tags.map(tag => tag.normalize('NFC').trim()))].sort();
    if ((patch.tags !== undefined && JSON.stringify(normalizedTags(result.tags)) !== JSON.stringify(normalizedTags(patch.tags))) || ('productArea' in patch && result.productArea !== (patch.productArea === null ? null : patch.productArea!.normalize('NFC').trim()))) throw new FeedbackDeliveryError('Feedback metadata acknowledgment does not match request');
    return result;
  }
  async setStatus(id: string, status: FeedbackStatus): Promise<FeedbackStatusResult> {
    if (!/^uf_[a-f0-9]{64}$/.test(id) || !['open', 'planned', 'in_progress', 'done', 'closed'].includes(status)) throw new TypeError('Invalid feedback status');
    const result = await this.request<FeedbackStatusResult>('/' + id + '/status', 'PATCH', JSON.stringify({ status }));
    if (!result || result.id !== id || result.status !== status) throw new FeedbackDeliveryError('Invalid feedback status response');
    return result;
  }
  private async request<T>(path: string, method: string, body?: string, key?: string): Promise<T> {
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      try {
        const response = await fetch(this.url + path, { method, headers: {
          authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}),
        }, body, signal: controller.signal, redirect: 'error', credentials: 'omit' });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new FeedbackHTTPError(response.status);
        }
        // Malformed successful responses are not acknowledgments and must not be retried blindly.
        let receipt: T;
        try { receipt = await readReceipt(response, method === 'GET' ? 16 * 1024 * 1024 : 65536) as T; }
        catch (error) { if (controller.signal.aborted || error instanceof FeedbackDeliveryError) throw error; throw new FeedbackDeliveryError('Feedback service returned an invalid receipt'); }
        return receipt;
      } catch (error) {
        if (attempt + 1 >= this.attempts || (error instanceof FeedbackHTTPError && !transient(error.status)) || (error instanceof FeedbackDeliveryError && !(error instanceof FeedbackHTTPError))) throw error;
      } finally { clearTimeout(timer); }
      await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
    }
    throw new FeedbackDeliveryError('Feedback delivery exhausted');
  }
}


async function readReceipt(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new FeedbackDeliveryError('Feedback service returned an empty receipt');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
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

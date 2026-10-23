import type { SurveyReceipt, SurveyResponse, UserFnOptions } from '../types';
import { canonicalJson } from '../utils/json';

export class SurveyDeliveryError extends Error {
  constructor(message: string, public readonly status?: number) { super(message); this.name = 'SurveyDeliveryError'; }
}
export class HttpSurveyService {
  private endpoint: string;
  private apiKey: string;
  private timeout: number;
  private attempts: number;
  constructor(options: UserFnOptions) {
    const url = new URL(options.endpoint!);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !options.apiKey?.trim()) throw new TypeError('Invalid survey endpoint or credential');
    this.apiKey = options.apiKey;
    this.endpoint = url.toString().replace(/\/$/, '');
    this.timeout = options.surveyTimeoutMs ?? 10000; this.attempts = options.surveyMaxAttempts ?? 3;
    if (!Number.isInteger(this.timeout) || this.timeout < 1 || this.timeout > 60000 || !Number.isInteger(this.attempts) || this.attempts < 1 || this.attempts > 5) throw new TypeError('Invalid survey timeout/retry configuration');
  }
  async submit(surveyId: string, answers: SurveyResponse['answers'], idempotencyKey: string): Promise<SurveyReceipt> {
    if (![surveyId, idempotencyKey].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)) || !Array.isArray(answers) || answers.length > 100) throw new TypeError('Invalid survey submission');
    let body: string;
    try { body = canonicalJson({ answers }); } catch { throw new TypeError('Survey answers must be JSON data'); }
    if (new TextEncoder().encode(body).byteLength > 65536) throw new RangeError('Survey request exceeds 65536 bytes');
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const operation = (async () => {
          const response = await fetch(`${this.endpoint}/surveys/${surveyId}/responses`, { method: 'POST', body, headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, credentials: 'omit', redirect: 'error', signal: controller.signal });
          if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new SurveyDeliveryError(`Survey request failed with HTTP ${response.status}`, response.status); }
          const reader = response.body?.getReader(); if (!reader) throw new SurveyDeliveryError('Missing survey receipt');
          const chunks: Uint8Array[] = []; let size = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read(); if (done) break;
              size += value.byteLength; if (size > 65536) throw new SurveyDeliveryError('Oversized survey receipt');
              chunks.push(value);
            }
          } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
          const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          let value: SurveyReceipt;
          try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new SurveyDeliveryError('Invalid survey receipt'); }
          if (!value || value.accepted !== true || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id) || value.surveyId !== surveyId || !Number.isSafeInteger(value.submittedAt) || value.submittedAt < 0 || value.submittedAt > 8640000000000000) throw new SurveyDeliveryError('Invalid survey receipt');
          return value;
        })();
        const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new SurveyDeliveryError('Survey outcome is unknown after timeout', 408)); }, this.timeout); });
        return await Promise.race([operation, deadline]);
      } catch (error) {
        if (attempt + 1 === this.attempts || (error instanceof SurveyDeliveryError && (error.status === undefined || (error.status !== 408 && error.status < 500)))) throw error;
      } finally { clearTimeout(timer); controller.abort(); }
      await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
    }
    throw new SurveyDeliveryError('Survey outcome remains unknown; retry the same key');
  }
}

import { BrowserClient } from '@watchfn/browser';
import { v4 as uuid } from 'uuid';
import type { ExposureOptions, UserIdentity } from '../types';
import type { FlagEvaluation } from './flags';

/** Owns only flag exposure metadata; values and user traits are never transmitted. */
export class FlagExposures {
  private readonly client: BrowserClient;
  private readonly app: string;
  private readonly limit: number;
  private dropped = 0;
  private unreportedDrops = 0;
  private closed = false;
  private lastError?: string;
  constructor(options: ExposureOptions, private readonly environment?: string) {
    const url = new URL(options.endpoint);
    if ((url.protocol !== 'https:' && !(options.allowInsecureHttp === true && url.protocol === 'http:')) || url.username || url.password || url.hash) throw new TypeError('Invalid exposure endpoint');
    if (typeof options.app !== 'string' || !options.app.trim() || options.app.length > 200 || typeof options.apiKey !== 'string' || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey)) throw new TypeError('Exposure app and API key are required');
    this.app = options.app;
    this.limit = options.maxQueueSize ?? 1000;
    this.client = new BrowserClient({ endpoint: url.href, projectId: this.app, apiKey: options.apiKey,
      autoTrack: false, maxQueueSize: this.limit, timeoutMs: options.timeoutMs ?? 10000, retries: 0 });
  }
  capture(key: string, result: FlagEvaluation, user: UserIdentity | null): void {
    try {
      if (this.closed || this.client.pendingCount >= this.limit) throw new Error();
      const event = { id: uuid(), type: 'track', name: 'userfn.flag_exposure', timestamp: new Date().toISOString(),
        app: { name: this.app }, ...(user ? { user: { id: user.id } } : {}),
        properties: { flagKey: key, variationId: result.variationId, ruleId: result.ruleId, reason: result.reason,
          ...(this.environment === undefined ? {} : { environment: this.environment }) } };
      if (new TextEncoder().encode(JSON.stringify(event)).byteLength > 64 * 1024) throw new Error();
      void this.client.capture(event).then(() => { this.lastError = undefined; }, () => { this.lastError = 'Exposure delivery failed; queued events retained'; });
    } catch { this.dropped++; this.unreportedDrops++; this.lastError = 'Exposure rejected: queue closed, full or event too large'; }
  }
  async flush(): Promise<void> {
    try { await this.client.flush(); }
    catch { this.lastError = 'Exposure delivery failed; queued events retained'; throw new Error(this.lastError); }
    if (this.unreportedDrops) { this.unreportedDrops = 0; this.lastError = 'Exposure events were rejected before delivery'; throw new Error(this.lastError); }
    this.lastError = undefined;
  }
  async close(): Promise<void> { this.closed = true; await this.flush(); await this.client.close(); }
  status() { return { pending: this.client.pendingCount, dropped: this.dropped, lastError: this.lastError, closed: this.closed }; }
}

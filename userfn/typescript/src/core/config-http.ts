import type { FlagConfig, Segment, UserFnOptions } from '../types';
import { validateFlagDefinitions } from './flags';

export class ConfigRefreshError extends Error {
  constructor(message = 'Configuration refresh failed') { super(message); this.name = 'ConfigRefreshError'; }
}
export interface VerifiedConfig { flags: FlagConfig[]; segments: Segment[]; }
const maximum = 270336;
const decode = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ConfigRefreshError('Invalid configuration encoding');
  try { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0)); } catch { throw new ConfigRefreshError('Invalid configuration encoding'); }
};
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function validateConfigSegments(segments: unknown): asserts segments is Segment[] {
  if (!Array.isArray(segments) || segments.length > 1000) throw new ConfigRefreshError('Invalid configuration segments');
  const ids = new Set<string>();
  for (const segment of segments) {
    if (!object(segment) || typeof segment.id !== 'string' || !segment.id || ids.has(segment.id) || typeof segment.name !== 'string' || !segment.name || !Array.isArray(segment.rules) || (segment.matchType !== undefined && !['all', 'any'].includes(segment.matchType))) throw new ConfigRefreshError('Invalid configuration segment');
    ids.add(segment.id);
    validateFlagDefinitions([{ key: 'validation', enabled: true, defaultValue: false, variations: [], rules: [{ id: 'validation', constraints: segment.rules }] }]);
  }
}
function boundDepth(value: unknown, depth = 0): void {
  if (depth > 20) throw new ConfigRefreshError('Configuration nesting exceeds limit');
  if (value && typeof value === 'object') for (const child of Object.values(value)) boundDepth(child, depth + 1);
}

/** Host-pinned Ed25519 verification and conditional fetch; never applies unverified state. */
export class HttpConfigService {
  private readonly url: string;
  private readonly key: string;
  private readonly tenantId: string;
  private readonly environment: string;
  private readonly keys: Map<string, Uint8Array>;
  private readonly timeout: number;
  private etag?: string;
  private generation = 0;
  private active?: AbortController;
  private inflight?: Promise<boolean>;
  private closed = false;
  constructor(options: UserFnOptions) {
    const config = options.config!;
    const endpoint = new URL(options.endpoint!);
    if (!config || !options.apiKey?.trim() || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol === 'http:' && config.allowInsecureHttp !== true)) throw new TypeError('Signed configuration requires HTTPS (or explicit local HTTP opt-in), endpoint and API key');
    if (!options.environment || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(options.environment) || typeof config.tenantId !== 'string' || !config.tenantId.trim() || config.tenantId.length > 200) throw new TypeError('Expected configuration tenant and environment are required');
    this.timeout = config.timeoutMs ?? 10000;
    if (!Number.isInteger(this.timeout) || this.timeout < 1 || this.timeout > 60000) throw new TypeError('Invalid configuration timeout');
    if (!object(config.trustedKeys) || !Object.keys(config.trustedKeys).length) throw new TypeError('Trusted configuration keys are required');
    this.keys = new Map(Object.entries(config.trustedKeys).map(([id, value]) => {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || typeof value !== 'string') throw new TypeError('Invalid trusted configuration key');
      const bytes = decode(value); if (bytes.length !== 44) throw new TypeError('Expected Ed25519 SPKI public key');
      return [id, bytes];
    }));
    this.url = endpoint.toString().replace(/\/$/, '') + '/config/' + encodeURIComponent(options.environment);
    this.key = options.apiKey; this.tenantId = config.tenantId; this.environment = options.environment;
  }
  get isClosed(): boolean { return this.closed; }
  async cancel(): Promise<void> {
    this.generation++; this.active?.abort();
    try { await this.inflight; } catch { /* Cancellation is observed by the refresh caller. */ }
  }
  invalidate(): void { this.etag = undefined; this.generation++; }
  close(): void { this.closed = true; this.invalidate(); this.active?.abort(); }
  refresh(apply: (value: VerifiedConfig) => void): Promise<boolean> {
    if (this.closed) return Promise.reject(new ConfigRefreshError('Configuration transport is closed'));
    if (this.inflight) return this.inflight;
    const operation = this.perform(apply);
    this.inflight = operation;
    void operation.finally(() => { if (this.inflight === operation) this.inflight = undefined; }).catch(() => {});
    return operation;
  }
  private async perform(apply: (value: VerifiedConfig) => void): Promise<boolean> {
    const generation = this.generation; const previous = this.etag;
    const deadline = performance.now() + this.timeout;
    const controller = new AbortController(); this.active = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.download(controller, previous),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ConfigRefreshError('Configuration request timed out')); }, this.timeout); }),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new ConfigRefreshError('Configuration request cancelled')), { once: true })),
      ]);
      if (performance.now() > deadline) throw new ConfigRefreshError('Configuration request timed out');
      if (this.closed || generation !== this.generation || controller.signal.aborted) throw new ConfigRefreshError('Configuration changed during refresh');
      if (!result) return false;
      apply(result.value); // Synchronous validated replacement, with no await between flags and segments.
      this.etag = result.etag;
      return true;
    } catch (error) {
      if (error instanceof ConfigRefreshError) throw error;
      throw new ConfigRefreshError();
    } finally { if (timer) clearTimeout(timer); if (this.active === controller) this.active = undefined; controller.abort(); }
  }
  private async download(controller: AbortController, previous?: string): Promise<{ value: VerifiedConfig; etag: string } | null> {
    const response = await fetch(this.url, { headers: { authorization: 'Bearer ' + this.key, ...(previous ? { 'if-none-match': previous } : {}) }, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
    if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new ConfigRefreshError('Configuration request cancelled'); }
    if (response.status === 304) {
      if (!previous || response.headers.get('etag') !== previous) throw new ConfigRefreshError('Unverified conditional configuration response');
      return null;
    }
    if (response.status !== 200) { void response.body?.cancel().catch(() => {}); throw new ConfigRefreshError('Configuration HTTP response was not successful'); }
    if (response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity') { void response.body?.cancel().catch(() => {}); throw new ConfigRefreshError('Compressed configuration is not supported'); }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) { void response.body?.cancel().catch(() => {}); throw new ConfigRefreshError('Configuration response exceeds limit'); }
    if (!response.body) throw new ConfigRefreshError('Missing configuration response');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    const abort = () => { void reader.cancel().catch(() => {}); }; controller.signal.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        const { value, done } = await reader.read(); if (controller.signal.aborted) throw new ConfigRefreshError('Configuration request cancelled'); if (done) break;
        size += value.byteLength; if (size > maximum || chunks.length >= 4096) throw new ConfigRefreshError('Configuration response exceeds limit'); chunks.push(value);
      }
    } finally { controller.signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
    const raw = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); boundDepth(value);
    if (!object(value) || value.version !== 1 || value.algorithm !== 'Ed25519' || value.tenantId !== this.tenantId || value.environment !== this.environment || typeof value.revision !== 'string' || !/^[a-f0-9-]{36}$/.test(value.revision) || typeof value.keyId !== 'string') throw new ConfigRefreshError('Configuration identity mismatch');
    const key = this.keys.get(value.keyId); if (!key) throw new ConfigRefreshError('Untrusted configuration key');
    const signature = decode(response.headers.get('x-userfn-signature') ?? ''); if (signature.length !== 64) throw new ConfigRefreshError('Invalid configuration signature');
    const subtle = globalThis.crypto?.subtle; if (!subtle) throw new ConfigRefreshError('WebCrypto is required for signed configuration');
    const publicKey = await subtle.importKey('spki', new Uint8Array(key), { name: 'Ed25519' }, false, ['verify']);
    if (!await subtle.verify('Ed25519', publicKey, new Uint8Array(signature), raw)) throw new ConfigRefreshError('Invalid configuration signature');
    const digest = Array.from(new Uint8Array(await subtle.digest('SHA-256', raw)), byte => byte.toString(16).padStart(2, '0')).join('');
    const etag = '"' + digest + '"'; if (response.headers.get('etag') !== etag) throw new ConfigRefreshError('Configuration ETag mismatch');
    if (!Array.isArray(value.flags) || value.flags.length > 1000) throw new ConfigRefreshError('Invalid configuration flags');
    validateFlagDefinitions(value.flags); validateConfigSegments(value.segments);
    return { value: { flags: value.flags, segments: value.segments }, etag };
  }
}

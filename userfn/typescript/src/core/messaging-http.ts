import { v4 as uuidv4 } from 'uuid';
import type { UserFnOptions } from '../types';
export interface MessageStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; }
export interface DurableMessagingOptions { storageKey: string; storage?: MessageStorage; /** Explicit local-test opt-in; bearer credentials otherwise require HTTPS. */ allowInsecureHttp?: boolean; }
type Entry = { key: string; phase: 'pending' | 'presenting' | 'shown'; user: string };
type Journal = Record<string, Entry>;
export class MessagingDeliveryError extends Error {}
/** One bounded durable journal per authenticated browser session; the service owns caps. */
export class HttpMessaging {
  private storage: MessageStorage;
  private storageKey: string;
  private endpoint: string;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private options: UserFnOptions) {
    const config = options.messaging!;
    if (!config.storageKey || config.storageKey.length > 200) throw new TypeError('Messaging storageKey is required');
    const url = new URL(options.endpoint ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !options.apiKey.trim() || (url.protocol === 'http:' && config.allowInsecureHttp !== true)) throw new TypeError('Messaging requires HTTPS (or explicit local HTTP opt-in), endpoint and credential');
    this.endpoint = url.toString().replace(/\/$/, '');
    this.storageKey = 'userfn.messages.' + config.storageKey;
    this.storage = config.storage ?? globalThis.localStorage;
    if (!this.storage) throw new TypeError('Durable messaging storage is required');
  }
  private read(): Journal {
    const raw = this.storage.getItem(this.storageKey);
    if (!raw) return Object.create(null) as Journal;
    if (raw.length > 65536) throw new MessagingDeliveryError('Messaging journal exceeds bounds');
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 100) throw new MessagingDeliveryError('Invalid messaging journal');
    for (const [id, entry] of Object.entries(value)) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !entry || typeof entry !== 'object' || typeof entry.key !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(entry.key) || !['pending', 'presenting', 'shown'].includes(entry.phase) || typeof entry.user !== 'string' || entry.user.length > 200) throw new MessagingDeliveryError('Invalid messaging journal');
    }
    return Object.assign(Object.create(null), value) as Journal;
  }
  private save(value: Journal) { const raw = JSON.stringify(value); if (Object.keys(value).length > 100 || raw.length > 65536) throw new MessagingDeliveryError('Messaging journal full'); this.storage.setItem(this.storageKey, raw); }
  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const run = async () => {
      if (typeof window !== 'undefined') {
        if (!navigator.locks) throw new MessagingDeliveryError('Durable browser messaging requires Web Locks');
        return navigator.locks.request(this.storageKey, action);
      }
      return action();
    };
    const result = this.serial.then(run, run); this.serial = result.catch(() => {}); return result;
  }
  private async send(id: string, key: string, action: 'reserve' | 'shown') {
    const response = await fetch(`${this.endpoint}/messages/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json', 'idempotency-key': key }, body: '{}', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) { await response.body?.cancel(); throw new MessagingDeliveryError(`Messaging request failed: ${response.status}`); }
    const reader = response.body?.getReader(); if (!reader) throw new MessagingDeliveryError('Empty messaging receipt');
    let text = ''; const decoder = new TextDecoder(); let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 8192) throw new MessagingDeliveryError('Oversized messaging receipt'); text += decoder.decode(part.value, { stream: true }); } } finally { await reader.cancel().catch(() => {}); }
    const value: unknown = JSON.parse(text + decoder.decode());
    if (!value || typeof value !== 'object' || !('campaignId' in value) || value.campaignId !== id || !('allowed' in value) || typeof value.allowed !== 'boolean' || !('shown' in value) || typeof value.shown !== 'boolean') throw new MessagingDeliveryError('Invalid messaging receipt');
    const expiresAt = 'expiresAt' in value ? value.expiresAt : undefined;
    if (expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt < 0 || expiresAt > 8640000000000000)) throw new MessagingDeliveryError('Invalid reservation expiry');
    return { allowed: value.allowed, shown: value.shown, expiresAt: expiresAt as number | undefined };
  }
  async present(id: string, user: string, allowed: () => boolean, render: () => boolean, requireExpiry = false): Promise<'denied' | void> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !user || user.length > 200) throw new MessagingDeliveryError('Invalid campaign identity');
    const journal = this.read(); let entry = journal[id];
    if (entry && entry.user !== user) throw new MessagingDeliveryError('Messaging journal belongs to another user; use a distinct storageKey');
    if (entry?.phase === 'presenting') return; // Presentation may have happened before a crash; never repeat it.
    if (entry?.phase === 'shown') {
      await this.send(id, entry.key, 'shown'); delete journal[id]; this.save(journal); return;
    }
    entry ??= { key: uuidv4(), phase: 'pending', user }; journal[id] = entry; this.save(journal);
    const receipt = await this.send(id, entry.key, 'reserve');
    if (!receipt.allowed || receipt.shown) { delete journal[id]; this.save(journal); return receipt.allowed ? undefined : 'denied'; }
    if (requireExpiry && receipt.expiresAt === undefined) throw new MessagingDeliveryError('Temporal campaigns require reservation expiry');
    const current = () => allowed() && (receipt.expiresAt === undefined || Date.now() < receipt.expiresAt);
    if (!current()) return;
    entry.phase = 'presenting'; this.save(journal); // Durable fence precedes the UI side effect.
    if (!current() || !render()) return;
    entry.phase = 'shown'; this.save(journal);
    await this.send(id, entry.key, 'shown'); delete journal[id]; this.save(journal);
  }
  status(): Record<string, string> { return Object.fromEntries(Object.entries(this.read()).map(([id, entry]) => [id, entry.phase === 'presenting' ? 'uncertain' : entry.phase])); }
}

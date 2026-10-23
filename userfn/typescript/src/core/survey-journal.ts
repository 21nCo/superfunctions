import { v4 as uuidv4 } from 'uuid';
import type { SurveyReceipt, SurveyResponse, UserFnOptions } from '../types';
import type { MessageStorage } from './messaging-http';
import { canonicalJson } from '../utils/json';
import { SurveyDeliveryError } from './surveys-http';

export interface SurveyJournalOptions { storageKey: string; storage?: MessageStorage; }
type Entry = { count: number; pending?: { key: string; response: SurveyResponse } };
type Journal = { version: 1; scope: string; entries: Record<string, Entry> };
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const fail = () => new SurveyDeliveryError('Survey journal is invalid, unavailable, or belongs to another credential scope');

/** Browser-only, opt-in persistence. Web Locks serialize all cooperating tabs. */
export class SurveyJournal {
  private readonly key: string;
  private readonly storage: MessageStorage;
  private readonly scopeInput: string;
  constructor(options: UserFnOptions) {
    const config = options.surveyJournal!;
    if (typeof config.storageKey !== 'string' || !config.storageKey || config.storageKey.length > 200 || !options.endpoint) throw fail();
    this.key = 'userfn.surveys.' + config.storageKey;
    this.storage = config.storage ?? globalThis.localStorage;
    if (!this.storage) throw fail();
    this.scopeInput = JSON.stringify([new URL(options.endpoint).toString().replace(/\/$/, ''), options.apiKey]);
  }
  private async exclusive<T>(action: (value: Journal) => Promise<T> | T): Promise<T> {
    if (typeof navigator === 'undefined' || !navigator.locks || !globalThis.crypto?.subtle) throw fail();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.scopeInput));
    const scope = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    return navigator.locks.request(this.key, async () => {
      const raw = this.storage.getItem(this.key);
      let value: Journal = { version: 1, scope, entries: Object.create(null) };
      if (raw !== null) {
        if (bytes(raw) > 262144) throw fail();
        try { value = JSON.parse(raw); } catch { throw fail(); }
        if (!value || value.version !== 1 || value.scope !== scope || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries) || Object.keys(value.entries).length > 100) throw fail();
        for (const [owner, entry] of Object.entries(value.entries)) {
          let parts: unknown; try { parts = JSON.parse(owner); } catch { throw fail(); }
          if (!Array.isArray(parts) || parts.length !== 2 || parts.some(part => typeof part !== 'string' || !part || part.length > 200) ||
              !entry || typeof entry !== 'object' || !Number.isSafeInteger(entry.count) || entry.count < 0) throw fail();
          if (Object.prototype.hasOwnProperty.call(entry, 'pending')) {
            if (!entry.pending || typeof entry.pending !== 'object' || Array.isArray(entry.pending)) throw fail();
            const { key, response } = entry.pending;
            if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(key) || !response || response.surveyId !== parts[1] || !Array.isArray(response.answers) || response.answers.length > 100 || !Number.isSafeInteger(response.submittedAt) || response.submittedAt < 0 || bytes(canonicalJson({ answers: response.answers })) > 65536) throw fail();
          }
        }
      }
      return action(value);
    });
  }
  private save(value: Journal): void {
    const raw = canonicalJson(value);
    if (Object.keys(value.entries).length > 100 || bytes(raw) > 262144) throw new SurveyDeliveryError('Survey journal capacity reached');
    this.storage.setItem(this.key, raw);
  }
  async snapshot(user: string): Promise<Record<string, Entry>> {
    if (!user || user.length > 200) throw fail();
    return this.exclusive(value => Object.fromEntries(Object.entries(value.entries).filter(([owner]) => JSON.parse(owner)[0] === user)));
  }
  async submit(owner: string, expectedCount: number, response: SurveyResponse, valid: () => boolean,
    send: (response: SurveyResponse, key: string) => Promise<SurveyReceipt>): Promise<{ count: number; stored: boolean }> {
    return this.exclusive(async value => {
      const entry = value.entries[owner] ?? { count: 0 };
      // A second tab may already have completed the response visible in this form.
      if (!valid() || entry.count !== expectedCount) return { count: entry.count, stored: false };
      if (entry.count === Number.MAX_SAFE_INTEGER) throw new SurveyDeliveryError('Survey response count capacity reached');
      if (!entry.pending) {
        const raw = canonicalJson({ answers: response.answers });
        if (bytes(raw) > 65536 || response.answers.length > 100) throw new SurveyDeliveryError('Survey response exceeds bounds');
        entry.pending = { key: uuidv4(), response: { surveyId: response.surveyId, answers: JSON.parse(raw).answers, submittedAt: response.submittedAt } };
        value.entries[owner] = entry;
        this.save(value); // Storage failure must prevent the first network request.
      }
      await send(entry.pending.response, entry.pending.key);
      entry.count++;
      delete entry.pending;
      this.save(value); // A failed acknowledgement write leaves the persisted key retryable.
      return { count: entry.count, stored: true };
    });
  }
}

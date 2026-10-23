import { afterEach, expect, it, vi } from 'vitest';
import { UserFnClient } from '../index';
import type { SurveyResponse } from '../types';
const response = (): SurveyResponse => ({ surveyId: 'survey', answers: [{ questionId: 'q', value: 8 }], submittedAt: 1 });
const receipt = { id: 'a'.repeat(64), surveyId: 'survey', submittedAt: 1234, accepted: true };
function client(durable = true) {
  const value = new UserFnClient({ apiKey: 'original-user-credential', ...(durable ? { endpoint: 'https://service.example', surveyMaxAttempts: 3 } : {}) });
  const renders: { submit: (value: SurveyResponse) => Promise<unknown>; pending?: SurveyResponse; dismiss: () => void }[] = [];
  (value as any).renderer = { renderSurvey: (_survey: unknown, submit: (value: SurveyResponse) => Promise<unknown>, dismiss: () => void, pending?: SurveyResponse) => renders.push({ submit, dismiss, pending }), dismissMessages: vi.fn(), dismissSurveys: vi.fn() };
  value.setSurveys([{ id: 'survey', enabled: true, questions: [{ id: 'q', title: 'Score', type: 'nps' }], triggers: [{ type: 'event' }], caps: { global: 2 } }]);
  value.identify('alice');
  return { value, renders, record: vi.spyOn((value as any).surveys, 'trackResponse') };
}
afterEach(() => { vi.unstubAllGlobals(); });
it('retains immutable answers/key after unknown delivery and same-owner dismissal/reopen', async () => {
  const calls: RequestInit[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => { calls.push(init); if (calls.length === 1) throw new TypeError('lost acknowledgement'); return new Response(JSON.stringify(receipt)); }));
  const { value, renders, record } = client(); await value.trigger('event', 'open');
  const original = response(); await expect(renders[0].submit(original)).rejects.toThrow();
  expect(calls).toHaveLength(1); expect(record).not.toHaveBeenCalled();
  original.answers[0].value = 1; renders[0].dismiss(); await value.trigger('event', 'open');
  expect(renders[1].pending?.answers[0].value).toBe(8);
  expect(await renders[1].submit(original)).toBe('stored');
  expect(calls[0].body).toBe(calls[1].body); expect(calls[0].headers).toEqual(calls[1].headers);
  expect(record).toHaveBeenCalledTimes(1); expect(record.mock.calls[0][0]).toMatchObject({ submittedAt: 1234, answers: [{ questionId: 'q', value: 8 }] });
});
it('deduplicates concurrent callbacks and counts only one acknowledged response', async () => {
  let finish!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal('fetch', fetch);
  const { value, renders, record } = client(); await value.trigger('event', 'open');
  const one = renders[0].submit(response()), two = renders[0].submit(response());
  expect(fetch).toHaveBeenCalledTimes(1); expect(record).not.toHaveBeenCalled();
  finish(new Response(JSON.stringify(receipt)));
  expect(await Promise.all([one, two])).toEqual(['stored', false]); expect(record).toHaveBeenCalledTimes(1);
});
it('fences identity/consent transitions and reconciles late receipt only for original owner', async () => {
  let finish!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal('fetch', fetch);
  const { value, renders, record } = client(); await value.trigger('event', 'open');
  const pending = renders[0].submit(response());
  value.identify('bob'); value.setConsent({ messaging: false });
  finish(new Response(JSON.stringify(receipt)));
  expect(await pending).toBe(false); expect(record).not.toHaveBeenCalled();
  value.setConsent({ messaging: true }); await value.trigger('event', 'open'); expect(renders[1].pending).toBeUndefined();
  value.identify('alice'); await value.trigger('event', 'open'); expect(renders[2].pending).toMatchObject({ surveyId: 'survey', answers: response().answers });
  expect(await renders[0].submit(response())).toBe(false);
  expect(await renders[2].submit(response())).toBe('stored'); expect(fetch).toHaveBeenCalledTimes(1);
  expect((record.mock.calls[0][1] as { id: string }).id).toBe('alice');
});
it('fails closed at retained-attempt capacity and never evicts an uncertain key', async () => {
  const fetch = vi.fn(async () => { throw new TypeError('offline'); }); vi.stubGlobal('fetch', fetch);
  const { value, renders } = client();
  for (let index = 0; index < 100; index++) {
    value.identify('owner-' + index); await value.trigger('event', 'open');
    await expect(renders.at(-1)!.submit(response())).rejects.toThrow('offline');
  }
  value.identify('extra'); await value.trigger('event', 'open');
  await expect(renders.at(-1)!.submit(response())).rejects.toThrow('capacity'); expect(fetch).toHaveBeenCalledTimes(100);
  value.identify('owner-0'); await value.trigger('event', 'open'); expect(renders.at(-1)!.pending?.answers).toEqual(response().answers);
  await expect(renders.at(-1)!.submit(response())).rejects.toThrow('offline'); expect(fetch).toHaveBeenCalledTimes(101);
});
it('preserves local mode without claiming durable storage', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const { value, renders, record } = client(false); await value.trigger('event', 'open');
  expect(await renders[0].submit(response())).toBe('local'); expect(record).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
});

it('submits with cryptographic UUIDs when randomUUID is unavailable', async () => {
  const getRandomValues = vi.fn(crypto.getRandomValues.bind(crypto));
  vi.stubGlobal('crypto', { getRandomValues });
  vi.resetModules();
  const { UserFnClient: CompatibleClient } = await import('../index');
  const { HttpMessaging } = await import('../core/messaging-http');
  const keys: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    keys.push(new Headers(init.headers).get('idempotency-key')!);
    return new Response(JSON.stringify(url.includes('/messages/') ? { campaignId: 'campaign', allowed: false, shown: false } : receipt));
  }));
  const value = new CompatibleClient({ apiKey: 'verified', endpoint: 'https://service.example' });
  let submit!: (value: SurveyResponse) => Promise<unknown>;
  (value as any).renderer = { renderSurvey: (_survey: unknown, callback: typeof submit) => { submit = callback; }, dismissSurveys: vi.fn() };
  value.identify('alice');
  value.setSurveys([{ id: 'survey', enabled: true, questions: [], triggers: [{ type: 'event' }] }]);
  await value.trigger('event', 'open'); await submit(response());
  const data = new Map<string, string>();
  await new HttpMessaging({ apiKey: 'verified', endpoint: 'https://service.example', messaging: { storageKey: 'test', storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } } } }).present('campaign', 'alice', () => true, () => false);
  expect(keys).toHaveLength(2);
  for (const key of keys) expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(keys[0]).not.toBe(keys[1]);
});

import { afterEach, expect, it, vi } from 'vitest';
import { HttpMessaging } from '../core/messaging-http';
import { UserFnClient } from '../index';
const storage = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } }; };
const receipt = (shown = false) => new Response(JSON.stringify({ campaignId: 'campaign', allowed: true, shown }));
afterEach(() => { vi.unstubAllGlobals(); });
it('replays lost admission ACK after reconstruction and fences uncertain presentation', async () => {
  const shared = storage(); const options = { apiKey: 'verified', endpoint: 'https://user.example', messaging: { storageKey: 'session', storage: shared } };
  const keys: string[] = []; let fail = true;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { keys.push(new Headers(init.headers).get('idempotency-key')!); if (fail) throw new Error('lost ACK'); return receipt(); }));
  const first = new HttpMessaging(options); const render = vi.fn(() => false);
  await expect(first.present('campaign', 'local', () => true, render)).rejects.toThrow('lost ACK');
  expect(first.status()).toEqual({ campaign: 'pending' }); fail = false;
  const second = new HttpMessaging(options); await second.present('campaign', 'local', () => true, render);
  expect(keys[0]).toBe(keys[1]); expect(render).toHaveBeenCalledTimes(1); expect(second.status()).toEqual({ campaign: 'uncertain' });
  await new HttpMessaging(options).present('campaign', 'local', () => true, render); expect(render).toHaveBeenCalledTimes(1);
});
it('persists shown before reporting and reconciles an unacknowledged shown receipt without rerender', async () => {
  const shared = storage(); const options = { apiKey: 'verified', endpoint: 'https://user.example', messaging: { storageKey: 'session', storage: shared } };
  let failed = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { if (url.endsWith('/shown') && !failed) { failed = true; throw new Error('lost shown'); } return receipt(url.endsWith('/shown')); }));
  const render = vi.fn(() => true); const client = new HttpMessaging(options);
  await expect(client.present('campaign', 'local', () => true, render)).rejects.toThrow('lost shown'); expect(client.status()).toEqual({ campaign: 'shown' });
  await new HttpMessaging(options).present('campaign', 'local', () => true, render);
  expect(render).toHaveBeenCalledTimes(1); expect(client.status()).toEqual({});
});
it('does not render on malformed admission and refuses unsupported capped local delivery', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  const client = new HttpMessaging({ apiKey: 'verified', endpoint: 'https://user.example', messaging: { storageKey: 'session', storage: storage() } });
  const render = vi.fn(() => true); await expect(client.present('campaign', 'local', () => true, render)).rejects.toThrow('Invalid messaging receipt'); expect(render).not.toHaveBeenCalled();
  const local = new UserFnClient({ apiKey: 'unused' }); local.identify('local'); local.setCampaigns([{ id: 'campaign', kind: 'modal', enabled: true, content: { body: 'once' }, triggers: [{ type: 'event' }], caps: { session: 1 } }]);
  await expect(local.trigger('event', 'show')).rejects.toThrow('durable messaging');
});
it('fences withdrawal and regrant while an admission response is pending', async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  const client = new UserFnClient({ apiKey: 'verified', endpoint: 'https://user.example', messaging: { storageKey: 'session', storage: storage() } });
  client.identify('local'); client.setCampaigns([{ id: 'campaign', kind: 'modal', enabled: true, content: { body: 'once' }, triggers: [{ type: 'event' }], caps: { perUser: 1 } }]);
  const pending = client.trigger('event', 'show'); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  client.setConsent({ messaging: false }); client.setConsent({ messaging: true }); resolve(receipt()); await pending;
  expect(client.getMessageDeliveryStatus()).toEqual({ campaign: 'pending' });
});

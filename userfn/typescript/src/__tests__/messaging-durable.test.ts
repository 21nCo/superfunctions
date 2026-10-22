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
it('continues past server-denied priority campaigns without starving eligible campaigns', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const id = url.includes('/high/') ? 'high' : 'low'; requests.push(id);
    return new Response(JSON.stringify({ campaignId: id, allowed: id === 'low', shown: url.endsWith('/shown') }));
  }));
  const client = new UserFnClient({ apiKey: 'verified', endpoint: 'https://user.example', messaging: { storageKey: 'session', storage: storage() } });
  client.identify('local');
  client.setCampaigns(['high', 'low'].map((id, index) => ({ id, priority: 10 - index, kind: 'modal' as const, enabled: true, content: { body: id }, triggers: [{ type: 'event' as const }], caps: { perUser: 1 } })));
  const render = vi.fn(); (client as any).renderer = { render };
  await client.trigger('event', 'show');
  expect(render).toHaveBeenCalledOnce(); expect(render.mock.calls[0][0].id).toBe('low');
  expect(requests).toEqual(['high', 'low', 'low']);
});
it.each(['identity', 'consent'])('does not try another campaign after %s changes during a denial', async change => {
  const requests: string[] = [];
  const client = new UserFnClient({ apiKey: 'verified', endpoint: 'https://user.example', messaging: { storageKey: 'session', storage: storage() } });
  client.identify('local');
  client.setCampaigns(['high', 'low'].map((id, index) => ({ id, priority: 10-index, kind: 'modal' as const, enabled: true, content: { body: id }, triggers: [{ type: 'event' as const }] })));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(url);
    if (change === 'identity') client.identify('other'); else client.setConsent({ messaging: false });
    return new Response(JSON.stringify({ campaignId: 'high', allowed: false, shown: false }));
  }));
  await client.trigger('event', 'show');
  expect(requests).toHaveLength(1);
});
it('checks consent again after writing the durable presentation fence', async () => {
  let allowed = true;
  const shared = storage();
  const client = new HttpMessaging({ apiKey: 'verified', endpoint: 'https://user.example', messaging: { storageKey: 'session', storage: {
    getItem: shared.getItem,
    setItem(key, value) { shared.setItem(key, value); if (value.includes('presenting')) allowed = false; },
  } } });
  vi.stubGlobal('fetch', vi.fn(async () => receipt()));
  const render = vi.fn(() => true);
  await client.present('campaign', 'local', () => allowed, render);
  expect(render).not.toHaveBeenCalled();
  expect(client.status()).toEqual({ campaign: 'uncertain' });
});
it('requires HTTPS unless messaging explicitly opts into insecure local HTTP', () => {
  const options = { apiKey: 'secret', endpoint: 'http://127.0.0.1:4321', messaging: { storageKey: 'session', storage: storage() } };
  const send = vi.fn(); vi.stubGlobal('fetch', send);
  expect(() => new HttpMessaging(options)).toThrow(/HTTPS/);
  expect(() => new HttpMessaging({ ...options, messaging: { ...options.messaging, allowInsecureHttp: false } })).toThrow(/HTTPS/);
  expect(() => new HttpMessaging({ ...options, messaging: { ...options.messaging, allowInsecureHttp: true } })).not.toThrow();
  expect(() => new HttpMessaging({ ...options, endpoint: 'https://user.example' })).not.toThrow();
  expect(send).not.toHaveBeenCalled();
});

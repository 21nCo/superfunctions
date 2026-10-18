import { afterEach, expect, it, vi } from 'vitest';
import { sinkHttp } from './http.js';
import type { LogEvent } from '../types.js';
const event: LogEvent = { ts: '2026-10-18T00:00:00Z', level: 'info', msg: 'message', name: 'test', version: '0' };
function browser() {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
  const beacon = vi.fn(() => true);
  vi.stubGlobal('window', window); vi.stubGlobal('document', document);
  vi.stubGlobal('navigator', { sendBeacon: beacon });
  return { window, document, beacon };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('close drains and removes listeners and rejects future events', async () => {
  const { window, document } = browser();
  const removeWindow = vi.spyOn(window, 'removeEventListener');
  const removeDocument = vi.spyOn(document, 'removeEventListener');
  const fetch = vi.fn(async () => new Response(null, { status: 202 })); vi.stubGlobal('fetch', fetch);
  const sink = sinkHttp({ url: 'https://example.test' });
  sink([event]); await sink.close(); await sink.close();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(removeWindow).toHaveBeenCalledTimes(1); expect(removeDocument).toHaveBeenCalledTimes(1);
  expect(() => sink([event])).toThrow('closed');
  document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('beforeunload'));
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('keeps failed close retryable', async () => {
  browser();
  const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetch);
  const sink = sinkHttp({ url: 'https://example.test', retry: { attempts: 1 } });
  sink([event]); await expect(sink.close()).rejects.toThrow('503');
  await sink.close(); expect(fetch).toHaveBeenCalledTimes(2);
});
it('uses authenticated keepalive fetch instead of a headerless beacon', async () => {
  const { window, beacon } = browser();
  const fetch = vi.fn(async () => new Response(null, { status: 202 })); vi.stubGlobal('fetch', fetch);
  const sink = sinkHttp({ url: 'https://example.test', auth: { token: 'secret' } });
  sink([event]); window.dispatchEvent(new Event('beforeunload')); await sink.close();
  expect(beacon).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledWith('https://example.test', expect.objectContaining({ keepalive: true, headers: expect.objectContaining({ Authorization: 'Bearer secret' }) }));
});
it('flushes on document visibility change', async () => {
  const { document } = browser();
  const fetch = vi.fn(async () => new Response(null, { status: 202 })); vi.stubGlobal('fetch', fetch);
  const sink = sinkHttp({ url: 'https://example.test' });
  sink([event]); document.dispatchEvent(new Event('visibilitychange'));
  expect(fetch).toHaveBeenCalledTimes(1); await sink.close();
});
it('bounds beacon payload and retains events until confirmed HTTP delivery', async () => {
  const { window, beacon } = browser();
  const fetch = vi.fn(async () => new Response(null, { status: 202 })); vi.stubGlobal('fetch', fetch);
  const sink = sinkHttp({ url: 'https://example.test', batch: 10 });
  sink(Array.from({ length: 3 }, () => ({ ...event, msg: '🙂'.repeat(7000) })));
  window.dispatchEvent(new Event('beforeunload'));
  expect(beacon).toHaveBeenCalledTimes(1);
  const blob = (beacon.mock.calls[0] as unknown as [string, Blob])[1];
  expect(blob.size).toBeLessThanOrEqual(60000);
  expect(JSON.parse(await blob.text()).events).toHaveLength(2);
  await sink.close();
  const request = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(request[1].body as string).events).toHaveLength(3);
});
it('falls back to fetch when beacon rejects its queue', async () => {
  const { window, beacon } = browser(); beacon.mockReturnValue(false);
  const fetch = vi.fn(async () => new Response(null, { status: 202 })); vi.stubGlobal('fetch', fetch);
  const sink = sinkHttp({ url: 'https://example.test' });
  sink([event]); window.dispatchEvent(new Event('beforeunload')); await sink.close();
  expect(fetch).toHaveBeenCalledWith('https://example.test', expect.objectContaining({ keepalive: true }));
});

import { afterEach, expect, it, vi } from 'vitest';
import { subscribeToDoc } from '../realtime/subscribe.js';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('uses scoped credentialed SSE without tokens and ignores foreign/missing identities and closed events', async () => {
  vi.useFakeTimers();
  let source!: { onmessage: ((event: { data: string }) => void) | null; close: () => void };
  const constructed: unknown[] = [];
  vi.stubGlobal('EventSource', class { onmessage = null; close = vi.fn(); constructor(...args: unknown[]) { constructed.push(args); source = this; } });
  const update = vi.fn(); const stop = subscribeToDoc({ realtimeUrl: 'https://api.test/contentfn/events', dataset: 'prod', docId: 'one', onUpdate: update });
  expect(constructed).toEqual([['https://api.test/contentfn/events?dataset=prod&docId=one', { withCredentials: true }]]);
  for (const event of [{ dataset: 'staging', document: { _id: 'one' } }, { dataset: 'prod', document: { _id: 'other' } }, { dataset: 'prod' }]) source.onmessage?.({ data: JSON.stringify({ type: 'event', ...event }) });
  await vi.advanceTimersByTimeAsync(600); expect(update).not.toHaveBeenCalled();
  source.onmessage?.({ data: JSON.stringify({ type: 'event', dataset: 'prod', document: { _id: 'drafts.one' } }) });
  await vi.advanceTimersByTimeAsync(600); expect(update).toHaveBeenCalledTimes(1);
  stop(); source.onmessage?.({ data: JSON.stringify({ type: 'event', dataset: 'prod', document: { _id: 'one' } }) });
  await vi.advanceTimersByTimeAsync(600); expect(update).toHaveBeenCalledTimes(1); expect(source.close).toHaveBeenCalled();
  for (const key of ['token', 'TOKEN', 'accessToken', 'access_token', 'api_key', 'Api-Key', 'Authorization', 'cmsfn_preview_token', 'AUTH', 'bearer']) subscribeToDoc({ realtimeUrl: `https://api.test/contentfn/events?${key}=private`, dataset: 'prod', docId: 'one', onUpdate: update });
  expect(constructed).toHaveLength(1);
});

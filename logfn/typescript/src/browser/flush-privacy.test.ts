import { afterEach, expect, it, vi } from 'vitest';
import { attachFlushHooks } from './error-capture.js';
import { sinkHttp } from '../sinks/http.js';
import type { Logger } from '../core/logger.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('does not print rejected sink contents from visibility flush hooks', async () => {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
  vi.stubGlobal('window', window); vi.stubGlobal('document', document);
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const flush = vi.fn(async () => { throw { password: 'visibility-secret', requestBody: 'private' }; });
  const cleanup = attachFlushHooks({ flush } as unknown as Logger);
  try {
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(stderr).toHaveBeenCalledExactlyOnceWith('[logfn] Failed to flush on visibility change');
    cleanup();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(flush).toHaveBeenCalledTimes(1);
  } finally { cleanup(); }
});

it.each(['network error', 'server status text'])('keeps %s out of background diagnostics while retaining failed events', async mode => {
  const failure = new Error('Authorization: Bearer transport-secret');
  const fetch = vi.fn(async () => {
    if (mode === 'network error') throw failure;
    return new Response(null, { status: 503, statusText: 'password=server-secret' });
  });
  vi.stubGlobal('fetch', fetch);
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const sink = sinkHttp({ url: 'https://example.test', batch: 1, retry: { attempts: 1 } });
  try {
    sink([{ ts: '2026-10-23T00:00:00Z', level: 'info', msg: 'retained', name: 'privacy', version: '0' }]);
    await expect(sink.flush!()).rejects.toThrow(mode === 'network error' ? 'transport-secret' : 'server-secret');
    expect(stderr).toHaveBeenCalledExactlyOnceWith('[logfn http-sink error] Background delivery failed');
  } finally {
    fetch.mockImplementation(async () => new Response(null, { status: 202 }));
    await sink.close();
  }
  expect(fetch).toHaveBeenCalledTimes(2);
  const request = fetch.mock.calls[1] as unknown as [string, RequestInit];
  expect(JSON.parse(request[1].body as string).events[0].msg).toBe('retained');
});

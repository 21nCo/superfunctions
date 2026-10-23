import { afterEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { PreviewPane } from '../panes/preview/PreviewPane.js';
const origin = 'https://preview.test';
const doc = { _id: 'drafts.one', _type: 'post' };
const tokenResponse = (id = 'one', expiresAt = new Date(Date.now() + 60_000).toISOString()) => new Response(JSON.stringify({ ok: true, result: { token: `token-${id}`, expiresAt, dataset: 'prod', docIds: [id], audience: origin } }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('rejects a resolved cross-origin URL before requesting or disclosing a preview token', async () => {
  const fetcher = vi.fn(async () => tokenResponse()); vi.stubGlobal('fetch', fetcher);
  render(<PreviewPane previewEnabled targetOrigin={origin} resolveUrl={() => 'https://untrusted.test/preview'} cmsfnApiUrl="http://cms" dataset="prod" doc={doc} />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(fetcher).not.toHaveBeenCalled(); expect(document.querySelector('iframe')).toBeNull();
});
it('clears the previous scoped token immediately while the next document token is pending', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => JSON.parse(String(init.body)).docId.replace(/^drafts\./, '') === 'one' ? tokenResponse() : new Promise<Response>(() => {})));
  const props = { previewEnabled: true, targetOrigin: origin, resolveUrl: (value: unknown) => `${origin}/${(value as { _id: string })._id}`, cmsfnApiUrl: 'http://cms', dataset: 'prod' };
  const view = render(<PreviewPane {...props} doc={doc} />); await screen.findByTitle('Preview');
  view.rerender(<PreviewPane {...props} doc={{ _id: 'drafts.two', _type: 'post' }} />);
  expect(document.querySelector('iframe')).toBeNull();
});
it('refuses an already expired preview token', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => tokenResponse('one', new Date(Date.now() - 1000).toISOString())));
  render(<PreviewPane previewEnabled targetOrigin={origin} resolveUrl={() => `${origin}/one`} cmsfnApiUrl="http://cms" dataset="prod" doc={doc} />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(document.querySelector('iframe')).toBeNull();
});
it('handles token transport rejection and late previous-scope completions without an iframe', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw Error('private transport detail'); }));
  const view = render(<PreviewPane previewEnabled targetOrigin={origin} resolveUrl={() => `${origin}/one`} cmsfnApiUrl="http://cms" dataset="prod" doc={doc} />);
  await screen.findByText('Failed to load a valid preview token.'); expect(document.querySelector('iframe')).toBeNull();
  view.unmount();
  let finish!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async () => new Promise<Response>(resolve => { finish = resolve; })));
  const props = { previewEnabled: true, targetOrigin: origin, resolveUrl: () => `${origin}/one`, cmsfnApiUrl: 'http://cms', dataset: 'prod', doc };
  const second = render(<PreviewPane {...props} />);
  second.rerender(<PreviewPane {...props} previewEnabled={false} />);
  await act(async () => finish(tokenResponse())); expect(document.querySelector('iframe')).toBeNull();
});
it('renews tokens before expiry and removes the frame when renewal fails', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValueOnce(tokenResponse('one', new Date(Date.now() + 2000).toISOString())).mockRejectedValueOnce(Error('offline'));
  vi.stubGlobal('fetch', fetcher);
  render(<PreviewPane previewEnabled targetOrigin={origin} resolveUrl={() => `${origin}/one`} cmsfnApiUrl="http://cms" dataset="prod" doc={doc} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(document.querySelector('iframe')).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
  expect(fetcher).toHaveBeenCalledTimes(2); expect(document.querySelector('iframe')).toBeNull();
});
it('bounds an abort-ignoring renewal and never retains an expired frame', async () => {
  vi.useFakeTimers();
  let finish!: (value: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(tokenResponse()).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  render(<PreviewPane previewEnabled targetOrigin={origin} resolveUrl={() => `${origin}/one`} cmsfnApiUrl="http://cms" dataset="prod" doc={doc} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(document.querySelector('iframe')).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(55_001); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][1].redirect).toBe('error');
  expect(document.querySelector('iframe')).toBeNull();
  await act(async () => { finish(tokenResponse()); await vi.advanceTimersByTimeAsync(10_000); });
  expect(document.querySelector('iframe')).toBeNull();
});

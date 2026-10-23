import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CmsfnStudioConfig } from 'cmsfn';
import { App } from '../app.js';
import { EventsPane } from '../panes/audit/EventsPane.js';
const config: CmsfnStudioConfig = { contentfn: { baseUrl: 'http://content.test' }, cmsfn: { apiUrl: 'http://cms.test' }, datasets: [{ name: 'prod' }, { name: 'staging' }], auth: { kind: 'custom' }, desk: { kind: 'divider' } };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const event = (id: string, dataset = 'prod') => ({ eventId: id, dataset, type: id, timestamp: '2026-10-23T00:00:00Z' });
const page = (id: string, cursor: string | null = null, dataset = 'prod') => ({ ok: true, result: { events: [event(id, dataset)], nextCursor: cursor } });
afterEach(() => vi.unstubAllGlobals());
it('connects audit navigation and resets dataset-scoped cursors', async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { const body = JSON.parse(String(init.body)) as { dataset: string; cursor?: string }; bodies.push(body); return response(page(body.dataset, body.cursor ? null : 'next', body.dataset)); }));
  render(<App config={config} />); fireEvent.click(screen.getByRole('button', { name: 'Audit events' }));
  await waitFor(() => expect(document.querySelector('[data-audit-event-type]')?.textContent).toBe('prod')); fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await waitFor(() => expect(bodies).toHaveLength(2));
  fireEvent.change(screen.getByRole('combobox', { name: 'Select dataset' }), { target: { value: 'staging' } });
  await waitFor(() => expect(document.querySelector('[data-audit-event-type]')?.textContent).toBe('staging'));
  expect(bodies).toEqual([{ dataset: 'prod', limit: 20 }, { dataset: 'prod', limit: 20, cursor: 'next' }, { dataset: 'staging', limit: 20 }]);
  expect(document.querySelectorAll('[data-audit-event]')).toHaveLength(1);
});
it('does not fetch without configured CMS API', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  render(<App config={{ ...config, cmsfn: undefined }} />); fireEvent.click(screen.getByRole('button', { name: 'Audit events' }));
  expect(await screen.findByText('Audit requires a configured CmsFn API.')).toBeTruthy(); expect(fetcher).not.toHaveBeenCalled();
});
it('ignores late dataset responses even when a transport ignores cancellation', async () => {
  let finish!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => String(init.body).includes('prod') ? new Promise<Response>(resolve => { finish = resolve; }) : response(page('stage-result', null, 'staging'))));
  const rendered = render(<EventsPane cmsfnApiUrl="http://cms.test" dataset="prod" />);
  rendered.rerender(<EventsPane cmsfnApiUrl="http://cms.test" dataset="staging" />); await screen.findByText('stage-result');
  await act(async () => finish(response(page('private-old-result'))));
  expect(screen.queryByText('private-old-result')).toBeNull(); expect(screen.getByText('stage-result')).toBeTruthy();
});
it('server denial on a later page clears prior metadata and cursor', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(page('visible', 'next'))).mockResolvedValueOnce(response({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'private error' } })));
  render(<EventsPane cmsfnApiUrl="http://cms.test" dataset="prod" />); await screen.findByText('visible'); fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByText('No access'); expect(screen.queryByText('visible')).toBeNull(); expect(screen.queryByText('private error')).toBeNull(); expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
});
it('retries a failed page without dropping or duplicating preceding records', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response(page('first', 'next'))).mockRejectedValueOnce(new Error('secret')).mockResolvedValueOnce(response(page('second'))); vi.stubGlobal('fetch', fetcher);
  render(<EventsPane cmsfnApiUrl="http://cms.test" dataset="prod" />); await screen.findByText('first'); fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByRole('alert'); fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await screen.findByText('second'); expect(document.querySelectorAll('[data-audit-event]')).toHaveLength(2);
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toMatchObject({ cursor: 'next' });
});
it.each([
  { ok: true, result: { events: [event('wrong', 'other')], nextCursor: null } },
  { ok: true, result: { events: [{ ...event('bad'), targetIds: [42] }], nextCursor: null } },
  { ok: true, result: {} },
])('rejects malformed metadata instead of treating it as empty success', async body => {
  vi.stubGlobal('fetch', vi.fn(async () => response(body))); render(<EventsPane cmsfnApiUrl="http://cms.test" dataset="prod" />);
  await screen.findByRole('alert'); expect(document.querySelectorAll('[data-audit-event]')).toHaveLength(0);
});

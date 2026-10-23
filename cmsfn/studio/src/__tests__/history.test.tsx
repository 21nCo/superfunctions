import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HistoryPane } from '../panes/history/HistoryPane.js';
const revision = (rev: string, title = rev) => ({ _id: 'drafts.post', _type: 'post', _rev: rev, _updatedAt: '2026-10-23T00:00:00.000Z', title });
const page = (rows: unknown[], next: string | null = null) => new Response(JSON.stringify({ ok: true, result: { revisions: rows, nextCursor: next } }));
afterEach(() => vi.unstubAllGlobals());
it('loads only when opened, preserves producer ordering and renders full paginated snapshots', async () => {
  const calls: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { const input = JSON.parse(String(init.body)); calls.push(input); return input.cursor ? page([revision('old')]) : page([revision('new'), revision('middle')], 'next'); }));
  render(<HistoryPane baseUrl="http://content" dataset="prod" docId="post" />);
  expect(calls).toHaveLength(0); fireEvent.click(screen.getByRole('button', { name: 'History', exact: true }));
  await screen.findByText(/drafts.post — new/);
  expect([...document.querySelectorAll('[data-history-revision]')].map(row => row.getAttribute('data-history-revision'))).toEqual(['new', 'middle']);
  expect(document.querySelector('pre')?.textContent).toContain('"title": "new"');
  fireEvent.click(screen.getByRole('button', { name: 'Older revisions' })); await screen.findByText(/drafts.post — old/);
  expect(calls).toEqual([{ dataset: 'prod', id: 'post', limit: 20, cursor: null }, { dataset: 'prod', id: 'post', limit: 20, cursor: 'next' }]);
});
it('clears snapshots and pagination after permission revocation', async () => {
  let denied = false;
  vi.stubGlobal('fetch', vi.fn(async () => denied ? new Response(JSON.stringify({ ok: false, error: { code: 'PERMISSION_DENIED' } }), { status: 403 }) : page([revision('secret')], 'next')));
  render(<HistoryPane baseUrl="http://content" dataset="prod" docId="post" />); fireEvent.click(screen.getByRole('button', { name: 'History', exact: true }));
  await screen.findByText(/drafts.post — secret/); denied = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh history' })); await screen.findByText('No access to document history.');
  expect(document.querySelector('pre')).toBeNull(); expect(screen.queryByRole('button', { name: 'Older revisions' })).toBeNull();
});
it('discards old dataset responses and resets cursor when scope changes', async () => {
  let finish!: (response: Response) => void;
  const calls: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { const input = JSON.parse(String(init.body)); calls.push(input); return input.dataset === 'prod' ? new Promise<Response>(resolve => { finish = resolve; }) : page([revision('staging')]); }));
  const view = render(<HistoryPane baseUrl="http://content" dataset="prod" docId="post" />); fireEvent.click(screen.getByRole('button', { name: 'History', exact: true }));
  view.rerender(<HistoryPane baseUrl="http://content" dataset="staging" docId="post" />); await screen.findByText(/drafts.post — staging/);
  finish(page([revision('secret')])); await waitFor(() => expect(document.querySelector('pre')?.textContent).toContain('staging'));
  expect(document.querySelector('pre')?.textContent).not.toContain('secret');
  expect(calls).toContainEqual({ dataset: 'staging', id: 'post', limit: 20, cursor: null });
});
it.each(['wrong-id', 'invalid-envelope', 'oversized', 'repeated-cursor'])('rejects %s without rendering revision content', async kind => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    if (kind === 'oversized') return page([revision('secret', 'x'.repeat(2 * 1024 * 1024))]);
    if (kind === 'invalid-envelope') return new Response('{"ok":true,"result":{"revisions":null}}');
    if (kind === 'wrong-id') return page([{ ...revision('secret'), _id: 'other' }]);
    const input = JSON.parse(String(init.body)); return page([revision('secret')], input.cursor ?? 'next');
  }));
  render(<HistoryPane baseUrl="http://content" dataset="prod" docId="post" />); fireEvent.click(screen.getByRole('button', { name: 'History', exact: true }));
  if (kind === 'repeated-cursor') { await screen.findByRole('button', { name: 'Older revisions' }); fireEvent.click(screen.getByRole('button', { name: 'Older revisions' })); }
  await screen.findByRole('alert'); expect(document.querySelector('pre')).toBeNull();
});

it.each([401, 403])('shows no access for empty or HTML HTTP %s responses without parsing JSON', async status => {
  for (const body of ['', '<html>Sign in</html>']) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));
    const view = render(<HistoryPane baseUrl="http://content" dataset="prod" docId="post" />);
    fireEvent.click(screen.getByRole('button', { name: 'History', exact: true }));
    await screen.findByText('No access to document history.'); expect(document.querySelector('pre')).toBeNull();
    view.unmount();
  }
});

it('retries oversized pages at the same cursor with smaller limits without skipping valid large revisions', async () => {
  const snapshots = ['new', 'middle', 'old'].map(rev => revision(rev, 'x'.repeat(800_000)));
  const calls: Array<{ cursor: string | null; limit: number }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const input = JSON.parse(String(init.body)); calls.push({ cursor: input.cursor, limit: input.limit });
    const offset = input.cursor === 'after-two' ? 2 : 0;
    const rows = snapshots.slice(offset, offset + input.limit);
    return page(rows, offset + rows.length < snapshots.length ? 'after-two' : null);
  }));
  render(<HistoryPane baseUrl="http://content" dataset="prod" docId="post" />);
  fireEvent.click(screen.getByRole('button', { name: 'History', exact: true }));
  await screen.findByRole('button', { name: 'Older revisions' });
  expect([...document.querySelectorAll('[data-history-revision]')].map(row => row.getAttribute('data-history-revision'))).toEqual(['new', 'middle']);
  expect(calls).toEqual([20, 10, 5, 2].map(limit => ({ cursor: null, limit })));
  fireEvent.click(screen.getByRole('button', { name: 'Older revisions' }));
  await screen.findByText(/drafts.post — old/);
  expect(calls[calls.length - 1]).toEqual({ cursor: 'after-two', limit: 20 });
  expect(screen.queryByRole('alert')).toBeNull();
});

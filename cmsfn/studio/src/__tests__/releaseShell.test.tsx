import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReleasesPane } from '../panes/releases/ReleasesPane.js';
const release = { releaseId: 'r1', dataset: 'prod', name: 'Launch', docIds: ['a', 'b'], createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z', publishAt: null };
const response = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
afterEach(() => vi.unstubAllGlobals());
it('creates, adds canonical draft IDs, and displays each partial publish outcome', async () => {
  const mutations: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url.endsWith('/list')) return response({ releases: [release] }); mutations.push(body);
    if (url.endsWith('/create')) return response({ releaseId: 'new' });
    if (url.endsWith('/publish')) return response({ releaseId: 'r1', published: ['a'], failures: [{ docId: 'b', code: 'PERMISSION_DENIED', message: 'Workflow state does not allow publish' }] });
    return response({});
  }));
  render(<ReleasesPane cmsfnApiUrl="http://cms.test" dataset="prod" />); await screen.findByText('Launch');
  fireEvent.change(screen.getByLabelText('Release name'), { target: { value: 'New' } }); fireEvent.click(screen.getByRole('button', { name: 'Create release' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh releases' }).hasAttribute('disabled')).toBe(false));
  fireEvent.change(screen.getByLabelText('Draft document ID for Launch'), { target: { value: 'drafts.c' } }); fireEvent.click(screen.getByRole('button', { name: 'Add document' }));
  await waitFor(() => expect(mutations).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Publish release' }).hasAttribute('disabled')).toBe(false)); fireEvent.click(screen.getByRole('button', { name: 'Publish release' }));
  await screen.findByText('Published: 1'); await screen.findByText('b: PERMISSION_DENIED — Workflow state does not allow publish');
  expect(mutations).toEqual([{ dataset: 'prod', name: 'New', publishAt: null }, { dataset: 'prod', releaseId: 'r1', docId: 'c' }, { dataset: 'prod', releaseId: 'r1' }]);
});
it('locks concurrent submit and reports mutation uncertainty without retrying', async () => {
  let fail!: (error: Error) => void; let mutations = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/list') ? response({ releases: [release] }) : (mutations++, new Promise<Response>((_resolve, reject) => { fail = reject; }))));
  render(<ReleasesPane cmsfnApiUrl="http://cms.test" dataset="prod" />); await screen.findByText('Launch');
  fireEvent.click(screen.getByRole('button', { name: 'Publish release' })); fireEvent.click(screen.getByRole('button', { name: 'Publish release' })); expect(mutations).toBe(1);
  await act(async () => fail(new Error('socket lost'))); await screen.findByText(/may have completed/); expect(mutations).toBe(1);
});
it('does not display a previous dataset mutation response in a new session', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => url.endsWith('/list') ? response({ releases: String(init.body).includes('prod') ? [release] : [] }) : new Promise<Response>(resolve => { finish = resolve; })));
  const view = render(<ReleasesPane cmsfnApiUrl="http://cms.test" dataset="prod" />); await screen.findByText('Launch'); fireEvent.click(screen.getByRole('button', { name: 'Publish release' }));
  view.rerender(<ReleasesPane cmsfnApiUrl="http://cms.test" dataset="staging" />); await screen.findByText('No releases.');
  await act(async () => finish(response({ releaseId: 'r1', published: ['a'], failures: [] })));
  expect(document.querySelector('[data-releases-publish-result]')).toBeNull(); expect(screen.queryByText('Launch')).toBeNull();
});
it('clears metadata and mutation controls after server denial', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ releases: [release] })).mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'private' } }))));
  render(<ReleasesPane cmsfnApiUrl="http://cms.test" dataset="prod" />); await screen.findByText('Launch'); fireEvent.click(screen.getByRole('button', { name: 'Refresh releases' })); await screen.findByText('No access');
  expect(screen.queryByText('Launch')).toBeNull(); expect(screen.queryByRole('button', { name: 'Create release' })).toBeNull(); expect(screen.queryByText('private')).toBeNull();
});
it('rejects foreign dataset release lists', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ releases: [{ ...release, dataset: 'private' }] })));
  render(<ReleasesPane cmsfnApiUrl="http://cms.test" dataset="prod" />); await screen.findByRole('alert'); expect(screen.queryByText('Launch')).toBeNull();
});

import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { OpsPane } from '../panes/ops/OpsPane.js';
const artifact = { formatVersion: 1, dataset: 'prod', exportedAt: '2026-10-23T00:00:00Z', schema: null, publishedDocs: [], draftDocs: [], assets: [], revisions: [], extra: 'x'.repeat(2000) };
const response = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('exports the complete downloadable artifact and reports an explicit successful import', async () => {
  const revoke = vi.fn(); const create = vi.fn(() => 'blob:test'); vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
  const calls: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return response(url.endsWith('/export') ? { artifact } : {}); }));
  const view = render(<OpsPane cmsfnApiUrl="http://cms.test" dataset="prod" />); fireEvent.click(screen.getByRole('button', { name: 'Export dataset' }));
  const output = await screen.findByLabelText('Complete export artifact'); expect((output as HTMLTextAreaElement).value).toBe(JSON.stringify(artifact));
  expect((await screen.findByRole('link', { name: 'Download complete export' })).getAttribute('download')).toBe('prod.export.json');
  fireEvent.change(screen.getByLabelText('Artifact JSON'), { target: { value: JSON.stringify(artifact) } }); fireEvent.click(screen.getByRole('button', { name: 'Import to prod' })); await screen.findByText('Import completed for prod.');
  expect(calls).toEqual([{ dataset: 'prod' }, { dataset: 'prod', artifact }]); view.unmount(); expect(revoke).toHaveBeenCalledWith('blob:test');
});
it('ignores an old dataset export completion', async () => {
  let finish!: (value: Response) => void; vi.stubGlobal('fetch', vi.fn(async () => new Promise<Response>(resolve => { finish = resolve; })));
  const view = render(<OpsPane cmsfnApiUrl="http://cms.test" dataset="prod" />); fireEvent.click(screen.getByRole('button', { name: 'Export dataset' }));
  view.rerender(<OpsPane cmsfnApiUrl="http://cms.test" dataset="staging" />); await act(async () => finish(response({ artifact })));
  expect(screen.queryByLabelText('Complete export artifact')).toBeNull(); expect(screen.queryByRole('link')).toBeNull();
});
it('rejects malformed JSON before requesting import', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); render(<OpsPane cmsfnApiUrl="http://cms.test" dataset="prod" />);
  fireEvent.change(screen.getByLabelText('Artifact JSON'), { target: { value: '{' } }); fireEvent.click(screen.getByRole('button', { name: 'Import to prod' })); await screen.findByText('Invalid artifact JSON.'); expect(fetcher).not.toHaveBeenCalled();
});
it('does not repeat an uncertain import or expose raw errors', async () => {
  let fail!: (error: Error) => void; const fetcher = vi.fn(async () => new Promise<Response>((_resolve, reject) => { fail = reject; })); vi.stubGlobal('fetch', fetcher);
  render(<OpsPane cmsfnApiUrl="http://cms.test" dataset="prod" />); fireEvent.change(screen.getByLabelText('Artifact JSON'), { target: { value: JSON.stringify(artifact) } });
  fireEvent.click(screen.getByRole('button', { name: 'Import to prod' })); fireEvent.click(screen.getByRole('button', { name: 'Import to prod' }));
  await act(async () => fail(new Error('private'))); await screen.findByText(/may have completed/); expect(fetcher).toHaveBeenCalledTimes(1); expect(screen.queryByText('private')).toBeNull();
});

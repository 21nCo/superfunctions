import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReferencePickerDialog } from '../editor/widgets/reference/ReferencePickerDialog.js';
import { ReferenceField } from '../editor/widgets/reference/ReferenceField.js';
import { queryCandidates } from '../references/queryCandidates.js';
const page = (title: string) => new Response(JSON.stringify({ ok: true, result: { data: [{ _id: 'candidate', _type: 'author', title }], nextCursor: null } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('offers server-backed candidate filtering', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => page('Alice')));
  render(<ReferencePickerDialog allowContentfnAuthorization baseUrl="http://content" dataset="prod" allowedTypes={['author']} onSelect={() => {}} onClose={() => {}} />);
  expect(screen.getByRole('textbox', { name: 'Filter references' })).toBeTruthy();
  await screen.findByText('Alice');
});
it('removes old dataset candidates immediately while the new scope is unresolved', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => JSON.parse(String(init.body)).dataset === 'prod' ? page('Private Alice') : new Promise<Response>(() => {})));
  const types = ['author']; const props = { allowContentfnAuthorization: true, baseUrl: 'http://content', allowedTypes: types, onSelect: () => {}, onClose: () => {} };
  const view = render(<ReferencePickerDialog {...props} dataset="prod" />); await screen.findByText('Private Alice');
  view.rerender(<ReferencePickerDialog {...props} dataset="staging" />);
  expect(screen.queryByText('Private Alice')).toBeNull();
});
it('rejects an empty allowed-type scope without querying all documents', async () => {
  const fetcher = vi.fn(async () => page('Alice')); vi.stubGlobal('fetch', fetcher);
  const result = await queryCandidates({ baseUrl: 'http://content', dataset: 'prod', types: [] });
  expect(result.ok).toBe(false); expect(fetcher).not.toHaveBeenCalled();
});
it('fails closed without a CMS endpoint or explicit standalone policy', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  expect((await queryCandidates({ baseUrl: 'http://content', dataset: 'prod', types: ['author'] })).ok).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
it('uses CMS authorization even if standalone mode and the UI read flag are enabled', async () => {
  const fetcher = vi.fn(async () => new Response('<html>Denied</html>', { status: 403 })); vi.stubGlobal('fetch', fetcher);
  render(<ReferencePickerDialog baseUrl="http://content" cmsfnApiUrl="http://cms" allowContentfnAuthorization hasDocRead dataset="prod" allowedTypes={['author']} onSelect={() => {}} onClose={() => {}} />);
  await screen.findByText('No access'); expect(String(fetcher.mock.calls[0][0])).toBe('http://cms/cmsfn/references/query');
  expect(document.querySelectorAll('[data-ref-picker-item]')).toHaveLength(0);
});
it('replaces pages, sends filters, and clears text when the candidate type changes', async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const input = JSON.parse(String(init.body)); requests.push(input);
    return new Response(JSON.stringify({ ok: true, result: { dataset: input.dataset, data: [{ _id: input.cursor ? 'b' : 'a', _type: input.types[0], label: input.cursor ? 'Second' : 'First' }], nextCursor: input.cursor ? null : 'next' } }));
  }));
  render(<ReferencePickerDialog baseUrl="http://content" cmsfnApiUrl="http://cms" dataset="prod" allowedTypes={['author', 'team']} onSelect={() => {}} onClose={() => {}} />);
  await screen.findByText('First'); fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByText('Second'); expect(screen.queryByText('First')).toBeNull(); expect(document.querySelectorAll('[data-ref-picker-item]')).toHaveLength(1);
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter references' }), { target: { value: 'Alice' } }); fireEvent.click(screen.getByRole('button', { name: 'Apply reference filter' }));
  await waitFor(() => expect(requests.at(-1)?.search).toBe('Alice'));
  fireEvent.change(screen.getByRole('combobox', { name: 'Reference type' }), { target: { value: 'team' } });
  await waitFor(() => expect(requests.at(-1)?.types).toEqual(['team'])); expect(requests.at(-1)?.search).toBe('');
  expect((screen.getByRole('textbox', { name: 'Filter references' }) as HTMLInputElement).value).toBe('');
});
it('rejects returned cross-dataset/type/draft identities before selection', async () => {
  for (const item of [{ dataset: 'staging', _id: 'a', _type: 'author' }, { dataset: 'prod', _id: 'drafts.a', _type: 'author' }, { dataset: 'prod', _id: 'a', _type: 'secret' }]) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { dataset: item.dataset, data: [{ _id: item._id, _type: item._type, label: 'Bad' }], nextCursor: null } }))));
    expect((await queryCandidates({ baseUrl: 'http://content', cmsfnApiUrl: 'http://cms', dataset: 'prod', types: ['author'] })).ok).toBe(false);
  }
});

it('closes a reference picker when the owning document changes and cannot write the previous selection', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => page('Alice')));
  const change = vi.fn(); const props = { value: undefined, onChange: change, baseUrl: 'http://content', allowContentfnAuthorization: true, dataset: 'prod', allowedTypes: ['author'], 'data-field-path': 'media.author' };
  const view = render(<ReferenceField {...props} ownerScope="doc-a" />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose reference' }));
  await screen.findByText('Alice');
  const oldSelection = document.querySelector<HTMLButtonElement>('[data-ref-picker-select]')!;
  view.rerender(<ReferenceField {...props} ownerScope="doc-b" />);
  expect(screen.queryByRole('dialog')).toBeNull(); fireEvent.click(oldSelection); expect(change).not.toHaveBeenCalled();
});

it('keeps dialog controls outside the field label and returns focus on escape', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => page('Alice')));
  render(<label>Author<ReferenceField value={undefined} onChange={() => {}} baseUrl="http://content" allowContentfnAuthorization dataset="prod" allowedTypes={['author']} /></label>);
  const open = screen.getByRole('button', { name: 'Choose reference', exact: true });
  fireEvent.click(open); await screen.findByText('Alice');
  expect(screen.getByRole('button', { name: 'Choose reference', exact: true })).toBe(open);
  expect(screen.getAllByRole('button', { name: 'Apply reference filter' })).toHaveLength(1);
  expect(screen.getByRole('dialog').closest('label')).toBeNull();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(open);
});

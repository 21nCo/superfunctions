import { DocumentEditorPane } from '../panes/editor/DocumentEditorPane.js';
import { insertAssetAtPath } from '../media/insertAssetAtPath.js';
import { renderField } from '../editor/renderField.js';
import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MediaLibraryPane } from '../panes/media/MediaLibraryPane.js';
import { AssetWidget } from '../editor/widgets/AssetWidget.js';
import { uploadAssetWithLimit } from '../media/upload.js';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('rejects an oversized File before reading or base64 allocating it', () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { assets: [] } }))));
  const read = vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(() => {});
  render(<MediaLibraryPane baseUrl="http://content" dataset="prod" maxUploadBytes={1} />);
  fireEvent.change(screen.getByLabelText('Upload file'), { target: { files: [new File(['ab'], 'too-big.txt')] } });
  expect(read).not.toHaveBeenCalled();
});
it('accepts a one-byte padded base64 upload at its exact byte limit', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { assetId: 'asset-one', url: '/asset-one' } }))));
  expect((await uploadAssetWithLimit({ baseUrl: 'http://content', maxUploadBytes: 1 }, { dataset: 'prod', filename: 'one.txt', contentType: 'text/plain', bytesBase64: 'YQ==' })).ok).toBe(true);
});
it('enforces disabled asset fields for both text and library selection', () => {
  render(<AssetWidget disabled value={undefined} onChange={() => {}} onOpenMediaPicker={() => {}} />);
  expect(screen.getByPlaceholderText('Asset ref').hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Select from library' }).hasAttribute('disabled')).toBe(true);
});
it('clears previous dataset rows immediately and ignores a late old page', async () => {
  let oldPage!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    return body.dataset === 'prod' ? new Promise<Response>(resolve => { oldPage = resolve; }) : new Response('', { status: 403 });
  }));
  const view = render(<MediaLibraryPane baseUrl="http://content" dataset="prod" onSelectAsset={() => {}} />);
  view.rerender(<MediaLibraryPane baseUrl="http://content" dataset="staging" onSelectAsset={() => {}} />);
  await screen.findByText('No access to media.');
  await act(async () => oldPage(new Response(JSON.stringify({ ok: true, result: { assets: [{ assetId: 'private', filename: 'Private file', url: '/private', contentType: 'text/plain', size: 1, createdAt: new Date().toISOString() }] } }))));
  expect(screen.queryByText('Private file')).toBeNull(); expect(document.querySelectorAll('[data-media-item]')).toHaveLength(0);
});
it('rejects malformed media success and keeps raw provider errors out of the interface', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { assets: [{ filename: { dangerous: 'object' } }] } }))).mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { code: 'ASSET_UPLOAD_FAILED', message: 'private provider token' } })));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<MediaLibraryPane baseUrl="http://content" dataset="prod" />);
  await screen.findByText('Media request could not be completed.');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh media' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('private provider token')).toBeNull(); view.unmount();
});
it('replaces bounded media pages instead of accumulating every asset', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const { offset } = JSON.parse(String(init.body));
    const assets = Array.from({ length: offset === 0 ? 50 : 1 }, (_, i) => ({ assetId: `asset-${offset + i}`, filename: `file-${offset + i}`, url: '/asset', contentType: 'text/plain', size: 1, createdAt: '2026-01-01T00:00:00Z' }));
    return new Response(JSON.stringify({ ok: true, result: { assets } }));
  }));
  render(<MediaLibraryPane baseUrl="http://content" dataset="prod" />);
  await screen.findByText('file-0'); fireEvent.click(screen.getByRole('button', { name: 'Next media page' }));
  await screen.findByText('file-50'); expect(screen.queryByText('file-0')).toBeNull(); expect(document.querySelectorAll('[data-media-item]')).toHaveLength(1);
});
it('inserts nested assets through literal schema keys and preserves siblings', () => {
  const asset = { _type: 'asset' as const, _ref: 'asset-one', assetType: 'file' as const };
  const original = { section: { title: 'Preserved' }, 'literal.key': 'old' };
  expect(insertAssetAtPath(original, ['section', 'attachment'], asset)).toEqual({ ...original, section: { title: 'Preserved', attachment: asset } });
  expect(insertAssetAtPath(original, ['literal.key'], asset)['literal.key']).toEqual(asset);
  expect(original.section).toEqual({ title: 'Preserved' });
  for (const path of [['__proto__', 'polluted'], ['section', 'constructor'], ['section', 'prototype']]) expect(() => insertAssetAtPath(original, path, asset)).toThrow();
  expect(() => insertAssetAtPath({ items: [] }, ['items', '0'], asset)).toThrow();
});
it('offers the media picker for nested object asset fields with exact key segments', () => {
  const open = vi.fn();
  render(<>{renderField({ name: 'section', type: { kind: 'object', fields: [{ name: 'literal.asset', type: { kind: 'asset', assetType: 'file' } }] } }, 'section', {}, () => {}, null, { onOpenMediaPicker: open })}</>);
  fireEvent.click(screen.getByRole('button', { name: 'Select from library' }));
  expect(open).toHaveBeenCalledWith('section.literal.asset', ['section', 'literal.asset']);
});
it('closes an open picker when the editor switches documents, including late media responses', async () => {
  let finishMedia!: (value: Response) => void;
  const schema = { version: 1, documentTypes: [{ name: 'post', fields: [{ name: 'cover', type: { kind: 'asset', assetType: 'file' } }] }, { name: 'page', fields: [{ name: 'title', type: { kind: 'primitive', type: 'string' } }] }] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/assets/list')) return new Promise<Response>(resolve => { finishMedia = resolve; });
    const input = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ ok: true, result: url.endsWith('/schema/get') ? schema : { _id: `drafts.${input.id}`, _type: input.id === 'a' ? 'post' : 'page', _rev: 'r1', title: 'Document B' } }));
  }));
  const props = { baseUrl: 'http://content', dataset: 'prod' };
  const view = render(<DocumentEditorPane {...props} docId="a" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Select from library' }));
  expect(document.querySelector('[data-media-library-pane]')).not.toBeNull();
  view.rerender(<DocumentEditorPane {...props} docId="b" />);
  await screen.findByDisplayValue('Document B');
  await act(async () => finishMedia(new Response(JSON.stringify({ ok: true, result: { assets: [{ assetId: 'old', url: '/old', filename: 'Old asset', contentType: 'text/plain', size: 1, createdAt: '2026-01-01T00:00:00Z' }] } }))));
  expect(document.querySelector('[data-media-library-pane]')).toBeNull(); expect(screen.queryByText('Old asset')).toBeNull();
});

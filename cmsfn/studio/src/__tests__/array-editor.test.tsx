import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ContentfnFieldType } from '@contentfn/core';
import { renderField } from '../editor/renderField.js';
const objectType: ContentfnFieldType = { kind: 'object', fields: [
  { name: 'caption', type: { kind: 'primitive', type: 'string' } },
  { name: 'literal.asset', type: { kind: 'asset', assetType: 'file' } },
  { name: 'author', type: { kind: 'reference', to: ['author'] } },
] };
const arrayType: ContentfnFieldType = { kind: 'array', of: [objectType], maxLength: 2 };
function Harness({ initial, type = arrayType }: { initial: unknown; type?: ContentfnFieldType }) {
  const [value, setValue] = useState(initial);
  return <>{renderField({ name: 'items', type }, 'items', value, setValue, null, { baseUrl: 'http://content', cmsfnApiUrl: 'http://cms', dataset: 'prod', referenceOwnerScope: 'document-a', maxUploadBytes: 1 })}<output data-value>{JSON.stringify(value)}</output><button onClick={() => setValue([{ caption: 'Replacement' }])}>External replacement</button></>;
}
const result = () => JSON.parse(document.querySelector('[data-value]')!.textContent!);
const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-array-item]'));
const assetResponse = () => new Response(JSON.stringify({ ok: true, result: { assets: [{ assetId: 'asset-a', filename: 'A file', contentType: 'text/plain', size: 1, url: '/a', createdAt: '2026-01-01T00:00:00Z' }] } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('renders declared nested widgets, preserves siblings and literal keys across media selection and reorder', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => assetResponse()));
  render(<Harness initial={[{ caption: 'First', other: 'preserved' }, { caption: 'Second' }]} />);
  const ownerId = rows()[0].dataset.arrayItemId;
  fireEvent.click(within(rows()[0]).getByRole('button', { name: 'Select from library' })); await screen.findByText('A file');
  fireEvent.change(screen.getByDisplayValue('First'), { target: { value: 'First edited' } });
  fireEvent.click(screen.getByRole('button', { name: 'Move item 1 down' }));
  expect(rows()[1].dataset.arrayItemId).toBe(ownerId);
  fireEvent.click(document.querySelector<HTMLButtonElement>('[data-media-select]')!);
  expect(result()).toEqual([{ caption: 'Second' }, { caption: 'First edited', other: 'preserved', 'literal.asset': { _type: 'asset', _ref: 'asset-a', assetType: 'file' } }]);
  expect(document.querySelector('[data-media-library-pane]')).toBeNull();
});
it('removal and external replacement clear pickers without assigning late responses to surviving items', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async () => new Promise<Response>(resolve => { finish = resolve; })));
  render(<Harness initial={[{ caption: 'First' }, { caption: 'Second' }]} />);
  fireEvent.click(within(rows()[0]).getByRole('button', { name: 'Select from library' }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove item 1' }));
  await act(async () => finish(assetResponse()));
  expect(document.querySelector('[data-media-library-pane]')).toBeNull(); expect(result()).toEqual([{ caption: 'Second' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Select from library' }));
  fireEvent.click(screen.getByRole('button', { name: 'External replacement' }));
  await act(async () => finish(assetResponse()));
  expect(document.querySelector('[data-media-library-pane]')).toBeNull(); expect(result()).toEqual([{ caption: 'Replacement' }]);
});
it('writes canonical references in an object array and preserves edits made while the picker is open', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { dataset: 'prod', data: [{ _id: 'author-a', _type: 'author', label: 'Alice' }], nextCursor: null } }))));
  render(<Harness initial={[{ caption: 'Before' }]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose reference' })); await screen.findByText('Alice');
  fireEvent.change(screen.getByDisplayValue('Before'), { target: { value: 'After' } });
  fireEvent.click(document.querySelector<HTMLButtonElement>('[data-ref-picker-select]')!);
  expect(result()).toEqual([{ caption: 'After', author: { _type: 'reference', _ref: 'author-a' } }]);
});
it('retains ambiguous union values until an explicit edit and respects maxLength', () => {
  const type: ContentfnFieldType = { kind: 'array', of: [objectType, { kind: 'object', fields: [] }], maxLength: 1 };
  render(<Harness type={type} initial={[{ caption: 'Original', unknown: 42 }]} />);
  expect(screen.getByText(/Select the matching type/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Add item' }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByRole('combobox', { name: 'Item 1 type' }), { target: { value: '0' } });
  expect(result()).toEqual([{ caption: 'Original', unknown: 42 }]);
  fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Edited' } });
  expect(result()).toEqual([{ caption: 'Edited', unknown: 42 }]);
});
it('adds chosen scalar types without converting all array values to strings', () => {
  render(<Harness type={{ kind: 'array', of: [{ kind: 'primitive', type: 'number' }, { kind: 'primitive', type: 'boolean' }] }} initial={[4, true]} />);
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '7' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'New item type' }), { target: { value: '1' } }); fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
  expect(result()).toEqual([7, true, false]);
});

it('keeps an open reference picker attached to its stable item after reorder', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { dataset: 'prod', data: [{ _id: 'author-new', _type: 'author', label: 'New author' }], nextCursor: null } }))));
  render(<Harness type={{ kind: 'array', of: [{ kind: 'reference', to: ['author'] }] }} initial={[{ _type: 'reference', _ref: 'first' }, { _type: 'reference', _ref: 'second' }]} />);
  fireEvent.click(within(rows()[0]).getByRole('button', { name: 'Choose reference' })); await screen.findByText('New author');
  fireEvent.click(screen.getByRole('button', { name: 'Move item 1 down' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.click(document.querySelector<HTMLButtonElement>('[data-ref-picker-select]')!);
  expect(result()).toEqual([{ _type: 'reference', _ref: 'second' }, { _type: 'reference', _ref: 'author-new' }]);
});
it('edits a direct asset array and nested arrays without inventing dotted keys or persisting local item IDs', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => assetResponse()));
  render(<Harness type={{ kind: 'array', of: [{ kind: 'array', of: [{ kind: 'asset', assetType: 'file' }] }] }} initial={[[{ _type: 'asset', _ref: 'old', assetType: 'file' }]]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Select from library' })); await screen.findByText('A file');
  fireEvent.click(document.querySelector<HTMLButtonElement>('[data-media-select]')!);
  expect(result()).toEqual([[{ _type: 'asset', _ref: 'asset-a', assetType: 'file' }]]);
});

import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { RichtextWidget } from '../editor/widgets/RichtextWidget.js';
it('provides block-array authoring instead of a flattening textarea', () => {
  render(<RichtextWidget value={[]} onChange={() => {}} />);
  expect(screen.getByRole('button', { name: 'Add text block' })).toBeTruthy();
});
it('preserves block/span keys, marks, annotations and other blocks when text changes', () => {
  const blocks = [{ _type: 'block', _key: 'first', style: 'h2', markDefs: [{ _key: 'link', _type: 'link', href: 'https://example.test' }], children: [{ _type: 'span', _key: 'span-a', text: 'One', marks: ['link'] }, { _type: 'span', _key: 'span-b', text: 'Two', marks: ['strong'] }] }, { _type: 'asset', _key: 'asset', _ref: 'asset-a', assetType: 'image' }];
  const change = vi.fn(); render(<RichtextWidget value={blocks} onChange={change} />);
  fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'Edited' } });
  expect(change).toHaveBeenCalledWith([{ ...blocks[0], children: [{ ...blocks[0].children![0], text: 'Edited' }, blocks[0].children![1]] }, blocks[1]]);
});
it('does not crash or coerce malformed persisted children', () => {
  expect(() => render(<RichtextWidget value={[{ _type: 'block', _key: 'b', children: { invalid: true } }]} onChange={() => {}} />)).not.toThrow();
});

import { checkRichtextLimits } from '../limits/precheck.js';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function Harness({ initial = [], maxBlocks = 5000 }: { initial?: unknown; maxBlocks?: number }) {
  const [value, setValue] = useState(initial);
  return <><RichtextWidget value={value} onChange={setValue} maxBlocks={maxBlocks} allowMarks={['strong']} allowObjects={['asset']} baseUrl="http://content" dataset="prod" ownerScope="doc:body" /><output data-richtext-value>{JSON.stringify(value)}</output></>;
}
const stored = () => JSON.parse(document.querySelector('[data-richtext-value]')!.textContent!);
const block = (i: number) => ({ _type: 'block', _key: `block-${i}`, children: [{ _type: 'span', _key: `span-${i}`, text: `Text ${i}`, marks: [] }] });
const media = () => new Response(JSON.stringify({ ok: true, result: { assets: [{ assetId: 'asset-a', filename: 'A file', contentType: 'text/plain', size: 1, url: '/a', createdAt: '2026-01-01T00:00:00Z' }] } }));
it('creates uniquely keyed blocks/spans, applies allowed marks and enforces the configured add boundary', () => {
  render(<Harness maxBlocks={2} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add text block' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New text' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'strong' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add text block' }));
  const value = stored(); expect(value).toHaveLength(2); expect(new Set(value.map((entry: {_key: string}) => entry._key)).size).toBe(2);
  expect(value[0].children[0]).toMatchObject({ _type: 'span', text: 'New text', marks: ['strong'] }); expect(value[0].children[0]._key).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Add text block' }).hasAttribute('disabled')).toBe(true);
  expect(screen.queryByRole('checkbox', { name: 'em' })).toBeNull();
});
it('pages block rendering without dropping unrendered content and preserves ordering on explicit moves', () => {
  render(<Harness initial={Array.from({ length: 21 }, (_, i) => block(i))} />);
  expect(document.querySelectorAll('[data-richtext-block]')).toHaveLength(20);
  fireEvent.click(screen.getByRole('button', { name: 'Next blocks' })); expect(document.querySelectorAll('[data-richtext-block]')).toHaveLength(1);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Last edited' } });
  fireEvent.click(screen.getByRole('button', { name: 'Move block 21 up' }));
  expect(stored()).toHaveLength(21); expect(stored()[19].children[0].text).toBe('Last edited'); expect(stored()[0]).toEqual(block(0));
});
it('invalidates a pending media picker when the host lowers the block cap', async () => {
  let finish!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async () => new Promise<Response>(resolve => { finish = resolve; })));
  const initial = [block(0)]; const view = render(<Harness initial={initial} maxBlocks={3} />);
  fireEvent.click(screen.getByRole('button', { name: 'Insert media block' }));
  view.rerender(<Harness initial={initial} maxBlocks={1} />);
  expect(document.querySelector('[data-media-library-pane]')).toBeNull();
  await act(async () => finish(media())); expect(stored()).toEqual(initial);
});
it('appends a canonical keyed asset without losing a text edit made while its library is open', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => media()));
  render(<Harness initial={[block(0)]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Insert media block' })); await screen.findByText('A file');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Kept' } });
  fireEvent.click(document.querySelector<HTMLButtonElement>('[data-media-select]')!);
  expect(stored()[0].children[0].text).toBe('Kept'); expect(stored()[1]).toMatchObject({ _type: 'asset', _ref: 'asset-a', assetType: 'file' }); expect(stored()[1]._key).toBeTruthy();
});
it('checks nested object and array richtext while preserving opaque JSON and valid alternative types', () => {
  const schema = { name: 'post', fields: [{ name: 'sections', type: { kind: 'array' as const, of: [{ kind: 'object' as const, fields: [{ name: 'body', type: { kind: 'richtext' as const } }] }] } }, { name: 'opaque', type: { kind: 'primitive' as const, type: 'json' as const } }] };
  expect(checkRichtextLimits({ sections: [{ body: [block(0), block(1)] }] }, schema, 1)).toEqual({ ok: false, path: 'sections[0].body' });
  expect(checkRichtextLimits({ opaque: [block(0), block(1)] }, schema, 1)).toEqual({ ok: true });
});

it('moves back one effective page after external block or span shrink without mutating content', () => {
  const change = vi.fn();
  const blocks = Array.from({ length: 100 }, (_, i) => block(i));
  const view = render(<RichtextWidget value={blocks} onChange={change} />);
  for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole('button', { name: 'Next blocks' }));
  view.rerender(<RichtextWidget value={blocks.slice(0, 21)} onChange={change} />);
  fireEvent.click(screen.getByRole('button', { name: 'Previous blocks' }));
  expect(screen.getAllByRole('textbox')[0].getAttribute('aria-label')).toBe('Span 1 text');
  expect(screen.queryByRole('button', { name: 'Previous blocks' })).toBeNull();
  const spans = Array.from({ length: 100 }, (_, i) => ({ _type: 'span', _key: `s-${i}`, text: `Span ${i}`, marks: [] }));
  view.rerender(<RichtextWidget value={[{ ...block(0), children: spans }]} onChange={change} />);
  for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole('button', { name: 'Next spans' }));
  view.rerender(<RichtextWidget value={[{ ...block(0), children: spans.slice(0, 21) }]} onChange={change} />);
  fireEvent.click(screen.getByRole('button', { name: 'Previous spans' }));
  expect(screen.getByRole('textbox', { name: 'Span 1 text' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Previous spans' })).toBeNull();
  expect(change).not.toHaveBeenCalled();
});

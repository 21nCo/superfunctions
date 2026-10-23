import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DocumentEditorPane } from '../panes/editor/DocumentEditorPane.js';
import { DocumentListPane } from '../panes/list/DocumentListPane.js';
const baseUrl = 'http://content.test';
const schema = { version: 1, documentTypes: [{ name: 'post', fields: [{ name: 'title', type: { kind: 'primitive', type: 'string' } }] }] };
const doc = (id: string, title = id) => ({ _id: id, _type: 'post', _rev: `rev-${id}`, _createdAt: '', _updatedAt: '', title });
const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
const failure = (code: string) => new Response(JSON.stringify({ ok: false, error: { code, message: code, details: {} } }), { status: 200 });
afterEach(() => vi.unstubAllGlobals());
describe('authoring lifecycle', () => {
  it.each([false, true])('creates or opens an authorized draft without overwriting a collision (collision=%s)', async collision => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; calls.push({ url, body });
      if (url.endsWith('/schema/get')) return ok(schema);
      if (url.endsWith('/docs/fork')) return collision ? failure('DOCUMENT_ALREADY_EXISTS') : ok(doc('drafts.post'));
      return ok(doc(body.perspective === 'draft' ? 'drafts.winner' : 'post'));
    }));
    const onOpenDraft = vi.fn();
    render(<DocumentEditorPane baseUrl={baseUrl} dataset="prod" docId="post" perspective="published" onOpenDraft={onOpenDraft} />);
    await screen.findByRole('heading', { name: 'Published document' });
    expect(document.querySelector('[data-editor-save]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create or open draft' }));
    await waitFor(() => expect(onOpenDraft).toHaveBeenCalledWith(collision ? 'drafts.winner' : 'drafts.post'));
    expect(calls.find(call => call.url.endsWith('/docs/fork'))?.body).toEqual({ dataset: 'prod', id: 'post', ifRev: 'rev-post' });
    expect(calls.some(call => call.url.endsWith('/docs/patch'))).toBe(false);
    expect(calls.some(call => call.body.perspective === 'draft')).toBe(collision);
  });
  it('does not open a collision winner when draft read is denied', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (url.endsWith('/schema/get')) return ok(schema);
      if (url.endsWith('/docs/fork')) return failure('DOCUMENT_ALREADY_EXISTS');
      return body.perspective === 'draft' ? failure('PERMISSION_DENIED') : ok(doc('post'));
    }));
    const onOpenDraft = vi.fn();
    render(<DocumentEditorPane baseUrl={baseUrl} dataset="prod" docId="post" perspective="published" onOpenDraft={onOpenDraft} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create or open draft' }));
    await screen.findByText('PERMISSION_DENIED'); expect(onOpenDraft).not.toHaveBeenCalled();
  });
  it('does not infer unpublished state from a denied publication read', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (url.endsWith('/schema/get')) return ok(schema);
      return body.perspective === 'published' ? failure('PERMISSION_DENIED') : ok(doc('drafts.post'));
    }));
    render(<DocumentEditorPane baseUrl={baseUrl} dataset="prod" docId="drafts.post" cmsfnApiUrl="http://cms.test" />);
    await screen.findByText('Publication state could not be verified');
    expect(document.querySelector('[data-publish-button]')).toBeNull();
    expect(document.querySelector('[data-unpublish-button]')).toBeNull();
  });
  it('ignores a late document from the previous dataset', async () => {
    let finishOld: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (url.endsWith('/schema/get')) return ok(schema);
      return body.dataset === 'old' ? new Promise<Response>(resolve => { finishOld = resolve; }) : ok(doc('drafts.new', 'New dataset'));
    }));
    const { rerender } = render(<DocumentEditorPane baseUrl={baseUrl} dataset="old" docId="same" />);
    await waitFor(() => expect(finishOld).toBeDefined());
    rerender(<DocumentEditorPane baseUrl={baseUrl} dataset="new" docId="same" />);
    await screen.findByDisplayValue('New dataset');
    await act(async () => { finishOld?.(ok(doc('drafts.old', 'Old dataset'))); });
    expect(screen.queryByDisplayValue('Old dataset')).toBeNull(); expect(screen.getByDisplayValue('New dataset')).toBeTruthy();
  });
  it('ignores a late list page from the previous perspective', async () => {
    let finishOld: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return body.perspective === 'published' ? new Promise<Response>(resolve => { finishOld = resolve; }) : ok({ data: [doc('drafts.new')], nextCursor: null });
    }));
    const node = { kind: 'documentList' as const, title: 'Posts', dataset: 'prod', types: ['post'] };
    const { rerender } = render(<DocumentListPane baseUrl={baseUrl} dataset="prod" node={node} perspective="published" />);
    await waitFor(() => expect(finishOld).toBeDefined());
    rerender(<DocumentListPane baseUrl={baseUrl} dataset="prod" node={node} perspective="draft" />);
    await screen.findByText('drafts.new');
    await act(async () => { finishOld?.(ok({ data: [doc('old')], nextCursor: 'old-cursor' })); });
    expect(screen.queryByText('old')).toBeNull(); expect(document.querySelector('[data-list-next-page]')).toBeNull();
  });
});

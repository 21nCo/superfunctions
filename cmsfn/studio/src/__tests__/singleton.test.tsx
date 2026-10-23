import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../app.js';
import type { CmsfnStudioConfig } from 'cmsfn';
const config: CmsfnStudioConfig = {
  contentfn: { baseUrl: 'http://content.test' }, datasets: [{ name: 'prod' }, { name: 'staging' }], auth: { kind: 'custom' },
  desk: { kind: 'group', title: 'Settings', children: [
    { kind: 'singleton', title: 'Production home', dataset: 'prod', type: 'page', id: 'home' },
    { kind: 'singleton', title: 'Staging home', dataset: 'staging', type: 'page', id: 'home' },
    { kind: 'singleton', title: 'Unavailable', dataset: 'private', type: 'page', id: 'home' },
  ] },
};
const schema = { version: 1, documentTypes: [
  { name: 'page', fields: [{ name: 'title', type: { kind: 'primitive', type: 'string' } }] },
  { name: 'post', fields: [{ name: 'title', type: { kind: 'primitive', type: 'string' } }] },
] };
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
afterEach(() => vi.unstubAllGlobals());
describe('singleton desk navigation', () => {
  it('selects the configured dataset and edits the same ID independently across datasets', async () => {
    const mutations: unknown[] = []; const reads: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (url.endsWith('/schema/get')) return response({ ok: true, result: schema });
      if (url.endsWith('/docs/patch')) mutations.push(body); else reads.push(body);
      return response({ ok: true, result: { _id: 'drafts.home', _type: 'page', _rev: `rev-${body.dataset}`, title: String(body.dataset) } });
    }));
    render(<App config={config} />);
    fireEvent.click(screen.getByRole('button', { name: 'Staging home' }));
    await screen.findByDisplayValue('staging');
    expect((screen.getByRole('combobox', { name: 'Select dataset' }) as HTMLSelectElement).value).toBe('staging');
    fireEvent.change(document.querySelector('input[data-field-path="title"]')!, { target: { value: 'Stage edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]).toMatchObject({ dataset: 'staging', id: 'drafts.home', ifRev: 'rev-staging' });
    expect(reads).toEqual([{ dataset: 'staging', id: 'home', perspective: 'draft' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Production home' }));
    await screen.findByDisplayValue('prod');
    fireEvent.change(document.querySelector('input[data-field-path="title"]')!, { target: { value: 'Prod edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mutations).toHaveLength(2));
    expect(mutations[1]).toMatchObject({ dataset: 'prod', id: 'drafts.home', ifRev: 'rev-prod' });
    expect(screen.getByRole('button', { name: 'Back to desk' })).toBeTruthy();
  });
  it('rejects a singleton outside configured datasets before any request', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    render(<App config={config} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unavailable' }));
    await screen.findByText('This singleton is not available in the configured datasets');
    expect(fetchMock).not.toHaveBeenCalled(); expect(document.querySelector('[data-editor-pane]')).toBeNull();
  });
  it.each(['DOCUMENT_NOT_FOUND', 'PERMISSION_DENIED'])('surfaces %s without editor or mutation controls', async code => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.endsWith('/schema/get') ? { ok: true, result: schema } : { ok: false, error: { code, message: code, details: {} } })));
    render(<App config={config} />);
    fireEvent.click(screen.getByRole('button', { name: 'Production home' }));
    await screen.findByText(code);
    expect(document.querySelector('[data-editor-save]')).toBeNull(); expect(document.querySelector('[data-workflow-controls]')).toBeNull();
  });
  it('refuses an authorized document whose type differs from the singleton contract', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response({ ok: true, result: url.endsWith('/schema/get') ? schema : { _id: 'drafts.home', _type: 'post', _rev: 'r1', title: 'Wrong type content' } })));
    render(<App config={config} />);
    fireEvent.click(screen.getByRole('button', { name: 'Production home' }));
    await screen.findByText('Document type does not match this desk singleton');
    expect(screen.queryByDisplayValue('Wrong type content')).toBeNull(); expect(document.querySelector('[data-editor-save]')).toBeNull();
  });
});

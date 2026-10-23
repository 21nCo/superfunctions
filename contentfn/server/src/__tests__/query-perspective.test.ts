import { describe, expect, it } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/adapters';
import { createContentfnServer } from '../server.js';
import type { ContentfnEnvelope } from '@contentfn/core';

function unwrap<T>(result: ContentfnEnvelope<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.result;
}
async function fixture() {
  const db = memoryAdapter();
  const server = createContentfnServer({ db });
  for (const dataset of ['prod', 'other']) {
    unwrap(await server.api.datasets.create({ dataset }));
    unwrap(await server.api.schema.upsert({ dataset, schema: { version: 1, documentTypes: [{ name: 'post', fields: [{ name: 'title', type: { kind: 'primitive', type: 'string' } }, { name: 'related', type: { kind: 'reference', to: ['post'] } }] }] } }));
    for (const id of ['a', 'b', 'c']) {
      unwrap(await server.api.docs.create({ dataset, id, type: 'post', doc: { title: `published ${id}` } }));
      unwrap(await server.api.docs.create({ dataset, id, type: 'post', doc: { title: `draft ${id}` }, asDraft: true }));
    }
  }
  return { db, server };
}
describe('CFQL perspective and cursor boundaries', () => {
  it('queries complete separate perspectives and binds pagination to dataset, view, and filter', async () => {
    const { db, server } = await fixture();
    try {
      const query = { dataset: 'prod', perspective: 'draft' as const, limit: 1, orderBy: [{ field: '_id', direction: 'asc' as const }] };
      const first = unwrap(await server.api.docs.query(query));
      expect(first.data.map(doc => doc._id)).toEqual(['drafts.a']);
      const second = unwrap(await server.api.docs.query({ ...query, cursor: first.nextCursor }));
      expect(second.data.map(doc => doc._id)).toEqual(['drafts.b']);
      const third = unwrap(await server.api.docs.query({ ...query, cursor: second.nextCursor }));
      expect(third.data.map(doc => doc._id)).toEqual(['drafts.c']);
      expect(third.nextCursor).toBeNull();
      expect(unwrap(await server.api.docs.query({ dataset: 'prod' })).data.map(doc => doc._id).sort()).toEqual(['a', 'b', 'c']);
      for (const changed of [{ dataset: 'other' }, { perspective: 'published' as const }, { filter: { field: 'title', op: 'eq' as const, value: 'draft b' } }, { orderBy: [{ field: '_id', direction: 'desc' as const }] }]) {
        expect(await server.api.docs.query({ ...query, ...changed, cursor: first.nextCursor })).toMatchObject({ ok: false, error: { code: 'QUERY_INVALID', details: { path: 'cursor' } } });
      }
      const legacyCursor = Buffer.from(JSON.stringify({ values: ['drafts.a'] })).toString('base64url');
      expect(await server.api.docs.query({ ...query, cursor: legacyCursor })).toMatchObject({ ok: false, error: { code: 'QUERY_INVALID' } });
    } finally { await db.close(); }
  });
  it('expands draft references in the authorized perspective with published fallback', async () => {
    const { db, server } = await fixture();
    try {
      const draft = unwrap(await server.api.docs.get({ dataset: 'prod', id: 'a', perspective: 'draft' }));
      unwrap(await server.api.docs.patch({ dataset: 'prod', id: draft._id, ifRev: draft._rev, ops: [{ op: 'set', path: 'related', value: { _type: 'reference', _ref: 'b' } }] }));
      const query = { dataset: 'prod', perspective: 'draft' as const, filter: { field: '_id', op: 'eq' as const, value: 'drafts.a' }, projection: { expand: { relatedDoc: { field: 'related' } } } };
      expect(unwrap(await server.api.docs.query(query)).data[0].relatedDoc).toMatchObject({ _id: 'drafts.b', title: 'draft b' });
      unwrap(await server.api.docs.create({ dataset: 'prod', id: 'published-only', type: 'post', doc: { title: 'Published fallback' } }));
      const current = unwrap(await server.api.docs.get({ dataset: 'prod', id: 'a', perspective: 'draft' }));
      unwrap(await server.api.docs.patch({ dataset: 'prod', id: current._id, ifRev: current._rev, ops: [{ op: 'set', path: 'related', value: { _type: 'reference', _ref: 'published-only' } }] }));
      expect(unwrap(await server.api.docs.query(query)).data[0].relatedDoc).toMatchObject({ _id: 'published-only', title: 'Published fallback' });
    } finally { await db.close(); }
  });
  it('strictly validates wire perspectives and denies draft reads under a published-only query policy', async () => {
    const { db } = await fixture();
    const seen: string[] = [];
    const server = createContentfnServer({ db, authorize: (_ctx, action, input) => { seen.push(action); return action === 'query' && input.dataset === 'prod'; } });
    const request = (body: unknown) => server.router.handle(new Request('http://localhost/contentfn/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    try {
      expect(await server.api.docs.query({ dataset: 'prod', perspective: 'draft' })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      expect(await (await request({ dataset: 'prod', perspective: 'draft' })).json()).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      expect(seen).toEqual(['query.drafts', 'query.drafts']);
      expect(await (await request({ dataset: 'prod' })).json()).toMatchObject({ ok: true });
      for (const perspective of ['raw', '', false, null, {}, ['draft']]) {
        expect(await (await request({ dataset: 'prod', perspective })).json()).toMatchObject({ ok: false, error: { code: 'QUERY_INVALID' } });
      }
      for (const authorize of [() => false, () => { throw new Error('policy failed'); }]) {
        const denied = createContentfnServer({ db, authorize });
        expect(await denied.api.docs.query({ dataset: 'prod', perspective: 'draft' })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      }
      const allowed = createContentfnServer({ db, authorize: (_ctx, action, input) => action === 'query.drafts' && input.dataset === 'prod' });
      expect(unwrap(await allowed.api.docs.query({ dataset: 'prod', perspective: 'draft' })).data).toHaveLength(3);
      expect(await allowed.api.docs.query({ dataset: 'other', perspective: 'draft' })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    } finally { await db.close(); }
  });
});

import { describe, expect, it } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/adapters';
import type { Adapter } from '@superfunctions/db';
import { createContentfnServer } from '../server.js';
import type { ContentfnEnvelope } from '@contentfn/core';
function unwrap<T>(result: ContentfnEnvelope<T>): T { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.result; }
async function fixture() {
  const db = memoryAdapter(); const server = createContentfnServer({ db });
  unwrap(await server.api.datasets.create({ dataset: 'prod' }));
  unwrap(await server.api.schema.upsert({ dataset: 'prod', schema: { version: 1, documentTypes: [{ name: 'post', fields: [{ name: 'title', type: { kind: 'primitive', type: 'string' } }] }] } }));
  const source = unwrap(await server.api.docs.create({ dataset: 'prod', id: 'post', type: 'post', doc: { title: 'Published original' } }));
  return { db, server, source };
}
describe('explicit draft fork', () => {
  it('copies only the checked published revision, strips publication identity, and never overwrites a winning draft', async () => {
    const { db, server, source } = await fixture();
    try {
      expect(await server.api.docs.fork({ dataset: 'prod', id: 'post', ifRev: 'stale' })).toMatchObject({ ok: false, error: { code: 'REV_CONFLICT' } });
      expect(await server.api.docs.get({ dataset: 'prod', id: 'post', perspective: 'draft' })).toMatchObject({ ok: false, error: { code: 'DOCUMENT_NOT_FOUND' } });
      const results = await Promise.all([1, 2].map(() => server.api.docs.fork({ dataset: 'prod', id: 'post', ifRev: source._rev })));
      expect(results.filter(result => result.ok)).toHaveLength(1);
      expect(results.find(result => !result.ok)).toMatchObject({ error: { code: 'DOCUMENT_ALREADY_EXISTS' } });
      const draft = unwrap(await server.api.docs.get({ dataset: 'prod', id: 'post', perspective: 'draft' }));
      expect(draft).toMatchObject({ _id: 'drafts.post', _type: 'post', title: source.title });
      expect(draft._rev).not.toBe(source._rev); expect(draft._publishedAt).toBeUndefined();
      expect(unwrap(await server.api.docs.get({ dataset: 'prod', id: 'post' }))).toEqual(source);
      const changed = unwrap(await server.api.docs.patch({ dataset: 'prod', id: draft._id, ifRev: draft._rev, ops: [{ op: 'set', path: 'title', value: 'Winning edit' }] }));
      const collision = await server.api.docs.fork({ dataset: 'prod', id: 'post', ifRev: source._rev });
      expect(collision).toMatchObject({ ok: false, error: { code: 'DOCUMENT_ALREADY_EXISTS' } });
      expect(JSON.stringify(collision)).not.toContain('Winning edit');
      expect(unwrap(await server.api.docs.get({ dataset: 'prod', id: 'post', perspective: 'draft' }))).toEqual(changed);
      expect(unwrap(await server.api.audit.query({ dataset: 'prod', action: 'docs.fork' })).records).toHaveLength(1);
    } finally { await db.close(); }
  });
  it('denies draft creation when the source CAS loses and rolls back revision failure', async () => {
    for (const failure of ['source-cas', 'revision'] as const) {
      const { db, server, source } = await fixture();
      const transaction = db.transaction.bind(db);
      db.transaction = (callback, options) => transaction(tx => callback(new Proxy(tx, { get(target, key) {
        if (key === 'updateMany' && failure === 'source-cas') return async () => 0;
        if (key === 'create' && failure === 'revision') return async (params: Parameters<Adapter['create']>[0]) => {
          if (params.model === 'contentfn_revisions') throw new Error('write failed');
          return target.create(params);
        };
        return Reflect.get(target, key);
      } })), options);
      try {
        expect(await server.api.docs.fork({ dataset: 'prod', id: 'post', ifRev: source._rev })).toMatchObject({ ok: false, error: { code: failure === 'source-cas' ? 'REV_CONFLICT' : 'STORAGE_ERROR' } });
        expect(await server.api.docs.get({ dataset: 'prod', id: 'post', perspective: 'draft' })).toMatchObject({ ok: false, error: { code: 'DOCUMENT_NOT_FOUND' } });
        expect(unwrap(await server.api.docs.get({ dataset: 'prod', id: 'post' }))).toEqual(source);
        expect(unwrap(await server.api.audit.query({ dataset: 'prod', action: 'docs.fork' })).records).toEqual([]);
      } finally { await db.close(); }
    }
  });
  it('uses a distinct authorization action on HTTP and rejects missing revision', async () => {
    const { db, server, source } = await fixture();
    try {
      const denied = createContentfnServer({ db, authorize: (_context, action) => action === 'docs.create' });
      const request = (body: unknown) => new Request('http://localhost/contentfn/docs/fork', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(await (await denied.router.handle(request({ dataset: 'prod', id: 'post', ifRev: source._rev }))).json()).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      for (const ifRev of [undefined, null, '', 12]) expect(await (await server.router.handle(request({ dataset: 'prod', id: 'post', ifRev }))).json()).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      const forkOnly = createContentfnServer({ db, authorize: (_context, action) => action === 'docs.fork' });
      expect(await forkOnly.api.docs.fork({ dataset: 'prod', id: 'post', ifRev: source._rev })).toMatchObject({ ok: true });
      expect(await forkOnly.api.docs.get({ dataset: 'prod', id: 'post', perspective: 'draft' })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    } finally { await db.close(); }
  });
});

import { memoryAdapter } from '@superfunctions/db/adapters';
import { wrapWithSchema } from '@superfunctions/db/schema';
import { createContentfnServer } from '../server.js';
import { expect, it } from 'vitest';
import { ALL_TABLES, getSchema, getContentfnSchema } from '../storage/schema.js';
it('exposes physical schemas with bounded identities and JSON text columns for shared CLI discovery', () => {
  const schema = getSchema();
  expect(schema.version).toBe(2);
  expect(schema.schemas.map(table => table.modelName)).toEqual(ALL_TABLES.map(table => table.name));
  const revisions = schema.schemas.find(table => table.modelName === 'contentfn_revisions')!;
  expect(revisions.fields.id).toMatchObject({ maxLength: 64 });
  expect(revisions.fields.docId.maxLength).toBeUndefined();
  expect(revisions.fields.docJson).toMatchObject({ type: 'string' });
  expect(revisions.indexes).toEqual([expect.objectContaining({ fields: ['id'], unique: true })]);
  expect(getContentfnSchema().contentfn_revisions.fields.docJson).toMatchObject({ type: 'json', jsonStorageType: 'json-text' });
});

it('uses native JSON only when explicitly configured for both generation and runtime', () => {
  expect(getSchema({ jsonStorage: 'native' }).schemas.find(table => table.modelName === 'contentfn_revisions')!.fields.docJson.type).toBe('json');
  expect(getContentfnSchema({ jsonStorage: 'native' }).contentfn_revisions.fields.docJson.jsonStorageType).toBe('native');
  expect(() => getSchema({ jsonStorage: 'invalid' as 'native' })).toThrow('jsonStorage');
  for (const table of getSchema().schemas) expect(table.fields.id).toMatchObject({ type: 'string', required: true, maxLength: 64 });
});

it('roundtrips large native JSON documents and unrestricted public IDs with bounded physical keys', async () => {
  const db = memoryAdapter();
  const server = createContentfnServer({ db, jsonStorage: 'native' });
  await server.api.datasets.create({ dataset: 'prod' });
  await server.api.schema.upsert({ dataset: 'prod', schema: { version: 1, documentTypes: [{ name: 'post', fields: [{ name: 'text', type: { kind: 'primitive', type: 'string' } }] }] } });
  const id = 'unicode-文'.repeat(300);
  const text = '文'.repeat(40000);
  expect(await server.api.docs.create({ dataset: 'prod', id, type: 'post', doc: { text } })).toMatchObject({ ok: true, result: { _id: id, text } });
  expect(await server.api.docs.get({ dataset: 'prod', id })).toMatchObject({ ok: true, result: { _id: id, text } });
  const row = await wrapWithSchema(db, getContentfnSchema({ jsonStorage: 'native' })).findOne({ model: 'contentfn_docs_published', where: [{ field: 'dataset', operator: 'eq', value: 'prod' }] });
  expect(row?.id).toMatch(/^[a-f0-9]{64}$/);
  expect(row?.docJson).toMatchObject({ _id: id, text });
});

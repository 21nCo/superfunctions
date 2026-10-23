import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentfnEnvelope, ContentfnSchema } from '@contentfn/core';
import { createContentfnServer } from '../server.js';
import { ALL_TABLES } from '../storage/schema.js';
import { runContentfnMigrations } from '../storage/migrate.js';
import { validateDocumentAgainstSchema, validateImportedRichtextLimits } from '../storage/document-validation.js';
import { resolveLimits } from '../limits/limits.js';
const schema: ContentfnSchema = { version: 1, documentTypes: [{ name: 'post', fields: [{ name: 'sections', type: { kind: 'array', of: [{ kind: 'object', fields: [{ name: 'body', type: { kind: 'richtext' } }] }] } }, { name: 'opaque', type: { kind: 'primitive', type: 'json' } }] }] };
const blocks = (length: number) => Array.from({ length }, (_, index) => ({ _type: 'block', _key: `b${index}`, children: [{ _type: 'span', _key: `s${index}`, text: `Text ${index}` }] }));
const document = (length: number) => ({ sections: [{ body: blocks(length) }] });
function unwrap<T>(value: ContentfnEnvelope<T>): T { if (!value.ok) throw Error(JSON.stringify(value)); return value.result; }
it('enforces the default boundary and preserves unknown historical JSON during limit-only archive validation', () => {
  expect(resolveLimits().maxRichtextBlocks).toBe(5000);
  for (const maxRichtextBlocks of [0, -1, 1.5, Infinity]) expect(() => resolveLimits({ maxRichtextBlocks })).toThrow();
  expect(validateDocumentAgainstSchema(schema, 'post', document(5000)).ok).toBe(true);
  expect(validateDocumentAgainstSchema(schema, 'post', document(5001))).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { path: 'sections[0].body' } } });
  expect(validateImportedRichtextLimits(schema, { _type: 'post', removedHistoricalField: blocks(3), opaque: blocks(3) }, 2).ok).toBe(true);
  expect(validateImportedRichtextLimits(schema, { _type: 'post', ...document(3) }, 2).ok).toBe(false);
});
it('rejects oversized nested richtext on HTTP create/patch/import and reopened SQLite publish/fork/restore/scheduling without content mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'content-richtext-limit-'));
  const open = (maxRichtextBlocks: number) => {
    const sqlite = new Database(join(directory, 'db.sqlite'));
    const sql = new Kysely<Record<string, Record<string, unknown>>>({ dialect: new SqliteDialect({ database: sqlite }) });
    const db = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: Object.fromEntries(ALL_TABLES.map(table => [table.name, table.name])) });
    const server = createContentfnServer({ db, limits: { maxRichtextBlocks } });
    return { sqlite, sql, db, server };
  };
  let current = open(3);
  const request = async (path: string, body: unknown): Promise<unknown> => (await current.server.router.handle(new Request(`http://owned/contentfn/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))).json();
  const counts = () => ['contentfn_revisions', 'contentfn_events', 'contentfn_audit'].map(table => current.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get());
  try {
    await runContentfnMigrations({ async createTableIfNotExists(table) {
      let builder = current.sql.schema.createTable(table.name).ifNotExists(); const keys: string[] = [];
      for (const [name, column] of Object.entries(table.columns)) {
        builder = builder.addColumn(name, column.type === 'number' ? 'real' : column.type === 'boolean' ? 'integer' : 'text', column.nullable ? undefined : b => b.notNull());
        if (column.primaryKey) keys.push(name);
      }
      if (keys.length) builder = builder.addPrimaryKeyConstraint(`${table.name}_pk`, keys as never[]);
      await builder.execute();
    } });
    unwrap(await current.server.api.datasets.create({ dataset: 'prod' }));
    unwrap(await current.server.api.schema.upsert({ dataset: 'prod', schema }));
    const oldDraft = unwrap(await current.server.api.docs.create({ dataset: 'prod', id: 'legacy', type: 'post', doc: document(3), asDraft: true }));
    const oldPublished = unwrap(await current.server.api.docs.create({ dataset: 'prod', id: 'published', type: 'post', doc: document(3) }));
    unwrap(await current.server.api.docs.schedule({ dataset: 'prod', id: 'legacy', ifRev: oldDraft._rev, publishAt: '2020-01-01T00:00:00Z' }));
    const artifact = unwrap(await current.server.api.datasets.export({ dataset: 'prod' })).artifact;
    await current.db.close(); current = open(2);
    const before = counts();
    const rejected = { ok: false, error: { code: 'VALIDATION_FAILED', details: { path: 'sections[0].body' } } };
    expect(await request('docs/create', { dataset: 'prod', id: 'rejected', type: 'post', doc: document(3) })).toMatchObject(rejected);
    expect(await request('docs/patch', { dataset: 'prod', id: 'drafts.legacy', ifRev: oldDraft._rev, ops: [{ op: 'set', path: 'opaque', value: 'unchanged body still exceeds cap' }] })).toMatchObject(rejected);
    expect(await request('datasets/import', { dataset: 'new-target', artifact })).toMatchObject(rejected);
    expect(unwrap(await current.server.api.datasets.list()).datasets).not.toContain('new-target');
    expect(await current.server.api.docs.publish({ dataset: 'prod', id: 'legacy', ifRev: oldDraft._rev })).toMatchObject(rejected);
    expect(await current.server.api.docs.fork({ dataset: 'prod', id: 'published', ifRev: oldPublished._rev })).toMatchObject(rejected);
    expect(await current.server.api.docs.restore({ dataset: 'prod', id: 'legacy', rev: oldDraft._rev })).toMatchObject(rejected);
    expect(await current.server.processScheduledPublishes()).toEqual({ published: 0, failed: 1 });
    expect(counts()).toEqual(before);
    expect(unwrap(await current.server.api.docs.get({ dataset: 'prod', id: 'legacy', perspective: 'draft' }))).toEqual(oldDraft);
    expect(await current.server.api.docs.get({ dataset: 'prod', id: 'legacy', perspective: 'published' })).toMatchObject({ ok: false });
    // Existing oversized documents stay readable and can be corrected within the cap.
    expect(await request('docs/patch', { dataset: 'prod', id: 'drafts.legacy', ifRev: oldDraft._rev, ops: [{ op: 'set', path: 'sections', value: document(2).sections }] })).toMatchObject({ ok: true });
    expect(await current.server.api.docs.publish({ dataset: 'prod', id: 'legacy' })).toMatchObject({ ok: true });
  } finally { await current.db.close(); await rm(directory, { recursive: true, force: true }); }
});

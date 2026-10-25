import { expect, it } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/adapters';
import { validatePatch, formatPatchPath, type ContentfnEnvelope, type ContentfnPatchOp } from '@contentfn/core';
import { createContentfnServer } from '../server.js';
import { applyPatch } from '../patch/applyPatch.js';
function unwrap<T>(value: ContentfnEnvelope<T>): T { if (!value.ok) throw Error(JSON.stringify(value)); return value.result; }
it('detaches explicit literal segments and preserves legacy event/filter paths', () => {
  const path = ['section', 'literal.key'];
  const parsed = unwrap(validatePatch({ dataset: 'prod', id: 'one', ops: [{ op: 'set', path, value: 'new' }] }));
  path[0] = '_rev';
  expect(parsed.ops[0].path).toEqual(['section', 'literal.key']);
  expect(formatPatchPath(['title'])).toBe('title');
  expect(formatPatchPath(['section', 'title'])).toBe('section.title');
  expect(formatPatchPath(['section', 'literal.key'])).toBe('["section","literal.key"]');
  for (const invalid of [[], [''], [1], ['constructor', 'polluted'], ['section', '__proto__'], '__proto__.polluted']) {
    expect(validatePatch({ dataset: 'prod', id: 'one', ops: [{ op: 'set', path: invalid, value: true }] }).ok).toBe(false);
  }
  expect(applyPatch({}, [{ op: 'set', path: ['constructor', 'polluted'], value: true }]).ok).toBe(false);
  expect(Object.prototype).not.toHaveProperty('polluted');
});
it('applies literal path operations independently of dotted nested paths', () => {
  const doc = { 'a.b': 1, a: { b: 10 }, 'list.key': [{ _key: 'one' }] };
  const ops: ContentfnPatchOp[] = [
    { op: 'inc', path: ['a.b'], value: 2 }, { op: 'dec', path: 'a.b', value: 3 },
    { op: 'insert', path: ['list.key'], position: 'after', ref: 'one', items: [{ _key: 'two' }] },
    { op: 'splice', path: ['list.key'], index: 0, deleteCount: 1 },
  ];
  expect(unwrap(applyPatch(doc, ops))).toEqual({ 'a.b': 3, a: { b: 7 }, 'list.key': [{ _key: 'two' }] });
  expect(unwrap(applyPatch(doc, [{ op: 'unset', path: ['a.b'] }]))).toEqual({ a: { b: 7 }, 'list.key': [{ _key: 'two' }] });
});
it('validates real HTTP literal writes, reserved paths and revision conflicts without partial storage mutation', async () => {
  const db = memoryAdapter(); const server = createContentfnServer({ db });
  const request = async (input: unknown) => (await server.router.handle(new Request('http://owned/contentfn/docs/patch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }))).json();
  try {
    unwrap(await server.api.datasets.create({ dataset: 'prod' }));
    unwrap(await server.api.schema.upsert({ dataset: 'prod', schema: { version: 1, documentTypes: [{ name: 'post', fields: [{ name: 'a.b', type: { kind: 'primitive', type: 'string' } }, { name: 'a', type: { kind: 'object', fields: [{ name: 'b', type: { kind: 'primitive', type: 'string' } }] } }, { name: '_custom', type: { kind: 'primitive', type: 'string' } }] }] } }));
    const original = unwrap(await server.api.docs.create({ dataset: 'prod', id: 'one', type: 'post', asDraft: true, doc: { 'a.b': 'literal', a: { b: 'nested' }, _custom: 'old' } }));
    const result = await request({ dataset: 'prod', id: 'drafts.one', ifRev: original._rev, ops: [{ op: 'set', path: ['a.b'], value: 'literal saved' }, { op: 'set', path: 'a.b', value: 'nested saved' }, { op: 'set', path: ['_custom'], value: 'new' }] });
    expect(result).toMatchObject({ ok: true, result: { 'a.b': 'literal saved', a: { b: 'nested saved' }, _custom: 'new' } });
    const stable = unwrap(await server.api.docs.get({ dataset: 'prod', id: 'one', perspective: 'draft' }));
    for (const path of ['_rev', ['_rev'], ['_id', 'nested'], ['a', '__proto__'], ['constructor', 'prototype']]) {
      expect(await request({ dataset: 'prod', id: 'drafts.one', ops: [{ op: 'set', path, value: 'bad' }] })).toMatchObject({ ok: false, error: { code: 'PATCH_INVALID' } });
      expect(unwrap(await server.api.docs.get({ dataset: 'prod', id: 'one', perspective: 'draft' }))).toEqual(stable);
    }
    expect(await request({ dataset: 'prod', id: 'drafts.one', ifRev: original._rev, ops: [{ op: 'set', path: ['a'], value: {} }] })).toMatchObject({ ok: false, error: { code: 'REV_CONFLICT' } });
  } finally { await db.close(); }
});

import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_TABLES } from '../storage/schema.js';
import { runContentfnMigrations } from '../storage/migrate.js';
it('persists literal fields and unambiguous event metadata across SQLite reopen, fencing caller path mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'content-literal-path-'));
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const open = () => {
    const sqlite = new Database(join(directory, 'db.sqlite'));
    const sql = new Kysely<Record<string, Record<string, unknown>>>({ dialect: new SqliteDialect({ database: sqlite }) });
    const db = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: Object.fromEntries(ALL_TABLES.map(table => [table.name, table.name])) });
    const server = createContentfnServer({ db, authorize: async (_context, action) => {
      if (action === 'docs.patch' && entered) { entered(); await new Promise<void>(resolve => { release = resolve; }); }
      return true;
    } });
    return { sqlite, sql, db, server };
  };
  let current = open();
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
    unwrap(await current.server.api.schema.upsert({ dataset: 'prod', schema: { version: 1, documentTypes: [{ name: 'post', fields: [{ name: 'literal.key', type: { kind: 'primitive', type: 'string' } }, { name: 'title', type: { kind: 'primitive', type: 'string' } }] }] } }));
    const original = unwrap(await current.server.api.docs.create({ dataset: 'prod', id: 'one', type: 'post', asDraft: true, doc: { 'literal.key': 'old', title: 'old' } }));
    const path = ['literal.key'];
    const gate = new Promise<void>(resolve => { entered = resolve; });
    const pending = current.server.api.docs.patch({ dataset: 'prod', id: 'drafts.one', ifRev: original._rev, ops: [{ op: 'set', path, value: 'saved' }, { op: 'set', path: ['title'], value: 'ordinary' }] });
    await gate; path[0] = '_rev'; entered = undefined; release!();
    const saved = unwrap(await pending);
    expect(saved).toMatchObject({ 'literal.key': 'saved', title: 'ordinary' });
    const rows = current.sqlite.prepare('SELECT changedPaths FROM contentfn_events WHERE rev = ?').all(saved._rev) as { changedPaths: string }[];
    expect(rows.map(row => JSON.parse(row.changedPaths))).toEqual([['["literal.key"]', 'title']]);
    await current.sql.destroy(); current = open();
    expect(unwrap(await current.server.api.docs.get({ dataset: 'prod', id: 'one', perspective: 'draft' }))).toEqual(saved);
    const denied = await current.server.api.docs.patch({ dataset: 'prod', id: 'drafts.one', ops: [{ op: 'set', path: ['title'], value: 'must rollback' }, { op: 'set', path: ['_rev'], value: 'forged' }] });
    expect(denied).toMatchObject({ ok: false, error: { code: 'PATCH_INVALID' } });
    expect(unwrap(await current.server.api.docs.get({ dataset: 'prod', id: 'one', perspective: 'draft' }))).toEqual(saved);
  } finally { release?.(); await current.sql.destroy(); await rm(directory, { recursive: true, force: true }); }
});

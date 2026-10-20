import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { memoryAdapter } from '@superfunctions/db/adapters';
import { drizzleAdapter } from '@superfunctions/db/adapters/drizzle';
import type { Adapter } from '@superfunctions/db';
import { compFn } from '../compfn.js';
import { getCompfnSchema } from '../storage/schema.js';
import type { CompfnEnvelope } from '../errors.js';
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const unwrap = <T,>(value: CompfnEnvelope<T>): T => { if (!value.ok) throw new Error(value.error.message); return value.result; };

function sqlite(file: string) {
  const native = new Database(file);
  const definitions = getCompfnSchema().schemas;
  const schema = Object.fromEntries(definitions.map(table => [table.modelName, sqliteTable(table.modelName,
    Object.fromEntries(Object.entries(table.fields).map(([name, field]) => [name, field.type === 'number' ? integer(name) : field.type === 'json' ? text(name, { mode: 'json' }) : text(name)])))]));
  for (const table of definitions) native.exec(`CREATE TABLE IF NOT EXISTS "${table.modelName}" (${Object.entries(table.fields).map(([name, field]) => `"${name}" ${field.type === 'number' ? 'INTEGER' : 'TEXT'}${name === 'id' ? ' PRIMARY KEY' : ''}`).join(',')})`);
  let closed = false;
  return { adapter: drizzleAdapter({ db: drizzle(native, { schema }), dialect: 'sqlite' }), close: () => { if (!closed) { native.close(); closed = true; } } };
}

for (const provider of ['memory', 'sqlite'] as const) describe(provider, () => {
  it('isolates evidence from input, create/get/list/export mutations and preserves scoping readiness', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'compfn-immutable-'));
    const file = path.join(root, 'evidence.sqlite');
    const storage = provider === 'sqlite' ? sqlite(file) : { adapter: memoryAdapter(), close() {} };
    try {
      await storage.adapter.initialize();
      const api = compFn({ database: storage.adapter, logger: quiet });
      const control = unwrap(await api.controls.create({ name: 'audit', description: 'fixture', category: 'test' }));
      const payload = { status: 'not_applicable', nested: { reason: 'original', values: [1, { text: '文' }] } };
      const expected = JSON.parse(JSON.stringify(payload));
      const created = unwrap(await api.evidence.create({ controlId: control.id, type: 'scoping_decision', actorId: 'fixture', outcome: 'unknown', payload }));
      payload.status = 'applicable'; payload.nested.reason = 'input mutation';
      expect(unwrap(await api.evidence.get(created.id)).payload).toEqual(expected);
      for (const returned of [created, unwrap(await api.evidence.get(created.id)), unwrap(await api.evidence.list({ controlId: control.id }))[0], unwrap(await api.export.auditorPack()).evidence[0]]) {
        returned.payload!.status = 'applicable';
        (returned.payload!.nested as any).reason = 'response mutation';
        (returned.payload!.nested as any).values[1].text = 'changed';
        expect(unwrap(await api.evidence.get(created.id)).payload).toEqual(expected);
        expect(unwrap(await api.readiness.forControl(control.id)).status).toBe('not_applicable');
      }
      if (provider === 'sqlite') {
        storage.close();
        const reopened = sqlite(file);
        try { expect(unwrap(await compFn({ database: reopened.adapter, logger: quiet }).evidence.get(created.id)).payload).toEqual(expected); }
        finally { reopened.close(); }
      }
    } finally { storage.close(); await storage.adapter.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

it.each(['memory', 'sqlite'] as const)('%s captures payload before an awaited control lookup and serializes it only once', async provider => {
  const root = mkdtempSync(path.join(tmpdir(), 'compfn-pending-'));
  const storage = provider === 'sqlite' ? sqlite(path.join(root, 'pending.sqlite')) : { adapter: memoryAdapter(), close() {} };
  const db = storage.adapter; await db.initialize();
  try {
  const base = compFn({ database: db, logger: quiet });
  const control = unwrap(await base.controls.create({ name: 'audit', description: 'fixture', category: 'test' }));
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const pending = new Promise<void>(resolve => { entered = resolve; });
  const paused: Adapter = { ...db, findOne: async params => { if (params.model === 'controls') { entered(); await gate; } return db.findOne(params); } };
  let serialized = 0;
  const payload = { nested: { value: 'original' }, toJSON() { serialized++; return { nested: this.nested }; } };
  const api = compFn({ database: paused, logger: quiet });
  const creating = api.evidence.create({ controlId: control.id, type: 'manual_attestation', actorId: 'fixture', outcome: 'pass', payload });
  await pending; payload.nested.value = 'mutated while pending'; release();
  const result = unwrap(await creating);
  expect(result.payload).toEqual({ nested: { value: 'original' } });
  expect(serialized).toBe(1);
  expect(unwrap(await api.evidence.get(result.id)).payload).toEqual({ nested: { value: 'original' } });
  } finally { storage.close(); await db.close(); rmSync(root, { recursive: true, force: true }); }
});

it('checks UTF-8 size against the same once-serialized JSON object that is stored', async () => {
  const db = memoryAdapter(); await db.initialize();
  const base = compFn({ database: db, logger: quiet });
  const control = unwrap(await base.controls.create({ name: 'audit', description: 'fixture', category: 'test' }));
  const snapshot = { note: '文' }; const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  let calls = 0;
  const payload = { extra: 'not serialized', toJSON() { calls++; return snapshot; } };
  const input = { controlId: control.id, type: 'manual_attestation' as const, actorId: 'fixture', outcome: 'pass' as const, payload };
  const accepted = compFn({ database: db, logger: quiet, evidencePayloadMaxBytes: bytes });
  expect(unwrap(await accepted.evidence.create(input)).payload).toEqual(snapshot);
  expect(calls).toBe(1);
  const rejected = compFn({ database: db, logger: quiet, evidencePayloadMaxBytes: bytes - 1 });
  expect(await rejected.evidence.create(input)).toMatchObject({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE', details: { size: bytes, limit: bytes - 1 } } });
  expect(calls).toBe(2);
});

it('rejects serialized non-object payloads and invalid serialized scoping statuses', async () => {
  const db = memoryAdapter(); await db.initialize();
  const api = compFn({ database: db, logger: quiet });
  const control = unwrap(await api.controls.create({ name: 'audit', description: 'fixture', category: 'test' }));
  for (const returned of [null, [], 'text', { status: 'invalid' }]) {
    expect(await api.evidence.create({ controlId: control.id, type: 'scoping_decision', actorId: 'fixture', outcome: 'unknown', payload: { status: 'applicable', toJSON() { return returned; } } })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  }
  expect(unwrap(await api.evidence.list())).toEqual([]);
});

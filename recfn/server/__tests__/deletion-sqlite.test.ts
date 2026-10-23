import { processTranscriptionJob } from '../src/transcription/pipeline.js';
import { createAsrRegistry } from '../src/transcription/registry.js';
import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { createDbStore } from '../src/store/db.js';
import { getRecFnSchema } from '../src/store/schema.js';
import { deleteBotAggregate } from '../src/deletion/service.js';
import { createSearchFnClient } from '../src/integrations/searchfn.js';
import { uploadObject } from '../src/integrations/storage.js';
import { uploadRecording } from '../src/recording/storage.js';
import { createNoopLogger } from '../src/integrations/logfn.js';
import { createRecFnServer } from '../src/index.js';
import type { BotConfig } from '@recfn/core';
const config: Required<BotConfig> = { displayName: 'Bot', joinTimeout: 30000, autoLeaveOnEmpty: true, autoLeaveEmptyTimeout: 30000, consentMessage: 'Recording', enableRealTimeTranscript: false, asrProvider: 'whisper', recordingFormat: 'mp4', language: 'en' };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'recfn-deletion-')); const schema = getRecFnSchema();
  const open = () => {
    const db = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(join(root, 'state.sqlite')) }) });
    return { db, adapter: kyselyAdapter({ db, dialect: 'sqlite', schema: Object.fromEntries(Object.keys(schema).map(key => [key, key])) }) };
  };
  let connection = open();
  for (const [name, table] of Object.entries(schema)) {
    let query = connection.db.schema.createTable(name);
    for (const [field, definition] of Object.entries(table.fields)) query = query.addColumn(field, definition.type === 'number' ? 'real' : definition.type === 'boolean' ? 'integer' : 'text', column => {
      if (field === 'id') column = column.primaryKey(); else if (definition.unique) column = column.unique(); return definition.required ? column.notNull() : column;
    });
    await query.execute();
  }
  let store = createDbStore({ adapter: connection.adapter, durable: true });
  const storage = createLocalStorageAdapter({ rootDir: join(root, 'objects') }); const search = createSearchFnClient();
  return { root, storage, search, get store() { return store; }, get db() { return connection.db; }, async reopen() { await connection.adapter.close(); connection = open(); store = createDbStore({ adapter: connection.adapter, durable: true }); }, async close() { await connection.adapter.close(); await rm(root, { recursive: true, force: true }); } };
}
async function bot(f: Awaited<ReturnType<typeof fixture>>, namespace = 'a') {
  const result = await f.store.createBot({ namespace, meetingUrl: 'https://meet.google.com/abc-defg-hij', platform: 'meet', config });
  await f.store.updateBot(result.id, namespace, { status: 'done' }); return result;
}
async function record(f: Awaited<ReturnType<typeof fixture>>, botId: string, id = 'recording', namespace = 'a') {
  const key = `${namespace}/${id}.wav`; await uploadObject(f.storage, key, new Uint8Array([1, 2, 3]));
  const recording = { id, botId, format: 'wav' as const, storageRef: key, size: 3, duration: 1, createdAt: new Date().toISOString() };
  await f.store.createRecording(recording, namespace);
  await f.search.index([{ recordingId: id, botId, participantId: 'speaker', startTime: 0, endTime: 1, text: 'cleanup evidence' }]); return recording;
}

it('retries search/object failures after SQLite reopen, preserving intent, namespace and completion acknowledgement', async () => {
  const f = await fixture();
  try {
    const a = await bot(f); const b = await bot(f, 'b'); const r = await record(f, a.id); const other = await record(f, b.id, 'other', 'b');
    const remove = vi.spyOn(f.search, 'removeByRecording').mockRejectedValueOnce(new Error('search unavailable'));
    expect(await deleteBotAggregate(a.id, 'a', { store: f.store, storage: f.storage, searchClient: f.search })).toMatchObject({ deleted: false, state: 'pending' });
    expect(await f.store.getBot(a.id, 'a')).not.toBeNull(); await access(join(f.root, 'objects', r.storageRef));
    await f.reopen(); expect((await f.store.getBotDeletion(a.id, 'a'))?.resources).toEqual([{ recordingId: r.id, storageRef: r.storageRef }]);
    const deleteObject = vi.spyOn(f.storage, 'deleteObject').mockRejectedValueOnce(new Error('storage unavailable'));
    expect(await deleteBotAggregate(a.id, 'a', { store: f.store, storage: f.storage, searchClient: f.search })).toMatchObject({ deleted: false, state: 'pending' });
    await f.reopen();
    expect(await deleteBotAggregate(a.id, 'b', { store: f.store, storage: f.storage, searchClient: f.search })).toBeNull();
    expect(await deleteBotAggregate(a.id, 'a', { store: f.store, storage: f.storage, searchClient: f.search })).toEqual({ deleted: true, state: 'completed' });
    await expect(access(join(f.root, 'objects', r.storageRef))).rejects.toThrow(); await access(join(f.root, 'objects', other.storageRef));
    expect((await f.search.search('cleanup')).map(x => x.document?.recordingId)).toEqual(['other']);
    await f.reopen(); expect(await f.store.getBot(a.id, 'a')).toBeNull(); expect(await f.store.getBot(b.id, 'b')).not.toBeNull();
    const calls = [remove.mock.calls.length, deleteObject.mock.calls.length];
    expect(await deleteBotAggregate(a.id, 'a', { store: f.store, storage: f.storage, searchClient: f.search })).toEqual({ deleted: true, state: 'completed' });
    expect([remove.mock.calls.length, deleteObject.mock.calls.length]).toEqual(calls);
  } finally { await f.close(); }
});

it('durably tracks an in-flight upload before bytes, blocks deletion, and cleans the late object without admitting its row', async () => {
  const f = await fixture(); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  try {
    const a = await bot(f); const native = f.storage.openUploadStream!.bind(f.storage); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const storage = { ...f.storage, openUploadStream: async (input: Parameters<typeof native>[0]) => { entered(); await wait; return native(input); } };
    const upload = uploadRecording({ botId: a.id, namespace: 'a', capture: { data: new Uint8Array([9]), size: 1, duration: 1, format: 'wav' } }, { store: f.store, storage, logger: createNoopLogger() });
    const failed = expect(upload).rejects.toMatchObject({ code: 'RECORDING_FINALIZATION_FAILED' }); await started;
    const producer = (await f.store.listBotProducers(a.id, 'a'))[0]; expect(producer.storageRef).toBeTruthy();
    expect(await deleteBotAggregate(a.id, 'a', { store: f.store, storage: f.storage, searchClient: f.search })).toMatchObject({ deleted: false, state: 'blocked' });
    await expect(f.store.beginBotProducer({ botId: a.id, namespace: 'a', recordingId: 'new' })).rejects.toMatchObject({ code: 'BOT_STILL_ACTIVE' });
    await expect(f.store.addChatMessage(a.id, { participantId: 'x', text: 'late', timestamp: new Date().toISOString() }, 'a')).rejects.toMatchObject({ code: 'BOT_STILL_ACTIVE' });
    release(); await failed; await access(join(f.root, 'objects', producer.storageRef!));
    expect(await f.store.getRecordings(a.id, 'a')).toEqual([]);
    expect(await deleteBotAggregate(a.id, 'a', { store: f.store, storage: f.storage, searchClient: f.search })).toEqual({ deleted: true, state: 'completed' });
    await expect(access(join(f.root, 'objects', producer.storageRef!))).rejects.toThrow();
  } finally { release(); await f.close(); }
});

it('keeps crashed/uncertain producer intents blocked through reopen until explicit stopped-operation reconciliation', async () => {
  const f = await fixture();
  try {
    const a = await bot(f); const producer = await f.store.beginBotProducer({ botId: a.id, namespace: 'a', recordingId: 'crashed', storageRef: 'a/crashed.wav' });
    await uploadObject(f.storage, producer.storageRef!, new Uint8Array([5])); await f.reopen();
    const server = () => createRecFnServer({ store: f.store, storage: f.storage, searchClient: f.search, rateLimit: false, validateApiKey: key => key === 'a' ? { namespace: 'a', apiKey: key } : null });
    const request = () => new Request(`http://localhost/api/v1/bots/${a.id}`, { method: 'DELETE', headers: { authorization: 'Bearer a' } });
    let response = await server().router.handle(request()); expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ data: { deleted: false, state: 'blocked' } });
    await f.reopen(); response = await server().router.handle(request()); expect(response.status).toBe(202);
    await f.store.reconcileBotProducer(producer.id, 'a', { operationStopped: true, reason: 'Fixture producer process is gone; no request remains in flight.' });
    response = await server().router.handle(request()); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ data: { deleted: true } });
    await expect(access(join(f.root, 'objects', producer.storageRef!))).rejects.toThrow();
  } finally { await f.close(); }
});

it('cleans more than an adapter page of recordings and transcripts and refuses missing-root producers', async () => {
  const f = await fixture();
  try {
    await expect(f.store.beginBotProducer({ botId: 'missing', namespace: 'a', recordingId: 'orphan' })).rejects.toThrow();
    expect(await f.store.listBotProducers('missing', 'a')).toEqual([]);
    const a = await bot(f);
    for (let i = 0; i < 105; i++) {
      const r = await record(f, a.id, `recording-${String(i).padStart(3, '0')}`);
      await f.store.createTranscript({ id: `transcript-${i}`, recordingId: r.id, status: 'ready', language: 'en', segments: [], createdAt: new Date().toISOString() }, 'a');
    }
    const intent = await f.store.beginBotDeletion(a.id, 'a'); expect(intent?.resources).toHaveLength(105);
    expect(await deleteBotAggregate(a.id, 'a', { store: f.store, storage: f.storage, searchClient: f.search })).toEqual({ deleted: true, state: 'completed' });
    expect(await f.db.selectFrom('recordings').selectAll().execute()).toEqual([]); expect(await f.db.selectFrom('transcripts').selectAll().execute()).toEqual([]);
    for (const resource of intent!.resources) await expect(access(join(f.root, 'objects', resource.storageRef!))).rejects.toThrow();
    expect(await f.search.search('cleanup', { limit: 200 })).toEqual([]);
  } finally { await f.close(); }
});

it('retains pending cleanup when the final DB delete fails after object deletion, then retries idempotently', async () => {
  const f = await fixture();
  try {
    const a = await bot(f); const r = await record(f, a.id);
    const sqlite = new Database(join(f.root, 'state.sqlite'));
    sqlite.exec("CREATE TRIGGER fail_bot_delete BEFORE DELETE ON bots BEGIN SELECT RAISE(ABORT, 'injected'); END"); sqlite.close();
    expect(await deleteBotAggregate(a.id, 'a', { store: f.store, storage: f.storage, searchClient: f.search })).toMatchObject({ deleted: false, state: 'pending' });
    await expect(access(join(f.root, 'objects', r.storageRef))).rejects.toThrow();
    await f.reopen(); expect(await f.store.getBot(a.id, 'a')).not.toBeNull(); expect((await f.store.getBotDeletion(a.id, 'a'))?.state).toBe('pending');
    const repaired = new Database(join(f.root, 'state.sqlite')); repaired.exec('DROP TRIGGER fail_bot_delete'); repaired.close();
    expect(await deleteBotAggregate(a.id, 'a', { store: f.store, storage: f.storage, searchClient: f.search })).toEqual({ deleted: true, state: 'completed' });
  } finally { await f.close(); }
});

it('waits for an admitted search publisher before removing its late index documents', async () => {
  const f = await fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const a = await bot(f); const r = await record(f, a.id); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const registry = createAsrRegistry(); registry.register({ name: 'fixture', supportedLanguages: () => ['en'], async *transcribeStream() {}, async transcribeBatch() { return [{ speakerId: 'p', startTime: 0, endTime: 1, text: 'late publication', confidence: 1 }]; } });
    const client = { ...f.search, index: async (documents: Parameters<typeof f.search.index>[0]) => { entered(); await gate; await f.search.index(documents); } };
    const job = processTranscriptionJob({ recordingId: r.id, namespace: 'a', audioRef: r.storageRef, asrProvider: 'fixture', language: 'en' }, { store: f.store, searchClient: client, asrRegistry: registry, logger: createNoopLogger() });
    await started; expect(await deleteBotAggregate(a.id, 'a', { store: f.store, storage: f.storage, searchClient: f.search })).toMatchObject({ state: 'blocked', deleted: false });
    release(); await job; expect(await f.search.search('publication')).toHaveLength(1);
    expect(await deleteBotAggregate(a.id, 'a', { store: f.store, storage: f.storage, searchClient: f.search })).toEqual({ state: 'completed', deleted: true });
    expect(await f.search.search('publication')).toEqual([]);
  } finally { release(); await f.close(); }
});

it('fences a separate SQLite connection and reports missing cleanup dependencies without success', async () => {
  const f = await fixture(); let other: ReturnType<typeof kyselyAdapter> | undefined;
  try {
    const a = await bot(f); const r = await record(f, a.id);
    const db = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(join(f.root, 'state.sqlite')) }) });
    other = kyselyAdapter({ db, dialect: 'sqlite', schema: Object.fromEntries(Object.keys(getRecFnSchema()).map(key => [key, key])) });
    const producerStore = createDbStore({ adapter: other, durable: true });
    expect(await deleteBotAggregate(a.id, 'a', { store: f.store, searchClient: f.search })).toMatchObject({ state: 'blocked', deleted: false });
    await expect(producerStore.createRecording({ ...r, id: 'late' }, 'a')).rejects.toMatchObject({ code: 'BOT_STILL_ACTIVE' });
    await expect(producerStore.updateBot(a.id, 'a', { status: 'recording' })).rejects.toMatchObject({ code: 'BOT_STILL_ACTIVE' });
    expect(await deleteBotAggregate(a.id, 'a', { store: f.store, storage: f.storage })).toMatchObject({ state: 'blocked', deleted: false });
    await access(join(f.root, 'objects', r.storageRef));
  } finally { await other?.close(); await f.close(); }
});

it('bounds unresolved producer intents while successful producers release their admission slot', async () => {
  const f = await fixture();
  try {
    const a = await bot(f);
    for (let i = 0; i < 65; i++) {
      const id = `successful-${i}`; const ticket = await f.store.beginBotProducer({ botId: a.id, namespace: 'a', recordingId: id });
      await f.store.createRecording({ id, botId: a.id, format: 'wav', storageRef: id, size: 1, duration: 1, createdAt: new Date().toISOString() }, 'a');
      await f.store.finishBotProducer(ticket.id, 'a', true);
    }
    expect(await f.store.listBotProducers(a.id, 'a')).toEqual([]);
    for (let i = 0; i < 64; i++) await f.store.beginBotProducer({ botId: a.id, namespace: 'a', recordingId: `active-${i}` });
    await expect(f.store.beginBotProducer({ botId: a.id, namespace: 'a', recordingId: 'overflow' })).rejects.toMatchObject({ code: 'BOT_STILL_ACTIVE' });
    expect(await f.store.listBotProducers(a.id, 'a')).toHaveLength(64);
    const result = await deleteBotAggregate(a.id, 'a', { store: f.store, storage: f.storage, searchClient: f.search });
    expect(result).toMatchObject({ state: 'blocked', deleted: false }); if (result && !result.deleted) expect(result.producerIds).toHaveLength(64);
  } finally { await f.close(); }
});

it('keeps one deletion journal across competing SQLite connections and explicit contention retries', async () => {
  const f = await fixture();
  const db = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(join(f.root, 'state.sqlite'), { timeout: 10 }) }) });
  const adapter = kyselyAdapter({ db, dialect: 'sqlite', schema: Object.fromEntries(Object.keys(getRecFnSchema()).map(key => [key, key])) });
  const second = createDbStore({ adapter, durable: true });
  try {
    const a = await bot(f); await record(f, a.id);
    const attempts = await Promise.allSettled([f.store.beginBotDeletion(a.id, 'a'), second.beginBotDeletion(a.id, 'a')]);
    expect(attempts.some(result => result.status === 'fulfilled')).toBe(true);
    for (const result of attempts) {
      if (result.status === 'rejected') expect(String(result.reason)).toMatch(/locked|busy/i);
    }
    const [first, repeated] = await Promise.all([f.store.beginBotDeletion(a.id, 'a'), second.beginBotDeletion(a.id, 'a')]);
    expect(first).toEqual(repeated); expect(first?.resources).toHaveLength(1);
    expect(await f.db.selectFrom('botDeletions').selectAll().execute()).toHaveLength(1);
    expect(await deleteBotAggregate(a.id, 'a', { store: second, storage: f.storage, searchClient: f.search })).toEqual({ deleted: true, state: 'completed' });
  } finally { await adapter.close(); await f.close(); }
});

it('retains cleanup ownership when a successful write does not match the persisted recording key', async () => {
  const f = await fixture();
  try {
    const a = await bot(f); const r = await record(f, a.id);
    const ticket = await f.store.beginBotProducer({ botId: a.id, namespace: 'a', recordingId: r.id, storageRef: 'a/unlinked.wav' });
    await uploadObject(f.storage, ticket.storageRef!, new Uint8Array([7]));
    await f.store.finishBotProducer(ticket.id, 'a', true);
    expect(await f.store.listBotProducers(a.id, 'a')).toMatchObject([{ id: ticket.id, state: 'settled' }]);
    expect(await deleteBotAggregate(a.id, 'a', { store: f.store, storage: f.storage, searchClient: f.search })).toEqual({ deleted: true, state: 'completed' });
    await expect(access(join(f.root, 'objects', r.storageRef))).rejects.toThrow();
    await expect(access(join(f.root, 'objects', ticket.storageRef!))).rejects.toThrow();
  } finally { await f.close(); }
});

it('recovers live producer slots only after stopped proof and matching durable resource ownership', async () => {
  const f = await fixture();
  try {
    const a = await bot(f);
    await f.store.updateBot(a.id, 'a', { status: 'recording' });
    const r = await record(f, a.id);
    const linked = await f.store.beginBotProducer({ botId: a.id, namespace: 'a', recordingId: r.id, storageRef: r.storageRef });
    const orphan = await f.store.beginBotProducer({ botId: a.id, namespace: 'a', recordingId: r.id, storageRef: 'a/unlinked.wav' });
    await uploadObject(f.storage, 'a/unlinked.wav', new Uint8Array([7]));
    for (let i = 0; i < 62; i++) await f.store.beginBotProducer({ botId: a.id, namespace: 'a', recordingId: `unresolved-${i}` });
    await f.reopen();
    await expect(f.store.beginBotProducer({ botId: a.id, namespace: 'a', recordingId: 'overflow' })).rejects.toMatchObject({ code: 'BOT_STILL_ACTIVE' });
    await expect(f.store.reconcileBotProducer(linked.id, 'a', { operationStopped: true, reason: '' })).rejects.toMatchObject({ code: 'BOT_STILL_ACTIVE' });
    await expect(f.store.reconcileBotProducer(linked.id, 'wrong', { operationStopped: true, reason: 'Stopped fixture' })).rejects.toMatchObject({ code: 'BOT_STILL_ACTIVE' });
    expect(await f.store.getBotDeletion(a.id, 'a')).toBeNull();
    expect((await f.store.getBot(a.id, 'a'))?.status).toBe('recording');
    await f.store.reconcileBotProducer(orphan.id, 'a', { operationStopped: true, reason: 'Original local producer stopped, but object is unlinked' });
    await expect(f.store.beginBotProducer({ botId: a.id, namespace: 'a', recordingId: 'still-full' })).rejects.toMatchObject({ code: 'BOT_STILL_ACTIVE' });
    await f.store.reconcileBotProducer(linked.id, 'a', { operationStopped: true, reason: 'Original local producer stopped; recording owns its object' });
    await f.reopen();
    const intents = await f.store.listBotProducers(a.id, 'a');
    expect(intents).toHaveLength(63);
    expect(intents.find(p => p.id === orphan.id)).toMatchObject({ state: 'settled', storageRef: 'a/unlinked.wav' });
    expect(intents.filter(p => p.state === 'active')).toHaveLength(62);
    expect(await f.store.getRecordings(a.id, 'a')).toEqual([{ ...r, downloadUrl: null }]);
    await access(join(f.root, 'objects', r.storageRef));
    await access(join(f.root, 'objects', 'a/unlinked.wav'));
    await f.store.beginBotProducer({ botId: a.id, namespace: 'a', recordingId: 'recovered-slot' });
    await expect(f.store.beginBotProducer({ botId: a.id, namespace: 'a', recordingId: 'full-again' })).rejects.toMatchObject({ code: 'BOT_STILL_ACTIVE' });
  } finally { await f.close(); }
});

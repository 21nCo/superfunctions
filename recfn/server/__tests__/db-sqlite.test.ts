import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { assertProductionStore, createDbStore } from '../src/store/db.js';
import { getRecFnSchema } from '../src/store/schema.js';
import type { BotConfig } from '@recfn/core';

const config: Required<BotConfig> = { displayName: 'Bot 文', joinTimeout: 30000, autoLeaveOnEmpty: true,
  autoLeaveEmptyTimeout: 30000, consentMessage: 'Recording', enableRealTimeTranscript: false,
  asrProvider: 'whisper', recordingFormat: 'mp4', language: 'en-US' };

it('persists all RecFn aggregate models through native SQLite close/reopen with internal schema codecs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recfn-store-'));
  const schema = getRecFnSchema();
  let sql: Kysely<any> | undefined;
  const connect = () => {
    sql = new Kysely({ dialect: new SqliteDialect({ database: new Database(join(directory, 'recfn.sqlite')) }) });
    return kyselyAdapter({ db: sql, dialect: 'sqlite', schema: Object.fromEntries(Object.keys(schema).map(name => [name, name])) });
  };
  try {
    let adapter = connect();
    for (const [model, table] of Object.entries(schema)) {
      let create = sql!.schema.createTable(model);
      for (const [field, definition] of Object.entries(table.fields)) {
        create = create.addColumn(field, definition.type === 'number' ? 'real' : definition.type === 'boolean' ? 'integer' : 'text', column => {
          if (field === 'id') column = column.primaryKey();
          else if (definition.unique) column = column.unique();
          return definition.required ? column.notNull() : column;
        });
      }
      await create.execute();
      for (const index of table.indexes ?? []) {
        let createIndex = sql!.schema.createIndex(index.name).on(model).columns(index.fields);
        if (index.unique) createIndex = createIndex.unique();
        await createIndex.execute();
      }
    }
    // No caller adapterSchema. Explicit durability describes this file-backed fixture.
    expect(() => assertProductionStore(createDbStore({ adapter }))).toThrow(/durable/);
    let store = createDbStore({ adapter, durable: true });
    expect(() => assertProductionStore(store)).not.toThrow();
    const bot = await store.createBot({ namespace: 'a', meetingUrl: 'https://meet.google.com/abc-defg-hij', platform: 'meet', config });
    const other = await store.createBot({ namespace: 'b', meetingUrl: 'https://meet.google.com/abc-defg-hij', platform: 'meet', config });
    const recording = { id: 'recording', botId: bot.id, format: 'wav' as const, duration: 12.5,
      storageRef: 'file.wav', size: 12, downloadUrl: 'https://example.test/file', createdAt: '2026-10-20T00:00:00.000Z' };
    await store.createRecording(recording, 'a');
    const segment = { speakerId: 'speaker', startTime: 0, endTime: 1, text: 'Hello 文', confidence: 0.9 };
    await store.createTranscript({ id: 'transcript', recordingId: recording.id, language: 'en', status: 'processing', segments: [], createdAt: recording.createdAt }, 'a');
    await store.updateTranscript('transcript', 'a', { status: 'ready', segments: [segment] });
    const participant = { id: 'person', botId: bot.id, name: 'Alice', role: 'host' as const, joinedAt: recording.createdAt, consent: 'pending' as const };
    await store.addParticipant(bot.id, participant, 'a');
    await store.addParticipant(bot.id, { ...participant, name: 'Alice updated' }, 'a');
    await store.updateParticipant(bot.id, 'person', 'a', { consent: 'granted' });
    const message = { participantId: 'person', text: 'Hello 文', timestamp: recording.createdAt };
    await store.addChatMessage(bot.id, message, 'a');
    await store.upsertMetadata(bot.id, { id: 'metadata', botId: bot.id, title: 'first', platform: 'meet', chatMessages: [] }, 'a');
    await store.upsertMetadata(bot.id, { id: 'metadata', botId: bot.id, title: 'second', platform: 'meet', chatMessages: [message] }, 'a');
    const webhook = await store.createWebhook({ url: 'https://example.test/hook', events: ['bot.done'], secret: 'secret' }, 'a');
    const calendar = await store.createCalendar({ provider: 'google', autoSchedule: true }, 'a');
    await store.setEventBotId(calendar.id, 'event', bot.id, 'a');
    await store.setEventBotId(calendar.id, 'event', bot.id, 'a');
    expect(typeof (await sql!.selectFrom('bots').select('config').where('id', '=', bot.id).executeTakeFirstOrThrow()).config).toBe('string');
    await adapter.close(); sql = undefined;
    adapter = connect(); store = createDbStore({ adapter, durable: true });
    expect((await store.getBot(bot.id, 'a'))?.config).toEqual(config);
    expect(await store.getBot(bot.id, 'b')).toBeNull();
    expect(await store.getRecordings(bot.id, 'a')).toEqual([recording]);
    expect(await store.getRecordings(bot.id, 'b')).toEqual([]);
    expect((await store.getTranscript(recording.id, 'a'))?.segments).toEqual([segment]);
    expect(await store.getTranscript(recording.id, 'b')).toBeNull();
    expect(await store.getParticipants(bot.id, 'a')).toHaveLength(1);
    expect((await store.getParticipants(bot.id, 'a'))[0]).toMatchObject({ name: 'Alice updated', consent: 'granted', joinedAt: recording.createdAt });
    expect(await store.getChatMessages(bot.id, 'a')).toEqual([message]);
    expect(await store.getMetadata(bot.id, 'a')).toMatchObject({ title: 'second', chatMessages: [message] });
    expect(await store.getWebhook(webhook.id, 'a')).toEqual(webhook);
    expect(await store.getWebhook(webhook.id, 'b')).toBeNull();
    expect(await store.getCalendar(calendar.id, 'a')).toEqual(calendar);
    expect(await store.getEventBotIds(calendar.id, ['event'], 'a')).toEqual(new Map([['event', bot.id]]));
    expect(await store.getEventBotIds(calendar.id, ['event'], 'b')).toEqual(new Map());
    expect(await store.deleteBot(bot.id, 'b')).toBe(false);
    expect(await store.deleteBot(bot.id, 'a')).toBe(true);
    expect(await store.getBot(other.id, 'b')).not.toBeNull();
    expect(await store.getTranscript(recording.id, 'a')).toBeNull();
    expect(await store.getEventBotIds(calendar.id, ['event'], 'a')).toEqual(new Map());
    await adapter.close(); sql = undefined;
    adapter = connect(); store = createDbStore({ adapter, durable: true });
    expect(await store.getBot(bot.id, 'a')).toBeNull();
    expect(await store.getBot(other.id, 'b')).not.toBeNull();
    await sql!.schema.dropTable('bots').execute();
    await expect(store.getBot(other.id, 'b')).rejects.toThrow(/no such table/);
  } finally {
    if (sql) await sql.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

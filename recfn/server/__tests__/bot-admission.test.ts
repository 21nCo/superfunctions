import { getRecFnSchema } from '../src/store/schema.js';
import { expect, it, vi } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/adapters';
import { validateBotConfig } from '@recfn/core';
import { createDbStore, assertProductionStore } from '../src/store/db.js';
import { createMemoryStore } from '../src/store/memory.js';
import { createRecFnServer, MemoryQueueAdapter, MemoryStorageAdapter, createMemoryTokenStore, createGoogleCalendarClient, createOutlookCalendarClient } from '../src/index.js';
import { pollAndSchedule } from '../src/calendar/scheduler.js';
import { req } from './helpers.js';

const input = { namespace: 'ns', meetingUrl: 'https://zoom.us/j/123', platform: 'zoom' as const,
  config: validateBotConfig({ enableRealTimeTranscript: false, recordingFormat: 'audio_only' }) };

it('atomically admits one of concurrent requests through two stores sharing the real adapter', async () => {
  const adapter = memoryAdapter();
  const a = createDbStore({ adapter, maxConcurrentBots: 1 }); const b = createDbStore({ adapter, maxConcurrentBots: 1 });
  const results = await Promise.allSettled([a.createBot(input), b.createBot(input)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'RATE_LIMIT_EXCEEDED' } });
  expect((await a.listBots('ns', { limit: 100 })).items).toHaveLength(1);
  expect(await b.createBot({ ...input, namespace: 'other' })).toMatchObject({ namespace: 'other' });
});

it('counts older active and finalizing bots beyond terminal history and gates direct reactivation', async () => {
  const store = createMemoryStore({ maxConcurrentBots: 2 });
  const older = await store.createBot(input); await store.updateBot(older.id, 'ns', { status: 'finalizing' });
  let terminal = older;
  for (let i = 0; i < 105; i++) { terminal = await store.createBot(input); await store.updateBot(terminal.id, 'ns', { status: 'done' }); }
  await store.createBot(input);
  await expect(store.createBot(input)).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
  await expect(store.updateBot(terminal.id, 'ns', { status: 'recording' })).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
  await store.updateBot(older.id, 'ns', { status: 'done' });
  expect(await store.updateBot(terminal.id, 'ns', { status: 'creating' })).toMatchObject({ status: 'creating' });
  await expect(store.createBot(input)).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
});

it('persists namespace policy and refuses silent cap changes or invalid configuration', async () => {
  const adapter = memoryAdapter(); const store = createDbStore({ adapter, maxConcurrentBots: 1 });
  await store.createBot(input);
  await expect(createDbStore({ adapter, maxConcurrentBots: 2 }).createBot(input)).rejects.toThrow('persisted namespace policy');
  expect(() => createDbStore({ adapter, maxConcurrentBots: 0 })).toThrow('positive safe integer');
  const unsupported = createDbStore({ adapter: { ...adapter, capabilities: { ...adapter.capabilities, operations: { ...adapter.capabilities.operations, upsert: false } } } });
  for (const id of ['prisma', 'custom-callback']) {
    const unverified = createDbStore({ adapter: { ...adapter, id } });
    expect(unverified.capabilities.botAdmission).toBeUndefined();
    await expect(unverified.createBot(input)).rejects.toThrow('supported shared');
  }
  expect(unsupported.capabilities.botAdmission).toBeUndefined();
  await expect(unsupported.createBot(input)).rejects.toThrow('transactional atomic upsert');
  expect(() => assertProductionStore({ ...store, capabilities: { ...store.capabilities, durable: true, botAdmission: undefined } })).toThrow('atomic namespace');
});

it('enforces API concurrency and retains capacity when a queue accepts then loses its acknowledgement', async () => {
  const store = createMemoryStore({ maxConcurrentBots: 1 }); const queue = new MemoryQueueAdapter();
  const original = queue.enqueue.bind(queue); let accepted = 0;
  queue.enqueue = async (...args) => { await original(...args); accepted++; throw new Error('acknowledgement lost'); };
  const server = createRecFnServer({ store, queue, storage: new MemoryStorageAdapter(), rateLimit: false, validateApiKey: key => ({ namespace: 'ns', apiKey: key }) });
  const request = () => req('POST', '/api/v1/bots', { body: { meetingUrl: input.meetingUrl, config: input.config } });
  expect((await server.router.handle(request())).status).toBe(500);
  expect((await server.router.handle(request())).status).toBe(429); expect(accepted).toBe(1);
  const bots = (await store.listBots('ns', { limit: 100 })).items;
  expect(bots).toHaveLength(1); expect(bots[0].status).toBe('creating');
  expect(await queue.dequeue('recfn.bot.join')).toMatchObject({ data: { botId: bots[0].id } });
});

it('applies the same admission to calendar scheduling and allows progress after terminal release', async () => {
  const store = createMemoryStore({ maxConcurrentBots: 1 }); const now = new Date();
  await store.createCalendar({ provider: 'google', autoSchedule: true }, 'ns');
  const deps = { store, tokenStore: createMemoryTokenStore(), googleClient: createGoogleCalendarClient(), outlookClient: createOutlookCalendarClient(), now: () => now,
    listCalendarEvents: async () => [1, 2].map(index => ({ id: String(index), meetingUrl: input.meetingUrl, startTime: new Date(now.getTime() + 30000).toISOString() })) };
  expect((await pollAndSchedule(deps, 'ns')).botsCreated).toBe(1);
  const [bot] = (await store.listBots('ns', { limit: 100 })).items;
  await store.updateBot(bot.id, 'ns', { status: 'done' });
  expect((await pollAndSchedule(deps, 'ns')).botsCreated).toBe(1);
  expect((await store.listBots('ns', { limit: 100 })).items.filter(value => value.status !== 'done')).toHaveLength(1);
});

it('returns one created response and one quota response for simultaneous API requests', async () => {
  const store = createMemoryStore({ maxConcurrentBots: 1 });
  const server = createRecFnServer({ store, storage: new MemoryStorageAdapter(), rateLimit: false, validateApiKey: key => ({ namespace: 'ns', apiKey: key }) });
  const responses = await Promise.all([1, 2].map(() => server.router.handle(req('POST', '/api/v1/bots', { body: { meetingUrl: input.meetingUrl, config: input.config } }))));
  expect(responses.map(response => response.status).sort()).toEqual([201, 429]);
  expect((await store.listBots('ns', { limit: 100 })).items).toHaveLength(1);
});

it('samples the environment at construction and gives explicit policy precedence', async () => {
  try {
    vi.stubEnv('RECFN_MAX_CONCURRENT_BOTS', '1');
    const sampled = createMemoryStore();
    const explicit = createMemoryStore({ maxConcurrentBots: 2 });
    vi.stubEnv('RECFN_MAX_CONCURRENT_BOTS', '3');
    await sampled.createBot(input);
    await expect(sampled.createBot(input)).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
    await explicit.createBot(input); await explicit.createBot(input);
    await expect(explicit.createBot(input)).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
    expect(createMemoryStore().capabilities.botAdmission?.maximum).toBe(3);
  } finally { vi.unstubAllEnvs(); }
});

it('uses one admission uniqueness arbiter and rejects policy identity tampering', async () => {
  const schema = getRecFnSchema();
  expect(schema.botAdmission.fields.id.unique).toBe(true);
  expect(schema.botAdmission.fields.namespace.unique).not.toBe(true);
  const adapter = memoryAdapter(); const store = createDbStore({ adapter, maxConcurrentBots: 1 });
  const bot = await store.createBot(input); await store.updateBot(bot.id, 'ns', { status: 'done' });
  await adapter.updateMany({ model: 'botAdmission', where: [{ field: 'namespace', operator: 'eq', value: 'ns' }], data: { namespace: 'tampered' } });
  await expect(store.createBot(input)).rejects.toThrow('persisted namespace policy');
});

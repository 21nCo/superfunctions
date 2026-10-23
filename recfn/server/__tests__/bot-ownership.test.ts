import { afterEach, expect, it, vi } from 'vitest';
import { validateBotConfig, type PlatformAdapter } from '@recfn/core';
import { createMemoryStore, createBotWorker, MemoryQueueAdapter, MemoryLogger } from '../src/index.js';
const input = { namespace: 'ns', platform: 'zoom' as const, meetingUrl: 'https://zoom.us/j/123', config: validateBotConfig({ enableRealTimeTranscript: false, recordingFormat: 'audio_only' }) };
const workers: ReturnType<typeof createBotWorker>[] = [];
afterEach(async () => { await Promise.all(workers.splice(0).map(worker => worker.cancelCaptures())); vi.unstubAllEnvs(); });
function adapter(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return { platform: 'zoom', join: vi.fn(async () => {}), leave: vi.fn(async () => {}), getAudioStream: vi.fn(() => new ReadableStream()),
    getParticipants: async () => [], onParticipantJoin() {}, onParticipantLeave() {}, getChatMessages: async () => [], onChatMessage() {}, sendChatMessage: async () => {},
    getMetadata: async () => ({ id: 'meta', botId: '', platform: 'zoom', chatMessages: [] }), isConnected: () => true, ...overrides };
}
function worker(store: ReturnType<typeof createMemoryStore>, queue: MemoryQueueAdapter, provider: PlatformAdapter) {
  const value = createBotWorker({ environment: 'test', store, queue, recoveryNamespaces: ['empty', 'ns'], logger: new MemoryLogger(), platformAdapterFactories: new Map([['zoom', () => provider]]), shutdownTimeoutMs: 30 });
  workers.push(value); return value;
}
async function enqueue(queue: MemoryQueueAdapter, botId: string) {
  await queue.enqueue('recfn.bot.join', { type: 'bot.join', data: { botId, namespace: 'ns' }, createdAt: new Date().toISOString() });
}
it('claims before provider factory and retains capacity after lost join ACK even when leave is a no-op', async () => {
  const store = createMemoryStore({ maxConcurrentBots: 1 }); const bot = await store.createBot(input); const queue = new MemoryQueueAdapter();
  await enqueue(queue, bot.id); await enqueue(queue, bot.id);
  const provider = adapter({ join: vi.fn(async () => { throw new Error('remote accepted, ACK lost'); }) });
  await Promise.all([worker(store, queue, provider).processNext(), worker(store, queue, provider).processNext()]);
  expect(provider.join).toHaveBeenCalledTimes(1);
  await expect.poll(async () => (await store.getBotWork(bot.id, 'ns'))?.state).toBe('uncertain');
  expect((await store.getBot(bot.id, 'ns'))?.status).toBe('error');
  await expect(store.createBot(input)).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
  await expect(store.updateBot(bot.id, 'ns', { status: 'leaving' })).rejects.toMatchObject({ code: 'BOT_STILL_ACTIVE' });
  await expect(store.deleteBot(bot.id, 'ns')).rejects.toMatchObject({ code: 'BOT_STILL_ACTIVE' });
  const claim = await store.getBotWork(bot.id, 'ns');
  await expect(store.reconcileBotWork(bot.id, 'ns', 'wrong', { workerStopped: true, providerStopped: true, reason: 'fixture stopped' })).rejects.toBeDefined();
  expect(() => store.reconcileBotWork(bot.id, 'ns', claim!.ownerToken!, { workerStopped: true, providerStopped: true, reason: ' ' })).toThrow();
  await store.reconcileBotWork(bot.id, 'ns', claim!.ownerToken!, { workerStopped: true, providerStopped: true, reason: 'fixture original worker and remote session independently stopped' });
  expect(await store.getBotWork(bot.id, 'ns')).toMatchObject({ state: 'closed', heldTerminalCapacity: false });
  await expect(store.updateBot(bot.id, 'ns', { status: 'creating' })).rejects.toBeDefined();
  expect(await store.createBot(input)).toMatchObject({ status: 'creating' });
});
it('recovers a durable intent after queue acceptance loses ACK and destructive dequeue loses the job', async () => {
  vi.stubEnv('RECFN_POC_JOIN_ONLY', '1');
  const store = createMemoryStore(); const bot = await store.createBot(input); const queue = new MemoryQueueAdapter();
  const enqueueActual = queue.enqueue.bind(queue);
  queue.enqueue = async (...args) => { await enqueueActual(...args); throw new Error('ACK lost'); };
  await expect(enqueue(queue, bot.id)).rejects.toThrow('ACK lost');
  expect(await queue.dequeue('recfn.bot.join')).not.toBeNull();
  const provider = adapter();
  expect(await worker(store, queue, provider).processNext()).toBe(true);
  expect(provider.join).toHaveBeenCalledTimes(1);
  expect((await store.getBotWork(bot.id, 'ns'))?.state).toBe('owned');
  expect(await worker(store, queue, provider).processNext()).toBe(false);
  expect(provider.join).toHaveBeenCalledTimes(1);
});
it('a different worker consuming finalization cannot fail the owner and the owner polls durable leaving state', async () => {
  vi.stubEnv('RECFN_POC_JOIN_ONLY', '1');
  const store = createMemoryStore({ maxConcurrentBots: 1 }); const bot = await store.createBot(input); const queue = new MemoryQueueAdapter(); const provider = adapter();
  const owner = worker(store, queue, provider); await owner.processNext();
  await store.updateBot(bot.id, 'ns', { status: 'leaving' });
  await queue.enqueue('recfn.recording.upload', { type: 'recording.finalize', data: { botId: bot.id, namespace: 'ns' }, createdAt: new Date().toISOString() });
  await worker(store, queue, adapter()).processNext();
  expect((await store.getBot(bot.id, 'ns'))?.status).toBe('leaving');
  await owner.processNext();
  expect(provider.leave).toHaveBeenCalledTimes(1);
  expect(await store.createBot(input)).toMatchObject({ status: 'creating' });
  expect((await store.getBot(bot.id, 'ns'))?.status).toBe('done');
  expect(await store.getBotWork(bot.id, 'ns')).toMatchObject({ state: 'closed', heldTerminalCapacity: false });
});
it('shutdown during join never starts late capture or a replacement join', async () => {
  let finish!: () => void;
  const joining = new Promise<void>(resolve => { finish = resolve; });
  const provider = adapter({ join: vi.fn(() => joining) });
  const store = createMemoryStore(); const bot = await store.createBot(input); const queue = new MemoryQueueAdapter();
  const owner = worker(store, queue, provider); const processing = owner.processNext();
  await expect.poll(() => vi.mocked(provider.join).mock.calls.length).toBe(1);
  expect(await owner.cancelCaptures()).toEqual({ unresolvedBotIds: [bot.id] });
  await processing;
  expect((await store.getBotWork(bot.id, 'ns'))?.state).toBe('uncertain');
  expect(await worker(store, queue, adapter()).processNext()).toBe(false);
  finish(); await processing;
  await expect.poll(async () => (await store.getBotWork(bot.id, 'ns'))?.state).toBe('closed');
  expect(provider.getAudioStream).not.toHaveBeenCalled();
  expect(provider.leave).toHaveBeenCalledTimes(1);
});
it('settles a claim cancelled during joining notification before provider acquisition', async () => {
  const store = createMemoryStore({ maxConcurrentBots: 1 }); const bot = await store.createBot(input); const queue = new MemoryQueueAdapter();
  const logger = new MemoryLogger(); const original = logger.info.bind(logger); const factory = vi.fn(() => adapter());
  let shutdown: Promise<{ unresolvedBotIds: string[] }> | undefined;
  const owner = createBotWorker({ environment: 'test', store, queue, logger, recoveryNamespaces: ['ns'], platformAdapterFactories: new Map([['zoom', factory]]) });
  workers.push(owner);
  logger.info = (event, data) => { original(event, data); if (event === 'bot.status_change' && data?.to === 'joining') shutdown = owner.cancelCaptures(); };
  await owner.processNext(); await shutdown;
  expect(factory).not.toHaveBeenCalled();
  expect(await store.getBotWork(bot.id, 'ns')).toMatchObject({ state: 'closed', heldTerminalCapacity: false });
  expect(await store.getBot(bot.id, 'ns')).toMatchObject({ status: 'error' });
  expect(await store.createBot(input)).toMatchObject({ status: 'creating' });
});

it('serializes overlapping recovery calls and surfaces durable scan failures for host backoff', async () => {
  vi.stubEnv('RECFN_POC_JOIN_ONLY', '1');
  const store = createMemoryStore(); await store.createBot(input); const queue = new MemoryQueueAdapter();
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  const provider = adapter({ join: vi.fn(() => pending) }); const owner = worker(store, queue, provider);
  const first = owner.processNext();
  await expect.poll(() => vi.mocked(provider.join).mock.calls.length).toBe(1);
  expect(await owner.processNext()).toBe(false);
  release(); await first;
  const failing = worker({ ...store, listPendingBotJoins: async () => { throw new Error('database unavailable'); } }, queue, adapter());
  await expect(failing.processNext()).rejects.toThrow('database unavailable');
});

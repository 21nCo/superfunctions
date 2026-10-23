// Local built-source race fixture: no network, provider, or filesystem artifacts.
import { createMemoryStore, createBotWorker, MemoryQueueAdapter, MemoryLogger } from '../server/dist/index.js';
import { validateBotConfig } from '../core/dist/index.js';
const base = createMemoryStore({ maxConcurrentBots: 1 });
const bot = await base.createBot({ namespace: 'duplicate-worker-fixture', platform: 'zoom', meetingUrl: 'https://zoom.us/j/123', config: validateBotConfig({ enableRealTimeTranscript: false, recordingFormat: 'audio_only' }) });
// Align the two initial reads and the two transition reads before either write.
let reads = 0; let release;
let barrier = new Promise(resolve => { release = resolve; });
const store = { ...base, async getBot(...args) {
  const snapshot = await base.getBot(...args);
  if (reads < 4) {
    const wait = barrier; reads++;
    if (reads % 2 === 0) { release(); barrier = new Promise(resolve => { release = resolve; }); }
    await wait;
  }
  return snapshot;
} };
const queue = new MemoryQueueAdapter();
for (let i = 0; i < 2; i++) await queue.enqueue('recfn.bot.join', { type: 'bot.join', data: { botId: bot.id, namespace: bot.namespace }, createdAt: new Date().toISOString() });
let joins = 0;
const logger = new MemoryLogger();
const workers = [1, 2].map(() => createBotWorker({ environment: 'test', store, queue, logger,
  platformAdapterFactories: new Map([['zoom', () => ({ async join() { joins++; throw new Error('fixture: provider request accepted, acknowledgement lost'); } })]]) }));
await Promise.all(workers.map(worker => worker.processNext()));
await Promise.all(workers.map(worker => worker.cancelCaptures()));
console.log(JSON.stringify({ configuredCap: 1, botRows: (await base.listBots(bot.namespace, {})).items.length, joins, status: (await base.getBot(bot.id, bot.namespace)).status }));
// Baseline worker leaves its join timeout scheduled even after rejection. This
// fixture leaves that handle intact and exits naturally after the real timer.

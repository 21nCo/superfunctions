import { describe, it, expect, beforeEach } from 'vitest';
import { createTestServer, req, json } from './helpers.js';
import {
  MemoryQueueAdapter,
  QUEUE_NAMES,
  MemoryLogger,
  createRecFnServer,
  createMemoryStore,
} from '../src/index.js';

describe('flowfn integration (TV-INT-001)', () => {
  it('POST /bots enqueues a bot.join job', async () => {
    const store = createMemoryStore();
    const queue = new MemoryQueueAdapter();
    const logger = new MemoryLogger();

    const server = createRecFnServer({
      store,
      queue,
      logger,
      validateApiKey: (key) =>
        key === 'sk-valid-key'
          ? { namespace: 'ns_test', apiKey: key }
          : null,
    });

    const res = await server.router.handle(
      new Request('http://localhost/api/v1/bots', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sk-valid-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          meetingUrl: 'https://zoom.us/j/1234567890',
        }),
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    const botId = (body.data as Record<string, unknown>).id;

    // Verify job was enqueued
    expect(queue.size(QUEUE_NAMES.BOT_JOIN)).toBe(1);
    const job = await queue.dequeue(QUEUE_NAMES.BOT_JOIN);
    expect(job).not.toBeNull();
    expect(job!.type).toBe('bot.join');
    expect(job!.data.botId).toBe(botId);
    expect(job!.data.namespace).toBe('ns_test');
  });

  it('job can be dequeued and processed', async () => {
    const queue = new MemoryQueueAdapter();

    await queue.enqueue(QUEUE_NAMES.BOT_JOIN, {
      type: 'bot.join',
      data: { botId: 'bot_123', namespace: 'ns_test' },
      createdAt: new Date().toISOString(),
    });

    expect(queue.size(QUEUE_NAMES.BOT_JOIN)).toBe(1);

    const job = await queue.dequeue(QUEUE_NAMES.BOT_JOIN);
    expect(job).not.toBeNull();
    expect(job!.data.botId).toBe('bot_123');

    expect(queue.size(QUEUE_NAMES.BOT_JOIN)).toBe(0);
  });

  it('multiple jobs are processed in FIFO order', async () => {
    const queue = new MemoryQueueAdapter();

    await queue.enqueue(QUEUE_NAMES.BOT_JOIN, {
      type: 'bot.join',
      data: { botId: 'bot_1', namespace: 'ns_test' },
      createdAt: new Date().toISOString(),
    });
    await queue.enqueue(QUEUE_NAMES.BOT_JOIN, {
      type: 'bot.join',
      data: { botId: 'bot_2', namespace: 'ns_test' },
      createdAt: new Date().toISOString(),
    });
    await queue.enqueue(QUEUE_NAMES.BOT_JOIN, {
      type: 'bot.join',
      data: { botId: 'bot_3', namespace: 'ns_test' },
      createdAt: new Date().toISOString(),
    });

    const j1 = await queue.dequeue(QUEUE_NAMES.BOT_JOIN);
    const j2 = await queue.dequeue(QUEUE_NAMES.BOT_JOIN);
    const j3 = await queue.dequeue(QUEUE_NAMES.BOT_JOIN);

    expect(j1!.data.botId).toBe('bot_1');
    expect(j2!.data.botId).toBe('bot_2');
    expect(j3!.data.botId).toBe('bot_3');
  });

  it('peek shows jobs without removing them', async () => {
    const queue = new MemoryQueueAdapter();

    await queue.enqueue(QUEUE_NAMES.BOT_JOIN, {
      type: 'bot.join',
      data: { botId: 'bot_1', namespace: 'ns_test' },
      createdAt: new Date().toISOString(),
    });

    const peeked = queue.peek(QUEUE_NAMES.BOT_JOIN);
    expect(peeked.length).toBe(1);
    expect(queue.size(QUEUE_NAMES.BOT_JOIN)).toBe(1); // Still there
  });

  it('bot.created is logged when creating a bot with logger', async () => {
    const store = createMemoryStore();
    const queue = new MemoryQueueAdapter();
    const logger = new MemoryLogger();

    const server = createRecFnServer({
      store,
      queue,
      logger,
      validateApiKey: (key) =>
        key === 'sk-valid-key'
          ? { namespace: 'ns_test', apiKey: key }
          : null,
    });

    await server.router.handle(
      new Request('http://localhost/api/v1/bots', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sk-valid-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          meetingUrl: 'https://zoom.us/j/123',
        }),
      }),
    );

    const createdLogs = logger.findByEvent('bot.created');
    expect(createdLogs.length).toBe(1);
    expect(createdLogs[0].data.platform).toBe('zoom');
  });
});

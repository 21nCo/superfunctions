import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { deliverWebhookEvent } from '../src/integrations/plugfn.js';
import type { PlatformAdapter, Segment } from 'recfn';
import {
  createRecFnServer,
  createMemoryStore,
  MemoryStorageAdapter,
  MemoryQueueAdapter,
  MemoryLogger,
  QUEUE_NAMES,
  createBotWorker,
  processTranscriptionJob,
  createAsrRegistry,
  createSearchFnClient,
  createMetricsEmitter,
} from '../src/index.js';
import type { RecFnStore } from '../src/store/types.js';

const API_KEYS: Record<string, { namespace: string; apiKey: string }> = {
  'sk-valid-key': { namespace: 'ns_e2e', apiKey: 'sk-valid-key' },
};

describe('End-to-end integration (Phase 20)', () => {
  let store: RecFnStore;
  let queue: MemoryQueueAdapter;
  let logger: MemoryLogger;
  const webhookDeliveries: Array<{ event: string; payload: unknown }> = [];
  const metricsEvents: Array<{ event: string; props?: Record<string, unknown> }> = [];

  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    store = createMemoryStore();
    queue = new MemoryQueueAdapter();
    logger = new MemoryLogger();
    webhookDeliveries.length = 0;
    metricsEvents.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('webhook.example.com')) {
          const payload = JSON.parse((init?.body as string) ?? '{}');
          webhookDeliveries.push({ event: payload.event, payload });
          return new Response('OK', { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
  });

  it('full flow: create bot → join (mock) → record → transcribe → analytics → search → webhook delivery', async () => {
    const storage = new MemoryStorageAdapter();
    const searchClient = createSearchFnClient();
    const metrics = createMetricsEmitter((e, p) => metricsEvents.push({ event: e, props: p }));

    const server = createRecFnServer({
      store,
      storage,
      queue,
      logger,
      searchClient,
      metrics,
      rateLimit: false,
      validateApiKey: (key: string) => API_KEYS[key] ?? null,
    });

    await store.createWebhook(
      {
        id: 'wh_e2e',
        url: 'https://webhook.example.com/callback',
        events: ['bot.joined', 'recording.ready', 'transcript.ready'],
        secret: 'whsec_test',
        createdAt: new Date().toISOString(),
      },
      'ns_e2e',
    );

    const createRes = await server.router.handle(
      new Request('http://localhost/api/v1/bots', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sk-valid-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ meetingUrl: 'https://zoom.us/j/123456' }),
      }),
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as { ok: boolean; data: { id: string } };
    const botId = createBody.data.id;

    const mockAdapter: PlatformAdapter = {
      platform: 'zoom',
      async join() {},
      async leave() {},
      getAudioStream: () => new ReadableStream(),
      async getParticipants() { return []; },
      onParticipantJoin() {},
      onParticipantLeave() {},
      async getChatMessages() { return []; },
      onChatMessage() {},
      async sendChatMessage() {},
      async getMetadata() {
        return { id: 'meta_1', botId: '', platform: 'zoom', chatMessages: [] };
      },
      isConnected: () => true,
    };

    const worker = createBotWorker({
      store,
      queue,
      logger,
      platformAdapters: new Map([['zoom', mockAdapter]]),
      metrics,
    });

    const processed = await worker.processNext();
    expect(processed).toBe(true);

    const bot = await store.getBot(botId, 'ns_e2e');
    expect(bot).not.toBeNull();
    expect(bot!.status).toBe('recording');

    const uploadForm = new FormData();
    uploadForm.append('file', new Blob([new Uint8Array([1, 2, 3, 4, 5])]), 'rec.webm');

    const uploadRes = await server.router.handle(
      new Request(`http://localhost/api/v1/recordings/upload?botId=${botId}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer sk-valid-key' },
        body: uploadForm,
      }),
    );
    expect(uploadRes.status).toBe(201);
    const uploadBody = (await uploadRes.json()) as { ok: boolean; data: { id: string } };
    const recordingId = uploadBody.data.id;

    const transcribeRes = await server.router.handle(
      new Request(`http://localhost/api/v1/recordings/${recordingId}/transcribe`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sk-valid-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ asrProvider: 'whisper', language: 'en-US' }),
      }),
    );
    expect(transcribeRes.status).toBe(202);

    const transcriptJob = await queue.dequeue(QUEUE_NAMES.TRANSCRIPTION);
    expect(transcriptJob).not.toBeNull();

    const registry = createAsrRegistry();
    registry.register({
      name: 'whisper',
      async *transcribeStream() { throw new Error('Not used'); },
      async transcribeBatch(): Promise<Segment[]> {
        return [
          { speakerId: 's1', startTime: 0, endTime: 5000, text: 'Hello world', confidence: 0.95 },
          { speakerId: 's2', startTime: 6000, endTime: 10000, text: 'Action items discussed', confidence: 0.92 },
        ];
      },
      supportedLanguages: () => ['en'],
    });

    const webhookDeliverer = {
      deliver: (ns: string, ev: string, pl: unknown) =>
        deliverWebhookEvent(ns, ev, pl as import('../src/webhooks/events.js').WebhookPayload, { store, metrics }),
    };

    const transcript = await processTranscriptionJob(
      {
        recordingId: transcriptJob!.data.recordingId as string,
        namespace: transcriptJob!.data.namespace as string,
        audioRef: transcriptJob!.data.audioRef as string,
        asrProvider: 'whisper',
        language: 'en-US',
        transcriptId: transcriptJob!.data.transcriptId as string,
      },
      {
        store,
        logger,
        asrRegistry: registry,
        webhookDeliverer,
        searchClient,
        metrics,
      },
    );
    expect(transcript.status).toBe('ready');
    expect(transcript.segments).toHaveLength(2);

    const analyticsRes = await server.router.handle(
      new Request(`http://localhost/api/v1/recordings/${recordingId}/analytics`, {
        headers: { Authorization: 'Bearer sk-valid-key' },
      }),
    );
    expect(analyticsRes.status).toBe(200);
    const analyticsBody = (await analyticsRes.json()) as { ok: boolean; data: { totalDuration: number } };
    expect(analyticsBody.data.totalDuration).toBe(0);

    const searchRes = await server.router.handle(
      new Request('http://localhost/api/v1/transcripts/search?q=action+items&limit=5', {
        headers: { Authorization: 'Bearer sk-valid-key' },
      }),
    );
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as { ok: boolean; data: { results: unknown[] } };
    expect(Array.isArray(searchBody.data.results)).toBe(true);

    expect(webhookDeliveries.some((d) => d.event === 'bot.joined')).toBe(true);
    expect(logger.findByEvent('bot.status_change').length).toBeGreaterThan(0);
    expect(logger.findByEvent('bot.join_latency').length).toBe(1);
    expect(metricsEvents.some((e) => e.event === 'recfn.bots.active')).toBe(true);
    expect(metricsEvents.some((e) => e.event === 'recfn.asr.latency_ms')).toBe(true);
  });
});

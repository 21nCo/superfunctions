import { describe, it, expect, beforeEach } from 'vitest';
import { createRecFnServer, createMemoryStore, MemoryStorageAdapter, createSearchFnClient } from '../src/index.js';
import type { RecFnServer } from '../src/index.js';
import type { RecFnStore } from '../src/store/types.js';
import { indexTranscript } from '../src/search/indexer.js';

const API_KEYS: Record<string, { namespace: string; apiKey: string }> = {
  'sk-valid-key': { namespace: 'ns_test', apiKey: 'sk-valid-key' },
};

function createTestServerWithSearch() {
  const store = createMemoryStore();
  const storage = new MemoryStorageAdapter();
  const searchClient = createSearchFnClient();

  const server = createRecFnServer({
    store,
    storage,
    searchClient,
    validateApiKey: (key: string) => API_KEYS[key] ?? null,
  });

  return { server, store, searchClient };
}

function req(method: string, path: string, opts?: { body?: unknown; apiKey?: string }): Request {
  const headers: Record<string, string> = {
    Authorization: opts?.apiKey !== undefined && opts.apiKey !== '' ? `Bearer ${opts.apiKey}` : 'Bearer sk-valid-key',
  };
  if (opts?.body) headers['Content-Type'] = 'application/json';
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
}

async function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

describe('Search API routes', () => {
  let server: RecFnServer;
  let store: RecFnStore;
  let searchClient: ReturnType<typeof createSearchFnClient>;

  beforeEach(() => {
    ({ server, store, searchClient } = createTestServerWithSearch());
  });

  it('returns search results (TV-SRCH-002)', async () => {
    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/123', platform: 'zoom',
      config: {
        displayName: 'Bot', joinTimeout: 30000, autoLeaveOnEmpty: true,
        autoLeaveEmptyTimeout: 30000, consentMessage: 'Rec',
        enableRealTimeTranscript: false, asrProvider: 'whisper',
        recordingFormat: 'mp4', language: 'en-US',
      },
      namespace: 'ns_test',
    });

    await store.createRecording({
      id: 'rec_xyz789', botId: bot.id, format: 'mp4',
      duration: 60000, storageRef: 'recordings/ns_test/rec_xyz789.mp4',
      size: 512, createdAt: new Date().toISOString(),
    }, 'ns_test');

    await store.createTranscript({
      id: 'trx_1', recordingId: 'rec_xyz789', language: 'en-US',
      status: 'ready',
      segments: [
        { speakerId: 'participant_1', startTime: 45000, endTime: 48000, text: 'Let me summarize the action items.', confidence: 0.94 },
      ],
      createdAt: new Date().toISOString(),
    }, 'ns_test');

    indexTranscript(
      { recordingId: 'rec_xyz789', botId: bot.id, segments: [{ speakerId: 'participant_1', startTime: 45000, endTime: 48000, text: 'Let me summarize the action items.', confidence: 0.94 }] },
      searchClient,
    );

    const res = await server.router.handle(
      req('GET', '/api/v1/transcripts/search?q=action+items&limit=5'),
    );

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    const data = body.data as { results: unknown[] };
    expect(Array.isArray(data.results)).toBe(true);
  });

  it('returns 400 when q is missing', async () => {
    const res = await server.router.handle(
      req('GET', '/api/v1/transcripts/search'),
    );
    expect(res.status).toBe(400);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import {
  createMemoryStore,
  createRecFnServer,
  createSearchFnClient,
  MemoryStorageAdapter,
} from '../src/index.js';
import { indexTranscript } from '../src/search/indexer.js';
import type { RecFnServer } from '../src/index.js';
import type { RecFnStore } from '../src/store/types.js';

const API_KEYS: Record<string, { namespace: string; apiKey: string }> = {
  'sk-valid-key': { namespace: 'ns_test', apiKey: 'sk-valid-key' },
  'sk-other-key': { namespace: 'ns_other', apiKey: 'sk-other-key' },
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

function req(method: string, path: string, opts?: { apiKey?: string }): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${opts?.apiKey ?? 'sk-valid-key'}`,
    },
  });
}

async function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

async function createBotWithTranscript(input: {
  store: RecFnStore;
  searchClient: ReturnType<typeof createSearchFnClient>;
  namespace: string;
  recordingId: string;
  segments: Array<{
    speakerId: string;
    startTime: number;
    endTime: number;
    text: string;
    confidence: number;
  }>;
  participant?: {
    id: string;
    name: string;
    role?: 'attendee' | 'host' | 'bot';
    email?: string;
  };
}): Promise<string> {
  const bot = await input.store.createBot({
    meetingUrl: 'https://zoom.us/j/123',
    platform: 'zoom',
    config: {
      displayName: 'Bot',
      joinTimeout: 30000,
      autoLeaveOnEmpty: true,
      autoLeaveEmptyTimeout: 30000,
      consentMessage: 'Rec',
      enableRealTimeTranscript: false,
      asrProvider: 'whisper',
      recordingFormat: 'mp4',
      language: 'en-US',
    },
    namespace: input.namespace,
  });

  if (input.participant) {
    await input.store.addParticipant(
      bot.id,
      {
        id: input.participant.id,
        botId: bot.id,
        name: input.participant.name,
        email: input.participant.email,
        role: input.participant.role ?? 'attendee',
        joinedAt: new Date().toISOString(),
        consent: 'granted',
      },
      input.namespace,
    );
  }

  await input.store.createRecording(
    {
      id: input.recordingId,
      botId: bot.id,
      format: 'mp4',
      duration: 60000,
      storageRef: `recordings/${input.namespace}/${input.recordingId}.mp4`,
      size: 512,
      createdAt: new Date().toISOString(),
    },
    input.namespace,
  );

  await input.store.createTranscript(
    {
      id: `${input.recordingId}_trx`,
      recordingId: input.recordingId,
      language: 'en-US',
      status: 'ready',
      segments: input.segments,
      createdAt: new Date().toISOString(),
    },
    input.namespace,
  );

  await indexTranscript(
    {
      recordingId: input.recordingId,
      botId: bot.id,
      segments: input.segments,
    },
    input.searchClient,
  );

  return bot.id;
}

describe('Search API routes', () => {
  let server: RecFnServer;
  let store: RecFnStore;
  let searchClient: ReturnType<typeof createSearchFnClient>;

  beforeEach(() => {
    ({ server, store, searchClient } = createTestServerWithSearch());
  });

  it('returns participant-aware, deterministic search hits and preserves namespace scope (TV-SEARCH-001)', async () => {
    await createBotWithTranscript({
      store,
      searchClient,
      namespace: 'ns_test',
      recordingId: 'rec_001',
      participant: {
        id: 'par_123',
        name: 'Alex',
      },
      segments: [
        {
          speakerId: 'par_prev',
          startTime: 1000,
          endTime: 2000,
          text: 'previous segment',
          confidence: 0.91,
        },
        {
          speakerId: 'par_123',
          startTime: 2000,
          endTime: 3000,
          text: 'budget discussion',
          confidence: 0.94,
        },
        {
          speakerId: 'par_next',
          startTime: 3000,
          endTime: 4000,
          text: 'next segment',
          confidence: 0.92,
        },
      ],
    });

    await createBotWithTranscript({
      store,
      searchClient,
      namespace: 'ns_test',
      recordingId: 'rec_002',
      participant: {
        id: 'par_999',
        name: 'Morgan',
      },
      segments: [
        {
          speakerId: 'par_999',
          startTime: 1500,
          endTime: 2500,
          text: 'budget summary',
          confidence: 0.9,
        },
      ],
    });

    await createBotWithTranscript({
      store,
      searchClient,
      namespace: 'ns_other',
      recordingId: 'rec_outside',
      participant: {
        id: 'par_out',
        name: 'Outside',
      },
      segments: [
        {
          speakerId: 'par_out',
          startTime: 1000,
          endTime: 2000,
          text: 'budget discussion',
          confidence: 0.88,
        },
      ],
    });

    const res = await server.router.handle(
      req('GET', '/api/v1/transcripts/search?q=budget&limit=5'),
    );

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);

    const data = body.data as {
      results: Array<{
        recordingId: string;
        participant: { id: string; name: string } | null;
        context: Array<{ text: string }>;
      }>;
    };

    expect(data.results.map((result) => result.recordingId)).toEqual([
      'rec_001',
      'rec_002',
    ]);
    expect(data.results[0]?.participant).toEqual({
      id: 'par_123',
      name: 'Alex',
      email: undefined,
      role: 'attendee',
    });
    expect(data.results[0]?.context.map((segment) => segment.text)).toEqual([
      'previous segment',
      'budget discussion',
      'next segment',
    ]);
  });

  it('returns 400 when q is missing', async () => {
    const res = await server.router.handle(
      req('GET', '/api/v1/transcripts/search'),
    );
    expect(res.status).toBe(400);
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TRANSCRIPT_STREAM_FRAME_SCHEMA } from '@recfn/core';
import { WebSocket } from 'ws';
import {
  TranscriptStreamManager,
  MAX_CONNECTIONS_PER_BOT,
} from '../src/ws/transcript-stream.js';
import { createFrame } from '../src/ws/frames.js';
import { transitionBot } from '../src/worker/lifecycle.js';
import {
  createMemoryStore,
  createNoopLogger,
} from '../src/index.js';

describe('TranscriptStreamManager', () => {
  let manager: TranscriptStreamManager;

  beforeEach(() => {
    manager = new TranscriptStreamManager();
  });

  function createMockWebSocket() {
    return {
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      readyState: WebSocket.OPEN,
    } as unknown as WebSocket;
  }

  it('uses the shared canonical schema for status frames (TV-WS-002)', () => {
    expect(TRANSCRIPT_STREAM_FRAME_SCHEMA.status.requiredKeys).toEqual(['botStatus']);
  });

  it('allows adding connections and broadcasts canonical status frames', () => {
    const ws1 = createMockWebSocket();
    const ws2 = createMockWebSocket();

    manager.addConnection('bot_1', ws1);
    manager.addConnection('bot_1', ws2);

    manager.broadcast('bot_1', 'status', { botStatus: 'recording' });

    const expectedFrame = JSON.stringify({
      type: 'status',
      data: { botStatus: 'recording' },
    });
    expect(ws1.send).toHaveBeenCalledWith(expectedFrame);
    expect(ws2.send).toHaveBeenCalledWith(expectedFrame);
  });

  it('rejects legacy status payloads at the server frame layer (TV-WS-002)', () => {
    expect(() => createFrame('status', { status: 'recording' })).toThrow(
      'Invalid transcript frame for type "status".',
    );
  });

  it('defaults participant consent when omitted from a joined frame', () => {
    const frame = createFrame('participant_joined', {
      id: 'par_1',
      botId: 'bot_1',
      name: 'Alice',
      role: 'attendee',
      joinedAt: '2026-04-01T10:00:00.000Z',
    });

    expect(JSON.parse(frame)).toEqual({
      type: 'participant_joined',
      data: {
        id: 'par_1',
        botId: 'bot_1',
        name: 'Alice',
        role: 'attendee',
        joinedAt: '2026-04-01T10:00:00.000Z',
        consent: 'pending',
      },
    });
  });

  it('enforces maximum connections per bot limit', () => {
    for (let i = 0; i < MAX_CONNECTIONS_PER_BOT; i++) {
      manager.addConnection('bot_limit', createMockWebSocket());
    }

    const wsReject = createMockWebSocket();
    const result = manager.addConnection('bot_limit', wsReject);

    expect(result).toBe(false);
    expect(wsReject.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'error',
        data: {
          code: 'WS_LIMIT_EXCEEDED',
          message: 'Maximum concurrent connections reached.',
        },
      }),
    );
    expect(wsReject.close).toHaveBeenCalledWith(1008, 'Limit Exceeded');
  });

  it('closes all connections for a bot', () => {
    const ws1 = createMockWebSocket();
    const ws2 = createMockWebSocket();

    manager.addConnection('bot_close', ws1);
    manager.addConnection('bot_close', ws2);

    manager.closeAll('bot_close', 1000, 'Bot Left');

    expect(ws1.close).toHaveBeenCalledWith(1000, 'Bot Left');
    expect(ws2.close).toHaveBeenCalledWith(1000, 'Bot Left');
  });

  it('handles ping messages', () => {
    const ws = createMockWebSocket();
    manager.addConnection('bot_ping', ws);

    const onMessage = vi
      .mocked(ws.on)
      .mock.calls.find((call) => call[0] === 'message')?.[1] as Function;
    expect(onMessage).toBeDefined();

    onMessage(Buffer.from(JSON.stringify({ type: 'ping' })));

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }));
  });

  it('emits lifecycle status updates with botStatus keys', async () => {
    const store = createMemoryStore();
    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/123',
      platform: 'zoom',
      config: {
        displayName: 'RecFn Bot',
        joinTimeout: 30000,
        autoLeaveOnEmpty: true,
        autoLeaveEmptyTimeout: 30000,
        consentMessage: 'This meeting is being recorded',
        enableRealTimeTranscript: false,
        asrProvider: 'whisper',
        recordingFormat: 'mp4',
        language: 'en-US',
      },
      namespace: 'ns_test',
    });
    const streamManager = {
      broadcast: vi.fn(),
      closeAll: vi.fn(),
    };

    await transitionBot(
      {
        store,
        logger: createNoopLogger(),
        streamManager,
      },
      bot.id,
      'ns_test',
      'joining',
    );

    expect(streamManager.broadcast).toHaveBeenCalledWith(bot.id, 'status', {
      botStatus: 'joining',
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TRANSCRIPT_STREAM_FRAME_SCHEMA } from '@recfn/core';
import { RecFn } from '../src/index.js';

describe('Transcript WebSocket stream', () => {
  const OriginalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.stubGlobal(
      'WebSocket',
      vi.fn().mockImplementation((url: string) => {
        const ws = {
          readyState: 1,
          send: vi.fn(),
          close: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        };
        ws.readyState = 1; // OPEN
        return ws;
      }),
    );
  });

  afterEach(() => {
    vi.stubGlobal('WebSocket', OriginalWebSocket);
  });

  it('creates WebSocket connection with token in URL', () => {
    const client = new RecFn({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-test',
    });

    const stream = client.transcripts.stream('bot_123');

    expect(globalThis.WebSocket).toHaveBeenCalledWith(
      expect.stringContaining('ws://localhost:3000/ws/transcripts/bot_123'),
    );
    expect(WebSocket).toHaveBeenCalledWith(
      expect.stringContaining('token=sk-test'),
    );

    stream.close();
  });

  it('emits segment events', (done) => {
    let wsInstance: { onmessage?: (ev: { data: string }) => void } = {};

    vi.stubGlobal(
      'WebSocket',
      vi.fn().mockImplementation(() => {
        wsInstance = {
          readyState: 1,
          send: vi.fn(),
          close: vi.fn(),
        };
        setTimeout(() => {
          if (wsInstance.onmessage) {
            wsInstance.onmessage({
              data: JSON.stringify({
                type: 'segment',
                data: {
                  speakerId: 'p1',
                  startTime: 1000,
                  endTime: 2000,
                  text: 'Hello',
                  confidence: 0.95,
                },
              }),
            });
          }
        }, 10);
        return wsInstance;
      }),
    );

    const client = new RecFn({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-test',
    });

    const stream = client.transcripts.stream('bot_123');

    stream.on('segment', (data) => {
      expect(data.text).toBe('Hello');
      expect(data.speakerId).toBe('p1');
      stream.close();
      done();
    });
  });

  it('emits participant_joined events', (done) => {
    let wsInstance: { onmessage?: (ev: { data: string }) => void } = {};

    vi.stubGlobal(
      'WebSocket',
      vi.fn().mockImplementation(() => {
        wsInstance = {
          readyState: 1,
          send: vi.fn(),
          close: vi.fn(),
        };
        setTimeout(() => {
          if (wsInstance.onmessage) {
            wsInstance.onmessage({
              data: JSON.stringify({
                type: 'participant_joined',
                data: {
                  id: 'p1',
                  name: 'Alice',
                  role: 'attendee',
                  joinedAt: '2026-02-28T14:00:00Z',
                  consent: 'pending',
                },
              }),
            });
          }
        }, 10);
        return wsInstance;
      }),
    );

    const client = new RecFn({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-test',
    });

    const stream = client.transcripts.stream('bot_123');

    stream.on('participant_joined', (data) => {
      expect(data.name).toBe('Alice');
      stream.close();
      done();
    });
  });

  it('emits canonical status events and uses the shared schema (TV-WS-002)', (done) => {
    expect(TRANSCRIPT_STREAM_FRAME_SCHEMA.status.requiredKeys).toEqual(['botStatus']);

    let wsInstance: { onmessage?: (ev: { data: string }) => void } = {};

    vi.stubGlobal(
      'WebSocket',
      vi.fn().mockImplementation(() => {
        wsInstance = {
          readyState: 1,
          send: vi.fn(),
          close: vi.fn(),
        };
        setTimeout(() => {
          wsInstance.onmessage?.({
            data: JSON.stringify({
              type: 'status',
              data: { botStatus: 'recording' },
            }),
          });
        }, 10);
        return wsInstance;
      }),
    );

    const client = new RecFn({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-test',
    });

    const stream = client.transcripts.stream('bot_123');
    stream.on('status', (data) => {
      expect(data.botStatus).toBe('recording');
      stream.close();
      done();
    });
  });

  it('ignores legacy status frames that do not match the canonical schema (TV-WS-002)', async () => {
    let wsInstance: { onmessage?: (ev: { data: string }) => void } = {};

    vi.stubGlobal(
      'WebSocket',
      vi.fn().mockImplementation(() => {
        wsInstance = {
          readyState: 1,
          send: vi.fn(),
          close: vi.fn(),
        };
        return wsInstance;
      }),
    );

    const client = new RecFn({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-test',
    });

    const stream = client.transcripts.stream('bot_123');
    const statusListener = vi.fn();
    stream.on('status', statusListener);

    wsInstance.onmessage?.({
      data: JSON.stringify({
        type: 'status',
        data: { status: 'recording' },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statusListener).not.toHaveBeenCalled();
    stream.close();
  });
});

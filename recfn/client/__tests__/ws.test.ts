import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
});

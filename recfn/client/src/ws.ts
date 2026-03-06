import type { Segment, Participant } from 'recfn';
import type { RecFnHttpClient } from './client.js';

export interface TranscriptStreamEvents {
  segment: (data: Segment) => void;
  participant_joined: (data: Participant) => void;
  participant_left: (data: { participantId: string }) => void;
  status: (data: { botStatus: string }) => void;
  error: (data: { code: string; message: string }) => void;
}

export interface TranscriptStream {
  on<K extends keyof TranscriptStreamEvents>(
    event: K,
    listener: TranscriptStreamEvents[K],
  ): void;
  off<K extends keyof TranscriptStreamEvents>(
    event: K,
    listener: TranscriptStreamEvents[K],
  ): void;
  close(): void;
}

/**
 * Creates a WebSocket connection to the transcript stream for a bot.
 * Emits typed events: segment, participant_joined, participant_left, status, error.
 * Handles ping/pong. Does not auto-reconnect (caller may create new stream).
 */
export function createTranscriptStream(
  client: RecFnHttpClient,
  botId: string,
): TranscriptStream {
  const url = client.getWsUrl(`/ws/transcripts/${botId}`);
  const ws = new WebSocket(url);

  const listeners: Record<string, Set<(data: unknown) => void>> = {};

  function on<K extends keyof TranscriptStreamEvents>(
    event: K,
    listener: TranscriptStreamEvents[K],
  ): void {
    if (!listeners[event]) {
      listeners[event] = new Set();
    }
    listeners[event].add(listener as (data: unknown) => void);
  }

  function off<K extends keyof TranscriptStreamEvents>(
    event: K,
    listener: TranscriptStreamEvents[K],
  ): void {
    listeners[event]?.delete(listener as (data: unknown) => void);
  }

  function emit<K extends keyof TranscriptStreamEvents>(
    event: K,
    data: Parameters<TranscriptStreamEvents[K]>[0],
  ): void {
    for (const fn of listeners[event] ?? []) {
      (fn as (d: unknown) => void)(data);
    }
  }

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 30000);

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data as string) as {
        type: string;
        data?: unknown;
      };
      if (msg.type === 'pong') return;
      if (msg.type === 'segment') emit('segment', msg.data as Segment);
      else if (msg.type === 'participant_joined')
        emit('participant_joined', msg.data as Participant);
      else if (msg.type === 'participant_left')
        emit('participant_left', msg.data as { participantId: string });
      else if (msg.type === 'status')
        emit('status', msg.data as { botStatus: string });
      else if (msg.type === 'error')
        emit('error', msg.data as { code: string; message: string });
    } catch {
      // Ignore parse errors
    }
  };

  ws.onerror = () => {
    emit('error', { code: 'WS_ERROR', message: 'WebSocket error' });
  };

  ws.onclose = () => {
    clearInterval(pingInterval);
  };

  return {
    on,
    off,
    close() {
      clearInterval(pingInterval);
      ws.close();
    },
  };
}

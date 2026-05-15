import type {
  Participant,
  Segment,
  TranscriptStreamErrorData,
  TranscriptStreamFrame,
  TranscriptStreamParticipantLeftData,
  TranscriptStreamStatusData,
} from '@recfn/core';
import {
  TRANSCRIPT_STREAM_FRAME_SCHEMA,
  parseTranscriptStreamFrame,
} from '@recfn/core';
import type { RecFnHttpClient } from './client.js';

export interface TranscriptStreamEvents {
  segment: (data: Segment) => void;
  participant_joined: (data: Participant) => void;
  participant_left: (data: TranscriptStreamParticipantLeftData) => void;
  status: (data: TranscriptStreamStatusData) => void;
  error: (data: TranscriptStreamErrorData) => void;
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

export { TRANSCRIPT_STREAM_FRAME_SCHEMA };
export type TranscriptStreamCanonicalFrame = TranscriptStreamFrame;

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
      const raw = JSON.parse(String(ev.data));
      const frame = parseTranscriptStreamFrame(raw);
      if (!frame || frame.type === 'pong' || frame.type === 'ping') {
        return;
      }
      if (frame.type === 'segment') emit('segment', frame.data);
      else if (frame.type === 'participant_joined') emit('participant_joined', frame.data);
      else if (frame.type === 'participant_left') emit('participant_left', frame.data);
      else if (frame.type === 'status') emit('status', frame.data);
      else if (frame.type === 'error') emit('error', frame.data);
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

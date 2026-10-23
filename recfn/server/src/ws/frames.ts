import type {
  TranscriptStreamErrorData,
  TranscriptStreamFrame,
  TranscriptStreamFrameType,
} from '@recfn/core';
import {
  TRANSCRIPT_STREAM_FRAME_SCHEMA,
  parseTranscriptStreamFrame,
  serializeTranscriptStreamFrame,
} from '@recfn/core';

export {
  TRANSCRIPT_STREAM_FRAME_SCHEMA,
};

export type WebSocketFrameType = TranscriptStreamFrameType;
export type WebSocketFrame = TranscriptStreamFrame;
export type ErrorFrameData = TranscriptStreamErrorData;

export function createFrame(type: WebSocketFrameType, data?: unknown): string {
  const frame = data === undefined ? { type } : { type, data };
  const parsed = parseTranscriptStreamFrame(frame);
  if (!parsed) {
    throw new Error(`Invalid transcript frame for type "${type}".`);
  }
  return serializeTranscriptStreamFrame(parsed);
}

export function createErrorFrame(code: string, message: string): string {
  return createFrame('error', { code, message });
}

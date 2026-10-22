import type { AudioChunk } from '@recfn/core';
import type { ZoomMeetingSdk, ZoomAudioFrame } from './meeting-sdk.js';

export interface AudioCaptureOptions {
  perParticipant?: boolean;
}

export function createAudioStream(
  sdk: ZoomMeetingSdk,
  _options?: AudioCaptureOptions,
): ReadableStream<AudioChunk> {
  let cleanup = () => {};
  return new ReadableStream<AudioChunk>({
    start(controller) {
      let closed = false;
      const onFrame = (frame: ZoomAudioFrame) => {
        if (closed) {
          return;
        }
        const chunk: AudioChunk = {
          data: frame.buffer,
          encoding: frame.encoding,
          timestamp: frame.timestamp ?? Date.now(),
          sampleRate: frame.sampleRate,
          channels: frame.channels,
        };
        controller.enqueue(chunk);
      };
      const onMeetingEnded = () => {
        if (closed) {
          return;
        }
        closed = true;
        sdk.off('audio-frame', onFrame as (...args: unknown[]) => void);
        sdk.off('meeting-ended', onMeetingEnded as (...args: unknown[]) => void);
        controller.close();
      };

      cleanup = () => {
        closed = true;
        sdk.off('audio-frame', onFrame as (...args: unknown[]) => void);
        sdk.off('meeting-ended', onMeetingEnded as (...args: unknown[]) => void);
      };
      sdk.on('audio-frame', onFrame);
      sdk.on('meeting-ended', onMeetingEnded);
    },
    cancel() {
      cleanup();
    },
  });
}

export function createPerParticipantAudioStream(
  sdk: ZoomMeetingSdk,
  participantId: string,
): ReadableStream<AudioChunk> {
  let cleanup = () => {};
  return new ReadableStream<AudioChunk>({
    start(controller) {
      let closed = false;
      const onFrame = (frame: ZoomAudioFrame) => {
        if (closed) {
          return;
        }
        if (frame.participantId === participantId) {
          const chunk: AudioChunk = {
            data: frame.buffer,
          encoding: frame.encoding,
            timestamp: frame.timestamp ?? Date.now(),
            sampleRate: frame.sampleRate,
            channels: frame.channels,
          };
          controller.enqueue(chunk);
        }
      };
      const onMeetingEnded = () => {
        if (closed) {
          return;
        }
        closed = true;
        sdk.off(
          'participant-audio-frame',
          onFrame as (...args: unknown[]) => void,
        );
        sdk.off('meeting-ended', onMeetingEnded as (...args: unknown[]) => void);
        controller.close();
      };

      cleanup = () => {
        closed = true;
        sdk.off('participant-audio-frame', onFrame as (...args: unknown[]) => void);
        sdk.off('meeting-ended', onMeetingEnded as (...args: unknown[]) => void);
      };
      sdk.on('participant-audio-frame', onFrame);
      sdk.on('meeting-ended', onMeetingEnded);
    },
    cancel() { cleanup(); },
  });
}

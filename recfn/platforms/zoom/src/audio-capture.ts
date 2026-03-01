import type { AudioChunk } from 'recfn';
import type { ZoomMeetingSdk, ZoomAudioFrame } from './meeting-sdk.js';

export interface AudioCaptureOptions {
  perParticipant?: boolean;
}

export function createAudioStream(
  sdk: ZoomMeetingSdk,
  _options?: AudioCaptureOptions,
): ReadableStream<AudioChunk> {
  return new ReadableStream<AudioChunk>({
    start(controller) {
      const onFrame = (frame: ZoomAudioFrame) => {
        const chunk: AudioChunk = {
          data: frame.buffer,
          timestamp: Date.now(),
          sampleRate: frame.sampleRate,
          channels: frame.channels,
        };
        controller.enqueue(chunk);
      };

      sdk.on('audio-frame', onFrame);
      sdk.on('meeting-ended', () => {
        controller.close();
      });
    },
  });
}

export function createPerParticipantAudioStream(
  sdk: ZoomMeetingSdk,
  participantId: string,
): ReadableStream<AudioChunk> {
  return new ReadableStream<AudioChunk>({
    start(controller) {
      const onFrame = (frame: ZoomAudioFrame) => {
        if (frame.participantId === participantId) {
          const chunk: AudioChunk = {
            data: frame.buffer,
            timestamp: Date.now(),
            sampleRate: frame.sampleRate,
            channels: frame.channels,
          };
          controller.enqueue(chunk);
        }
      };

      sdk.on('participant-audio-frame', onFrame);
      sdk.on('meeting-ended', () => {
        controller.close();
      });
    },
  });
}

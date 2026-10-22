import { createError, ErrorCode } from '@recfn/core';
import type { VideoChunk } from '@recfn/core';
import type { ZoomMeetingSdk, ZoomVideoFrame } from './meeting-sdk.js';

export function createVideoStream(
  sdk: ZoomMeetingSdk,
): ReadableStream<VideoChunk> {
  let cleanup = () => {};
  return new ReadableStream<VideoChunk>({
    start(controller) {
      let closed = false;
      const onFrame = (frame: ZoomVideoFrame) => {
        if (closed) {
          return;
        }
        const chunk: VideoChunk = {
          data: frame.buffer,
          encoding: frame.encoding,
          frameRate: frame.frameRate,
          timestamp: frame.timestamp ?? Number.NaN,
          width: frame.width,
          height: frame.height,
        };
        if (chunk.data.byteLength > (controller.desiredSize ?? 0)) {
          cleanup();
          controller.error(createError(ErrorCode.PLATFORM_CAPTURE_UNAVAILABLE, 'Zoom media buffer overflow.'));
          return;
        }
        controller.enqueue({ ...chunk, data: new Uint8Array(chunk.data) });
      };
      const onMeetingEnded = () => {
        if (closed) {
          return;
        }
        closed = true;
        sdk.off('video-frame', onFrame as (...args: unknown[]) => void);
        sdk.off('meeting-ended', onMeetingEnded as (...args: unknown[]) => void);
        controller.close();
      };

      cleanup = () => {
        closed = true;
        sdk.off('video-frame', onFrame as (...args: unknown[]) => void);
        sdk.off('meeting-ended', onMeetingEnded as (...args: unknown[]) => void);
      };
      sdk.on('video-frame', onFrame);
      sdk.on('meeting-ended', onMeetingEnded);
    },
    cancel() { cleanup(); },
  }, { highWaterMark: 32 * 1024 * 1024, size: chunk => chunk?.data.byteLength ?? 0 });
}

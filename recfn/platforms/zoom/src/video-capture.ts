import type { VideoChunk } from 'recfn';
import type { ZoomMeetingSdk, ZoomVideoFrame } from './meeting-sdk.js';

export function createVideoStream(
  sdk: ZoomMeetingSdk,
): ReadableStream<VideoChunk> {
  return new ReadableStream<VideoChunk>({
    start(controller) {
      let closed = false;
      const onFrame = (frame: ZoomVideoFrame) => {
        if (closed) {
          return;
        }
        const chunk: VideoChunk = {
          data: frame.buffer,
          timestamp: Date.now(),
          width: frame.width,
          height: frame.height,
        };
        controller.enqueue(chunk);
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

      sdk.on('video-frame', onFrame);
      sdk.on('meeting-ended', onMeetingEnded);
    },
  });
}

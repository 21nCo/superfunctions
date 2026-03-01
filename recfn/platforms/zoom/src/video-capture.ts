import type { VideoChunk } from 'recfn';
import type { ZoomMeetingSdk, ZoomVideoFrame } from './meeting-sdk.js';

export function createVideoStream(
  sdk: ZoomMeetingSdk,
): ReadableStream<VideoChunk> {
  return new ReadableStream<VideoChunk>({
    start(controller) {
      const onFrame = (frame: ZoomVideoFrame) => {
        const chunk: VideoChunk = {
          data: frame.buffer,
          timestamp: Date.now(),
          width: frame.width,
          height: frame.height,
        };
        controller.enqueue(chunk);
      };

      sdk.on('video-frame', onFrame);
      sdk.on('meeting-ended', () => {
        controller.close();
      });
    },
  });
}

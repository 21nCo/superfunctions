import type { AudioChunk } from 'recfn';
import type { Page } from 'playwright';

/**
 * Captures audio from Microsoft Teams via injected script.
 * Teams uses WebRTC; full capture requires CDP or virtual audio device.
 * Returns stub stream for interface compliance.
 */
export function createTeamsAudioStream(
  page: Page,
  _options?: { sampleRate?: number },
): ReadableStream<AudioChunk> {
  return new ReadableStream<AudioChunk>({
    async start(controller) {
      try {
        const supported = await page.evaluate(() => {
          const w = typeof window !== 'undefined' ? window : null;
          if (!w) return false;
          const ac = (w as unknown as { AudioContext?: unknown }).AudioContext;
          return !!ac;
        });
        if (!supported) {
          controller.close();
          return;
        }
        const chunk: AudioChunk = {
          data: new Uint8Array(0),
          timestamp: Date.now(),
          sampleRate: 48000,
          channels: 1,
        };
        controller.enqueue(chunk);
      } catch {
        // Non-fatal
      }
      controller.close();
    },
  });
}

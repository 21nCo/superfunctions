import type { AudioChunk } from 'recfn';
import type { Page } from 'playwright';

export interface BrowserAudioSupport {
  supported: boolean;
  sampleRate?: number;
  channels?: number;
}

export type BrowserAudioSupportEvaluator = () => BrowserAudioSupport;

export interface BrowserAudioStreamOptions {
  sampleRate?: number;
  channels?: number;
}

export function createBrowserAudioStream(
  page: Page,
  evaluateSupport: BrowserAudioSupportEvaluator,
  options: BrowserAudioStreamOptions = {},
): ReadableStream<AudioChunk> {
  return new ReadableStream<AudioChunk>({
    async start(controller) {
      try {
        const support = await page.evaluate(evaluateSupport);
        if (!support.supported) {
          controller.close();
          return;
        }

        controller.enqueue({
          data: new Uint8Array(0),
          timestamp: Date.now(),
          sampleRate: options.sampleRate ?? support.sampleRate ?? 48_000,
          channels: options.channels ?? support.channels ?? 1,
        });
      } catch {
        // Non-fatal: platform-specific capture prerequisites are validated later.
      }

      controller.close();
    },
  });
}

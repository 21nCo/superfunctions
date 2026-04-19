import {
  RecFnError,
  createError,
  type AsrAdapter,
  type AudioChunk,
  type Platform,
} from 'recfn';
import type { TranscriptStreamManager } from '../ws/transcript-stream.js';
import type { Logger } from '../integrations/logfn.js';

export interface RealtimePipelineDeps {
  asrAdapter: AsrAdapter;
  streamManager: TranscriptStreamManager;
  logger: Logger;
}

const REALTIME_TRANSCRIPT_UNSUPPORTED_CODE = 'REALTIME_TRANSCRIPT_UNSUPPORTED';

const REALTIME_TRANSCRIPTION_MATRIX: Record<
  Platform,
  readonly string[]
> = {
  zoom: ['deepgram'],
  meet: ['deepgram'],
  teams: ['deepgram'],
  desktop: [],
};

export function getRealtimeTranscriptionMatrix(): Record<Platform, readonly string[]> {
  return REALTIME_TRANSCRIPTION_MATRIX;
}

export function isRealtimeTranscriptionSupported(
  platform: Platform,
  asrProvider: string,
): boolean {
  return REALTIME_TRANSCRIPTION_MATRIX[platform]?.includes(asrProvider) ?? false;
}

export function assertRealtimeTranscriptionSupported(
  platform: Platform,
  asrProvider: string,
): void {
  if (isRealtimeTranscriptionSupported(platform, asrProvider)) {
    return;
  }

  throw createError(
    REALTIME_TRANSCRIPT_UNSUPPORTED_CODE as unknown as Parameters<
      typeof createError
    >[0],
    `Real-time transcription is not supported for ${platform} with ${asrProvider}.`,
    {
      platform,
      asrProvider,
      supportedProviders: REALTIME_TRANSCRIPTION_MATRIX[platform] ?? [],
    },
  );
}

function normalizeRealtimeAudioStream(
  audioStream: ReadableStream<AudioChunk | Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = audioStream.getReader();

      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              break;
            }
            if (!value) {
              continue;
            }
            if (value instanceof Uint8Array) {
              controller.enqueue(value);
              continue;
            }
            controller.enqueue((value as AudioChunk).data);
          }
        } catch (error) {
          controller.error(error);
        } finally {
          reader.releaseLock();
        }
      };

      void pump();
    },
  });
}

export class RealtimeTranscriptionPipeline {
  private deps: RealtimePipelineDeps;
  private abortControllers: Map<string, AbortController> = new Map();

  constructor(deps: RealtimePipelineDeps) {
    this.deps = deps;
  }

  async start(
    botId: string,
    audioStream: ReadableStream<AudioChunk | Uint8Array>,
    options: {
      language?: string;
      platform?: Platform;
      asrProvider?: string;
    } = {},
  ): Promise<void> {
    if (this.abortControllers.has(botId)) {
      this.stop(botId);
    }

    const abortController = new AbortController();
    this.abortControllers.set(botId, abortController);
    const language = options.language ?? 'en';
    const asrProvider = options.asrProvider ?? this.deps.asrAdapter.name;
    const platform = options.platform ?? 'zoom';

    try {
      assertRealtimeTranscriptionSupported(platform, asrProvider);
      this.deps.logger.info('realtime_transcription.start', { botId, language });

      const segments = this.deps.asrAdapter.transcribeStream(
        normalizeRealtimeAudioStream(audioStream),
        {
          language,
          speakerDiarization: true,
        },
      );

      for await (const segment of segments) {
        if (abortController.signal.aborted) {
          break;
        }
        
        this.deps.streamManager.broadcast(botId, 'segment', segment);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // expected
      } else {
        this.deps.logger.error('realtime_transcription.error', { botId, error: err instanceof Error ? err.message : String(err) });
        const errorCode =
          err instanceof RecFnError
            ? String(err.code)
            : 'ASR_ERROR';
        this.deps.streamManager.broadcast(botId, 'error', {
          code: errorCode,
          message:
            errorCode === REALTIME_TRANSCRIPT_UNSUPPORTED_CODE
              ? 'Real-time transcription is unsupported for this platform/provider pair.'
              : 'Real-time transcription failed.',
        });
      }
    } finally {
      this.abortControllers.delete(botId);
      this.deps.logger.info('realtime_transcription.stop', { botId });
    }
  }

  stop(botId: string): void {
    const controller = this.abortControllers.get(botId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(botId);
    }
  }
}

import type { AsrAdapter } from 'recfn';
import type { TranscriptStreamManager } from '../ws/transcript-stream.js';
import type { Logger } from '../integrations/logfn.js';

export interface RealtimePipelineDeps {
  asrAdapter: AsrAdapter;
  streamManager: TranscriptStreamManager;
  logger: Logger;
}

export class RealtimeTranscriptionPipeline {
  private deps: RealtimePipelineDeps;
  private abortControllers: Map<string, AbortController> = new Map();

  constructor(deps: RealtimePipelineDeps) {
    this.deps = deps;
  }

  async start(botId: string, audioStream: ReadableStream, language: string = 'en'): Promise<void> {
    if (this.abortControllers.has(botId)) {
      this.stop(botId);
    }

    const abortController = new AbortController();
    this.abortControllers.set(botId, abortController);

    try {
      this.deps.logger.info('realtime_transcription.start', { botId, language });
      
      const segments = this.deps.asrAdapter.transcribeStream(audioStream, {
        language,
        diarize: true,
      } as unknown as import('recfn').AsrOpts);

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
        this.deps.streamManager.broadcast(botId, 'error', { code: 'ASR_ERROR', message: 'Real-time transcription failed.' });
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

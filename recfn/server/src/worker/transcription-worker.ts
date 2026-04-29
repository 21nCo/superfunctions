import type { QueueAdapter } from '../integrations/flowfn.js';
import { QUEUE_NAMES } from '../integrations/flowfn.js';
import type { Logger } from '../integrations/logfn.js';
import {
  processTranscriptionJob,
  type TranscriptionJobInput,
  type TranscriptionPipelineDeps,
} from '../transcription/pipeline.js';

export interface TranscriptionWorkerConfig extends TranscriptionPipelineDeps {
  queue: QueueAdapter;
  logger: Logger;
}

export interface TranscriptionWorker {
  processNext(): Promise<boolean>;
}

export function createTranscriptionWorker(
  config: TranscriptionWorkerConfig,
): TranscriptionWorker {
  const { queue, logger, ...pipelineDeps } = config;

  return {
    async processNext(): Promise<boolean> {
      const job = await queue.dequeue(QUEUE_NAMES.TRANSCRIPTION);
      if (!job) {
        return false;
      }

      if (job.type !== 'transcription') {
        logger.warn('transcription.worker.unexpected_job_type', {
          jobType: job.type,
        });
        return true;
      }

      try {
        const payload = job.data as unknown as TranscriptionJobInput;
        await processTranscriptionJob(payload, pipelineDeps);
      } catch (error) {
        logger.error('transcription.worker.error', {
          jobType: job.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return true;
    },
  };
}

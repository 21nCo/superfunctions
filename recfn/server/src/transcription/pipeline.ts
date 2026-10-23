import type { Transcript } from '@recfn/core';
import type { RecFnStore } from '../store/types.js';
import type { Logger } from '../integrations/logfn.js';
import type { AsrRegistry } from './registry.js';
import type { WebhookDeliverer } from '../worker/lifecycle.js';
import type { SearchFnClient } from '../integrations/searchfn.js';
import type { MetricsEmitter } from '../integrations/watchfn.js';
import { buildTranscriptReadyPayload } from '../webhooks/events.js';
import { indexTranscript } from '../search/indexer.js';
import { checkTranscriptSegments } from '../middleware/limits.js';
import { loadLimitsConfig } from '../config.js';
import { emitAsrLatency } from '../observability/metrics.js';
import { sortSegmentsDeterministically } from '@recfn/shared-cloud';

export function generateTranscriptId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `trx_${ts}${rand}`;
}

export interface TranscriptionJobInput {
  recordingId: string;
  namespace: string;
  audioRef: string;
  asrProvider: string;
  language: string;
  /** When provided, update this transcript instead of creating a new one. */
  transcriptId?: string;
}

export interface TranscriptionPipelineDeps {
  store: RecFnStore;
  logger: Logger;
  asrRegistry: AsrRegistry;
  webhookDeliverer?: WebhookDeliverer;
  searchClient?: SearchFnClient | null;
  metrics?: MetricsEmitter;
}

export async function processTranscriptionJob(
  input: TranscriptionJobInput,
  deps: TranscriptionPipelineDeps,
): Promise<Transcript> {
  const { recordingId, namespace, audioRef, asrProvider, language, transcriptId: existingTranscriptId } = input;
  const { store, logger, asrRegistry, webhookDeliverer, searchClient, metrics } = deps;

  const transcriptId = existingTranscriptId ?? generateTranscriptId();

  logger.info('transcription.start', {
    transcriptId,
    recordingId,
    asrProvider,
    language,
  });

  // Create transcript in processing state (or use existing from route)
  const transcript: Transcript = {
    id: transcriptId,
    recordingId,
    language,
    status: 'processing',
    segments: [],
    createdAt: new Date().toISOString(),
  };
  if (!existingTranscriptId) {
    await store.createTranscript(transcript, namespace);
  }

  const adapter = asrRegistry.get(asrProvider);
  if (!adapter) {
    const errorTranscript = {
      ...transcript,
      status: 'error' as const,
    };
    await store.updateTranscript(transcriptId, namespace, {
      status: 'error',
    });
    logger.error('transcription.adapter_not_found', {
      transcriptId,
      asrProvider,
    });
    return errorTranscript;
  }

  try {
    const asrStart = Date.now();
    const rawSegments = await adapter.transcribeBatch(audioRef, {
      language,
      speakerDiarization: true,
    });
    const asrLatencyMs = Date.now() - asrStart;

    const limits = loadLimitsConfig();
    checkTranscriptSegments(rawSegments.length, limits);

    const sortedSegments = sortSegmentsDeterministically(rawSegments);

    await store.updateTranscript(transcriptId, namespace, {
      status: 'ready',
      segments: sortedSegments,
    });

    logger.info('transcription.complete', {
      transcriptId,
      recordingId,
      segmentCount: sortedSegments.length,
      asrLatencyMs,
    });

    if (metrics) {
      emitAsrLatency(metrics, asrLatencyMs, {
        recordingId,
        asrProvider,
        namespace,
      });
    }

    const recording = await store.getRecording(recordingId, namespace);
    if (recording) {
      if (webhookDeliverer) {
        webhookDeliverer.deliver(namespace, 'transcript.ready', buildTranscriptReadyPayload(
          { ...transcript, status: 'ready', segments: sortedSegments },
          recordingId,
          recording.botId,
        )).catch(() => {});
      }
      if (searchClient) {
        await indexTranscript(
          { recordingId, botId: recording.botId, segments: sortedSegments },
          searchClient,
        );
      }
    }

    return {
      ...transcript,
      status: 'ready',
      segments: sortedSegments,
    };
  } catch (e) {
    await store.updateTranscript(transcriptId, namespace, {
      status: 'error',
    });

    logger.error('transcription.error', {
      transcriptId,
      recordingId,
      error: e instanceof Error ? e.message : String(e),
    });

    return {
      ...transcript,
      status: 'error',
    };
  }
}

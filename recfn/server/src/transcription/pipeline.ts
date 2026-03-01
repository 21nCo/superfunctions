import type { Segment, Transcript } from 'recfn';
import type { RecFnStore } from '../store/types.js';
import type { Logger } from '../integrations/logfn.js';
import type { AsrRegistry } from './registry.js';

function generateTranscriptId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `trx_${ts}${rand}`;
}

function sortSegments(segments: Segment[]): Segment[] {
  return [...segments].sort((a, b) => {
    if (a.startTime !== b.startTime) return a.startTime - b.startTime;
    return a.speakerId.localeCompare(b.speakerId);
  });
}

export interface TranscriptionJobInput {
  recordingId: string;
  namespace: string;
  audioRef: string;
  asrProvider: string;
  language: string;
}

export interface TranscriptionPipelineDeps {
  store: RecFnStore;
  logger: Logger;
  asrRegistry: AsrRegistry;
}

export async function processTranscriptionJob(
  input: TranscriptionJobInput,
  deps: TranscriptionPipelineDeps,
): Promise<Transcript> {
  const { recordingId, namespace, audioRef, asrProvider, language } = input;
  const { store, logger, asrRegistry } = deps;

  const transcriptId = generateTranscriptId();

  logger.info('transcription.start', {
    transcriptId,
    recordingId,
    asrProvider,
    language,
  });

  // Create transcript in processing state
  const transcript: Transcript = {
    id: transcriptId,
    recordingId,
    language,
    status: 'processing',
    segments: [],
    createdAt: new Date().toISOString(),
  };
  await store.createTranscript(transcript, namespace);

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
    const rawSegments = await adapter.transcribeBatch(audioRef, {
      language,
      speakerDiarization: true,
    });

    const sortedSegments = sortSegments(rawSegments);

    await store.updateTranscript(transcriptId, namespace, {
      status: 'ready',
      segments: sortedSegments,
    });

    logger.info('transcription.complete', {
      transcriptId,
      recordingId,
      segmentCount: sortedSegments.length,
    });

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

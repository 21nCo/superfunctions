import type { Route, RouteContext } from '@superfunctions/http';
import { ErrorCode } from 'recfn';
import type { Segment } from 'recfn';
import type { RecFnStore } from '../store/types.js';
import type { ValidateApiKey } from '../middleware/auth.js';
import type { QueueAdapter } from '../integrations/flowfn.js';
import { QUEUE_NAMES } from '../integrations/flowfn.js';
import { authenticate } from '../middleware/auth.js';
import { ok, err } from '../middleware/envelope.js';

export interface TranscriptRouteDeps {
  store: RecFnStore;
  validateApiKey: ValidateApiKey;
  queue?: QueueAdapter;
}

function sortSegments(segments: Segment[]): Segment[] {
  return [...segments].sort((a, b) => {
    if (a.startTime !== b.startTime) return a.startTime - b.startTime;
    return a.speakerId.localeCompare(b.speakerId);
  });
}

function generateTranscriptId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `trx_${ts}${rand}`;
}

export function createTranscriptRoutes(deps: TranscriptRouteDeps): Route[] {
  const { store, validateApiKey, queue } = deps;

  return [
    {
      method: 'POST',
      path: '/api/v1/recordings/:recordingId/transcribe',
      handler: async (request: Request, ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);
        const recording = await store.getRecording(
          ctx.params.recordingId,
          auth.namespace,
        );
        if (!recording) {
          return err(
            ErrorCode.RECORDING_NOT_FOUND,
            'Recording not found.',
          );
        }

        // Check if transcription is already in progress
        const existing = await store.getTranscript(
          ctx.params.recordingId,
          auth.namespace,
        );
        if (existing && existing.status === 'processing') {
          return err(
            ErrorCode.TRANSCRIPTION_IN_PROGRESS,
            'Transcription already in progress for this recording.',
          );
        }

        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const asrProvider = (body.asrProvider as string) ?? 'whisper';
        const language = (body.language as string) ?? 'en-US';

        const transcriptId = generateTranscriptId();

        // Create transcript in processing state
        await store.createTranscript(
          {
            id: transcriptId,
            recordingId: ctx.params.recordingId,
            language,
            status: 'processing',
            segments: [],
            createdAt: new Date().toISOString(),
          },
          auth.namespace,
        );

        // Enqueue transcription job if queue available
        if (queue) {
          await queue.enqueue(QUEUE_NAMES.TRANSCRIPTION, {
            type: 'transcription',
            data: {
              transcriptId,
              recordingId: ctx.params.recordingId,
              namespace: auth.namespace,
              audioRef: recording.storageRef,
              asrProvider,
              language,
            },
            createdAt: new Date().toISOString(),
          });
        }

        return ok({ transcriptId, status: 'processing' }, 202);
      },
    },

    {
      method: 'GET',
      path: '/api/v1/recordings/:recordingId/transcript',
      handler: async (request: Request, ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);
        const recording = await store.getRecording(
          ctx.params.recordingId,
          auth.namespace,
        );
        if (!recording) {
          return err(
            ErrorCode.RECORDING_NOT_FOUND,
            'Recording not found.',
          );
        }

        const transcript = await store.getTranscript(
          ctx.params.recordingId,
          auth.namespace,
        );
        if (!transcript) {
          return err(
            ErrorCode.TRANSCRIPT_NOT_FOUND,
            'No transcript for this recording.',
          );
        }

        // Sort segments by startTime, then speakerId
        const sorted = {
          ...transcript,
          segments: sortSegments(transcript.segments),
        };

        return ok(sorted);
      },
    },
  ];
}

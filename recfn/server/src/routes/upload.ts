import type { Route, RouteContext } from '@superfunctions/http';
import { ErrorCode } from '@recfn/core';
import type { RecFnStore } from '../store/types.js';
import type { ValidateApiKey } from '../middleware/auth.js';
import type { StorageAdapter } from '../integrations/storage.js';
import type { QueueAdapter } from '../integrations/flowfn.js';
import { QUEUE_NAMES } from '../integrations/flowfn.js';
import type { Logger } from '../integrations/logfn.js';
import { authenticate } from '../middleware/auth.js';
import { ok, err } from '../middleware/envelope.js';
import { uploadRecording } from '../recording/storage.js';

export interface UploadRouteDeps {
  store: RecFnStore;
  validateApiKey: ValidateApiKey;
  storage: StorageAdapter;
  queue?: QueueAdapter;
  logger: Logger;
  metrics?: import('../integrations/watchfn.js').MetricsEmitter;
}

function generateTranscriptId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `trx_${ts}${rand}`;
}

export function createUploadRoutes(deps: UploadRouteDeps): Route[] {
  const { store, validateApiKey, storage, queue, logger, metrics } = deps;

  return [
    {
      method: 'POST',
      path: '/api/v1/recordings/upload',
      handler: async (request: Request, _ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);

        const url = new URL(request.url);
        const botId = url.searchParams.get('botId');
        const transcribe = url.searchParams.get('transcribe') === 'true';

        if (!botId || typeof botId !== 'string') {
          return err(ErrorCode.BAD_REQUEST, 'botId query parameter is required.');
        }

        const bot = await store.getBot(botId, auth.namespace);
        if (!bot) {
          return err(ErrorCode.BOT_NOT_FOUND, 'Bot not found.');
        }

        let formData: FormData;
        try {
          formData = await request.formData();
        } catch {
          return err(ErrorCode.BAD_REQUEST, 'Invalid multipart form data.');
        }

        const file = formData.get('file');
        if (!file || !(file instanceof Blob)) {
          return err(ErrorCode.BAD_REQUEST, 'file field is required.');
        }

        const buffer = await file.arrayBuffer();
        const data = new Uint8Array(buffer);

        const contentType = file.type || 'application/octet-stream';
        const format =
          contentType.includes('mp4') || file.name?.endsWith('.mp4')
            ? ('mp4' as const)
            : contentType.includes('webm') || file.name?.endsWith('.webm')
              ? ('webm' as const)
              : contentType.includes('wav') || file.name?.endsWith('.wav')
                ? ('wav' as const)
                : ('webm' as const);

        const { recording } = await uploadRecording(
          {
            botId,
            namespace: auth.namespace,
            capture: {
              data,
              format,
              duration: 0,
              size: data.byteLength,
            },
            source: 'manual_upload',
          },
          { storage, store, logger, metrics },
        );

        if (transcribe && queue) {
          const transcriptId = generateTranscriptId();
          await store.createTranscript(
            {
              id: transcriptId,
              recordingId: recording.id,
              language: 'en-US',
              status: 'processing',
              segments: [],
              createdAt: new Date().toISOString(),
            },
            auth.namespace,
          );
          await queue.enqueue(QUEUE_NAMES.TRANSCRIPTION, {
            type: 'transcription',
            data: {
              transcriptId,
              recordingId: recording.id,
              namespace: auth.namespace,
              audioRef: recording.storageRef,
              asrProvider: 'whisper',
              language: 'en-US',
            },
            createdAt: new Date().toISOString(),
          });
        }

        return ok(recording, 201);
      },
    },
  ];
}

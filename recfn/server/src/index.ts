import { createRouter, type Router } from '@superfunctions/http';
import { RecFnError } from 'recfn';
import type { RecFnStore } from './store/types.js';
import type { ValidateApiKey } from './middleware/auth.js';
import type { QueueAdapter } from './integrations/flowfn.js';
import type { Logger } from './integrations/logfn.js';
import type { StorageAdapter } from './integrations/filefn.js';
import { createBotRoutes } from './routes/bots.js';
import { createRecordingRoutes } from './routes/recordings.js';
import { createTranscriptRoutes } from './routes/transcripts.js';
import { createParticipantRoutes } from './routes/participants.js';
import { createChatRoutes } from './routes/chat.js';
import { createMetadataRoutes } from './routes/metadata.js';

export interface RecFnServerConfig {
  store: RecFnStore;
  validateApiKey: ValidateApiKey;
  queue?: QueueAdapter;
  logger?: Logger;
  storage?: StorageAdapter;
}

export interface RecFnServer {
  router: Router;
}

export function createRecFnServer(config: RecFnServerConfig): RecFnServer {
  const { store, validateApiKey, queue, logger, storage } = config;
  const baseDeps = { store, validateApiKey };
  const botDeps = { ...baseDeps, queue, logger };
  const recordingDeps = { ...baseDeps, storage };

  const transcriptDeps = { ...baseDeps, queue };

  const routes = [
    ...createBotRoutes(botDeps),
    ...createRecordingRoutes(recordingDeps),
    ...createTranscriptRoutes(transcriptDeps),
    ...createParticipantRoutes(baseDeps),
    ...createChatRoutes(baseDeps),
    ...createMetadataRoutes(baseDeps),
  ];

  const router = createRouter({
    routes,
    onError: (error: Error) => {
      if (error instanceof RecFnError) {
        return Response.json(error.toEnvelope(), {
          status: error.httpStatus,
        });
      }
      return Response.json(
        {
          ok: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Internal server error.',
            details: {},
          },
        },
        { status: 500 },
      );
    },
  });

  return { router };
}

export { createMemoryStore } from './store/memory.js';
export type { RecFnStore } from './store/types.js';
export type { ValidateApiKey, AuthResult } from './middleware/auth.js';
export { ok, err } from './middleware/envelope.js';
export { createBotWorker } from './worker/bot-worker.js';
export type { BotWorker, BotWorkerConfig } from './worker/bot-worker.js';
export { transitionBot } from './worker/lifecycle.js';
export type { LifecycleDeps } from './worker/lifecycle.js';
export { createAutoLeaveTimer } from './worker/auto-leave.js';
export type { AutoLeaveTimer } from './worker/auto-leave.js';
export { MemoryQueueAdapter, QUEUE_NAMES } from './integrations/flowfn.js';
export type { QueueAdapter, JobPayload } from './integrations/flowfn.js';
export { MemoryLogger, createNoopLogger } from './integrations/logfn.js';
export type { Logger, LogEntry } from './integrations/logfn.js';
export { MemoryStorageAdapter, DEFAULT_SIGNED_URL_EXPIRY } from './integrations/filefn.js';
export type { StorageAdapter, UploadOptions } from './integrations/filefn.js';
export { captureFromStream } from './recording/capture.js';
export type { CaptureResult, CaptureOptions } from './recording/capture.js';
export { uploadRecording } from './recording/storage.js';
export type { UploadRecordingInput, UploadRecordingResult } from './recording/storage.js';
export { generateSignedUrl } from './recording/signed-url.js';
export type { SignedUrlOptions } from './recording/signed-url.js';
export { createAsrRegistry } from './transcription/registry.js';
export type { AsrRegistry } from './transcription/registry.js';
export { processTranscriptionJob } from './transcription/pipeline.js';
export type { TranscriptionJobInput, TranscriptionPipelineDeps } from './transcription/pipeline.js';
export { RecFnWebSocketServer } from './ws/server.js';
export type { WsServerDeps } from './ws/server.js';
export { TranscriptStreamManager, MAX_CONNECTIONS_PER_BOT } from './ws/transcript-stream.js';
export { authenticateWebSocket } from './ws/auth.js';
export type { WsAuthResult } from './ws/auth.js';
export { RealtimeTranscriptionPipeline } from './transcription/realtime.js';
export type { RealtimePipelineDeps } from './transcription/realtime.js';

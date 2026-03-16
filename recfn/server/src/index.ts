import { createRouter, type Router, RouterError } from '@superfunctions/http';
import { RecFnError } from 'recfn';
import type { RecFnStore } from './store/types.js';
import type { ValidateApiKey } from './middleware/auth.js';
import type { QueueAdapter } from './integrations/flowfn.js';
import type { Logger } from './integrations/logfn.js';
import type { StorageAdapter } from './integrations/filefn.js';
import type { SearchFnClient } from './integrations/searchfn.js';
import { createBotRoutes } from './routes/bots.js';
import { createRecordingRoutes } from './routes/recordings.js';
import { createUploadRoutes } from './routes/upload.js';
import { createTranscriptRoutes } from './routes/transcripts.js';
import { createParticipantRoutes } from './routes/participants.js';
import { createChatRoutes } from './routes/chat.js';
import { createMetadataRoutes } from './routes/metadata.js';
import { createWebhookRoutes } from './routes/webhooks.js';
import { createAnalyticsRoutes } from './routes/analytics.js';
import { createSearchRoutes } from './routes/search.js';
import { createCalendarRoutes } from './routes/calendars.js';
import type { CalendarTokenStore } from './calendar/token-store.js';
import type { GoogleCalendarClient } from './calendar/google.js';
import type { OutlookCalendarClient } from './calendar/outlook.js';
import type { MetricsEmitter } from './integrations/watchfn.js';

import { loadLimitsConfig, loadRateLimitConfig } from './config.js';
import { createRateLimitMiddleware } from './middleware/rate-limit.js';

export interface RecFnServerConfig {
  store: RecFnStore;
  validateApiKey: ValidateApiKey;
  queue?: QueueAdapter;
  logger?: Logger;
  storage?: StorageAdapter;
  searchClient?: SearchFnClient | null;
  tokenStore?: CalendarTokenStore;
  googleCalendarClient?: GoogleCalendarClient;
  outlookCalendarClient?: OutlookCalendarClient;
  /** If false, rate limiting is disabled. Default true. */
  rateLimit?: boolean;
  /** Optional metrics emitter (e.g. watchfn track). When provided, metrics are emitted. */
  metrics?: MetricsEmitter;
}

export interface RecFnServer {
  router: Router;
}

export function createRecFnServer(config: RecFnServerConfig): RecFnServer {
  const {
    store,
    validateApiKey,
    queue,
    logger,
    storage,
    searchClient,
    tokenStore,
    googleCalendarClient,
    outlookCalendarClient,
    rateLimit = true,
    metrics,
  } = config;

  const limits = loadLimitsConfig();
  const rateLimitCfg = loadRateLimitConfig();

  const baseDeps = { store, validateApiKey, limits };
  const botDeps = { ...baseDeps, queue, logger, metrics };
  const recordingDeps = { ...baseDeps, storage };
  const uploadDeps =
    storage && logger
      ? { ...baseDeps, storage, queue, logger, metrics }
      : null;

  const transcriptDeps = { ...baseDeps, queue };
  const webhookDeps = { ...baseDeps };
  const analyticsDeps = { ...baseDeps };
  const searchDeps = { ...baseDeps, searchClient: searchClient ?? null };

  const calendarDepsWithLimits =
    tokenStore && googleCalendarClient && outlookCalendarClient
      ? {
          ...baseDeps,
          tokenStore,
          googleClient: googleCalendarClient,
          outlookClient: outlookCalendarClient,
        }
      : null;

  const middleware: import('@superfunctions/http').Middleware[] = [];
  if (rateLimit) {
    middleware.push(
      createRateLimitMiddleware({
        requestsPerSecond: rateLimitCfg.requestsPerSecond,
        windowMs: rateLimitCfg.windowMs,
      }),
    );
  }

  const routes = [
    ...createBotRoutes(botDeps),
    ...createRecordingRoutes(recordingDeps),
    ...(uploadDeps ? createUploadRoutes(uploadDeps) : []),
    ...createTranscriptRoutes(transcriptDeps),
    ...createParticipantRoutes(baseDeps),
    ...createChatRoutes(baseDeps),
    ...createMetadataRoutes(baseDeps),
    ...createWebhookRoutes(webhookDeps),
    ...createAnalyticsRoutes(analyticsDeps),
    ...createSearchRoutes(searchDeps),
    ...(calendarDepsWithLimits ? createCalendarRoutes(calendarDepsWithLimits) : []),
  ];

  const router = createRouter({
    routes,
    middleware,
    onError: (error: Error) => {
      if (error instanceof RecFnError) {
        return Response.json(error.toEnvelope(), {
          status: error.httpStatus,
        });
      }
      if (error instanceof RouterError) {
        return error.toResponse();
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
export { registerCloudAdapters } from './transcription/register-adapters.js';
export type { CloudAsrConfig } from './transcription/register-adapters.js';
export { processTranscriptionJob } from './transcription/pipeline.js';
export type { TranscriptionJobInput, TranscriptionPipelineDeps } from './transcription/pipeline.js';
export { RecFnWebSocketServer } from './ws/server.js';
export type { WsServerDeps } from './ws/server.js';
export { TranscriptStreamManager, MAX_CONNECTIONS_PER_BOT } from './ws/transcript-stream.js';
export { authenticateWebSocket } from './ws/auth.js';
export type { WsAuthResult } from './ws/auth.js';
export { RealtimeTranscriptionPipeline } from './transcription/realtime.js';
export type { RealtimePipelineDeps } from './transcription/realtime.js';
export { createSearchFnClient } from './integrations/searchfn.js';
export type { SearchFnClient, TranscriptSearchDocument } from './integrations/searchfn.js';
export { indexTranscript } from './search/indexer.js';
export { createMemoryTokenStore, createOAuthBackedCalendarTokenStore } from './calendar/token-store.js';
export type { CalendarTokenStore } from './calendar/token-store.js';
export { createGoogleCalendarClient } from './calendar/google.js';
export type { GoogleCalendarClient } from './calendar/google.js';
export { createOutlookCalendarClient } from './calendar/outlook.js';
export type { OutlookCalendarClient } from './calendar/outlook.js';
export { pollAndSchedule } from './calendar/scheduler.js';
export type { CalendarSchedulerDeps, SchedulerConfig } from './calendar/scheduler.js';
export type { RecFnLimitsConfig, RecFnRateLimitConfig } from './config.js';
export { loadLimitsConfig, loadRateLimitConfig, DEFAULT_LIMITS, DEFAULT_RATE_LIMIT } from './config.js';
export { createRateLimitMiddleware } from './middleware/rate-limit.js';
export { refreshTokenIfNeeded, refreshCalendarToken } from './calendar/token-refresh.js';
export type { TokenRefreshProvider, TokenRefreshResult } from './calendar/token-refresh.js';
export { createMetricsEmitter } from './integrations/watchfn.js';
export type { MetricsEmitter } from './integrations/watchfn.js';
export { recordJoinLatency } from './observability/latency.js';
export { METRICS, emitBotsActive, emitRecordingsCount, emitAsrLatency, emitJoinLatency, emitWebhookDelivery, emitApiRequest } from './observability/metrics.js';

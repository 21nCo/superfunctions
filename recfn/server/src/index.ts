import { createRouter, type Router, RouterError } from '@superfunctions/http';
import { RecFnError } from '@recfn/core';
import type { RecFnStore } from './store/types.js';
import { assertProductionStore } from './store/db.js';
import type { ValidateApiKey } from './middleware/auth.js';
import type { QueueAdapter } from './integrations/flowfn.js';
import { createNoopLogger, type Logger } from './integrations/logfn.js';
import type { StorageAdapter } from './integrations/storage.js';
import { assertProductionStorage } from './integrations/storage.js';
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
import type { OAuthTokenHttpClient } from '@superfunctions/oauth-http';
import {
  createCalendarRuntimeService,
  createCalendarService,
  type CalendarRefreshProviderConfig,
  type CalendarRuntimeConfig,
  type CalendarRuntimeService,
  type CalendarService,
} from './calendar/service.js';
import type { MetricsEmitter } from './integrations/watchfn.js';

import { loadLimitsConfig, loadRateLimitConfig } from './config.js';
import { createRateLimitMiddleware } from './middleware/rate-limit.js';

export interface RecFnServerConfig {
  store: RecFnStore;
  validateApiKey: ValidateApiKey;
  queue?: QueueAdapter;
  logger?: Logger;
  storage?: StorageAdapter;
  environment?: 'production' | 'development' | 'test';
  searchClient?: SearchFnClient | null;
  tokenStore?: CalendarTokenStore;
  googleCalendarClient?: GoogleCalendarClient;
  outlookCalendarClient?: OutlookCalendarClient;
  calendarTokenHttpClient?: OAuthTokenHttpClient;
  calendarRefreshProviders?: Partial<
    Record<'google' | 'outlook', CalendarRefreshProviderConfig>
  >;
  calendarRuntime?: CalendarRuntimeConfig & { enabled?: boolean };
  /** If false, rate limiting is disabled. Default true. */
  rateLimit?: boolean;
  /** Optional metrics emitter (e.g. watchfn track). When provided, metrics are emitted. */
  metrics?: MetricsEmitter;
}

export interface RecFnServer {
  router: Router;
  calendarService?: CalendarService;
  calendarRuntime?: CalendarRuntimeService;
}

function resolveEnvironment(
  environment?: RecFnServerConfig['environment'],
): 'production' | 'development' | 'test' {
  if (environment) {
    return environment;
  }
  if (process.env.NODE_ENV === 'production') {
    return 'production';
  }
  if (process.env.NODE_ENV === 'test') {
    return 'test';
  }
  return 'development';
}

export function createRecFnServer(config: RecFnServerConfig): RecFnServer {
  const {
    store,
    validateApiKey,
    queue,
    logger,
    storage,
    environment,
    searchClient,
    tokenStore,
    googleCalendarClient,
    outlookCalendarClient,
    calendarTokenHttpClient,
    calendarRefreshProviders,
    calendarRuntime,
    rateLimit = true,
    metrics,
  } = config;
  const runtime = resolveEnvironment(environment);
  const resolvedLogger = logger ?? createNoopLogger();

  if (runtime === 'production') {
    assertProductionStore(store);
    assertProductionStorage(storage);
  }

  const limits = loadLimitsConfig();
  const rateLimitCfg = loadRateLimitConfig();

  const baseDeps = { store, validateApiKey, limits };
  const botDeps = { ...baseDeps, queue, logger: resolvedLogger, metrics, storage, searchClient };
  const recordingDeps = { ...baseDeps, storage };
  const uploadDeps =
    storage
      ? { ...baseDeps, storage, queue, logger: resolvedLogger, metrics }
      : null;

  const transcriptDeps = { ...baseDeps, queue };
  const webhookDeps = { ...baseDeps };
  const analyticsDeps = { ...baseDeps };
  const searchDeps = { ...baseDeps, searchClient: searchClient ?? null };

  const calendarService =
    tokenStore && googleCalendarClient && outlookCalendarClient
      ? createCalendarService({
          store,
          tokenStore,
          googleClient: googleCalendarClient,
          outlookClient: outlookCalendarClient,
          queue,
          logger: resolvedLogger,
          metrics,
          tokenHttpClient: calendarTokenHttpClient,
          refreshProviders: calendarRefreshProviders,
        })
      : null;

  const calendarDepsWithLimits =
    tokenStore && googleCalendarClient && outlookCalendarClient && calendarService
      ? {
          ...baseDeps,
          tokenStore,
          googleClient: googleCalendarClient,
          outlookClient: outlookCalendarClient,
          calendarService,
        }
      : null;

  const startedCalendarRuntime =
    calendarService && calendarRuntime?.enabled
      ? createCalendarRuntimeService(calendarService, calendarRuntime)
      : undefined;

  if (startedCalendarRuntime) {
    startedCalendarRuntime.start();
  }

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

  return {
    router,
    calendarService: calendarService ?? undefined,
    calendarRuntime: startedCalendarRuntime,
  };
}

export { createMemoryStore } from './store/memory.js';
export { createDbStore, assertProductionStore } from './store/db.js';
export { REC_FN_STORE_SCHEMA, getRecFnSchema } from './store/schema.js';
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
export { MemoryLogger, createConsoleLogger, createNoopLogger } from './integrations/logfn.js';
export type { Logger, LogEntry } from './integrations/logfn.js';
export {
  MemoryStorageAdapter,
  DEFAULT_SIGNED_URL_EXPIRY,
  DEFAULT_UPLOAD_TIMEOUT_MS,
  uploadObject,
  createDownloadUrl,
  createDownloadResponse,
  assertProductionStorage,
} from './integrations/storage.js';
export type { StorageAdapter, UploadOptions } from './integrations/storage.js';
export { createRecordingScratch, RecordingScratch } from './recording/scratch.js';
export type { RecordingScratchOptions, ScratchCleanupOptions, ScratchCleanupReport } from './recording/scratch.js';
export { captureFromStream, captureToFile } from './recording/capture.js';
export type { CaptureResult, CaptureOptions, CaptureArtifact } from './recording/capture.js';
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
export {
  createCalendarService,
  createCalendarRuntimeService,
} from './calendar/service.js';
export type {
  CalendarRefreshProviderConfig,
  CalendarRuntimeConfig,
  CalendarRuntimeService,
  CalendarService,
} from './calendar/service.js';
export type { RecFnLimitsConfig, RecFnRateLimitConfig } from './config.js';
export { loadLimitsConfig, loadRateLimitConfig, DEFAULT_LIMITS, DEFAULT_RATE_LIMIT } from './config.js';
export { createRateLimitMiddleware } from './middleware/rate-limit.js';
export { refreshTokenIfNeeded, refreshCalendarToken } from './calendar/token-refresh.js';
export type { TokenRefreshProvider, TokenRefreshResult } from './calendar/token-refresh.js';
export { createMetricsEmitter } from './integrations/watchfn.js';
export type { MetricsEmitter } from './integrations/watchfn.js';
export { recordJoinLatency } from './observability/latency.js';
export {
  METRICS,
  emitBotsActive,
  emitRecordingsCount,
  emitAsrLatency,
  emitJoinLatency,
  emitWebhookDelivery,
  emitCalendarScheduleDecision,
  emitApiRequest,
} from './observability/metrics.js';

export { deleteBotAggregate, type DeleteBotResult } from './deletion/service.js';
export type { BotDeletion, ProducerIntent } from './store/deletion.js';

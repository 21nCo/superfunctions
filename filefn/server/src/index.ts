import { instrumentAdapter, wrapWithSchema, type Adapter, type RuntimeStores } from '@superfunctions/db';
import { instrumentStorageAdapter, type StorageAdapter } from '@superfunctions/storage';
import type { FileProvider, FileProviderContext } from '@superfunctions/files';
import { type RateLimiter, createRateLimiter } from '@superfunctions/middleware';
import { applyObservationHeaders } from '@superfunctions/http';
import type { ObservabilityInput, ObservationLogger } from '@superfunctions/observability';
import { getSchema } from './schema.js';
import { createPolicyRegistry, type Policy, type PolicyRegistryWithDefine } from './policies.js';
import { createEventEmitter, type FileFnEventEmitter, type FileFnObservationEvent } from './events.js';
import { createUploadSessionService, type QuotaProvider, type UploadSessionService } from './upload-sessions/service.js';
import { createUploadSessionRoutes } from './upload-sessions/routes.js';
import { createFileService, type Authorizer, type FileService } from './files/service.js';
import { createFileRoutes } from './files/routes.js';
import { createDeduplicationService } from './dedup/service.js';
import { createGrantsService, type GrantsService } from './authz/grants.service.js';
import { createGrantsRoutes } from './authz/grants.routes.js';
import { createSharesService, type ShareLinkOptions, type SharesService } from './shares/service.js';
import { createSharesRoutes } from './shares/routes.js';
import { createProcessingService, type Processor, type FlowFnProvider, type ProcessingService } from './processing/service.js';
import { createProcessingRoutes } from './processing/routes.js';
import { bindProcessingJobs } from './processing/job-handler.js';
import { createPolicyRoutes } from './policies.routes.js';
import { createQuotaRoutes } from './quota.routes.js';
import { createRouter, normalizeBasePath, stripBasePath, type FileFnRouter } from './router.js';
import { createBackgroundScheduler, type FileFnRuntime } from './runtime.js';
import type { AuthConfig } from './auth.js';
import type { RateLimitClientKey } from './rate-limit-key.js';
import { redactSecrets as redactLogContext, type Logger } from './observability/logger.js';
import { createFileFnObservability } from './metrics.js';

export interface RateLimitCategory {
  windowSeconds: number;
  maxRequests: number;
}

export interface FileFnRouteRateLimits {
  uploadInit?: RateLimitCategory;
  uploadSign?: RateLimitCategory;
  uploadComplete?: RateLimitCategory;
  download?: RateLimitCategory;
  shareDownload?: RateLimitCategory;
  artifactDownload?: RateLimitCategory;
  /** `GET /` (file listing). */
  list?: RateLimitCategory;
  /** `POST /:fileId/process`. */
  processing?: RateLimitCategory;
  /** `POST /:fileId/permissions`. */
  grantCreate?: RateLimitCategory;
  /** `POST /:fileId/share-links`. */
  shareCreate?: RateLimitCategory;
}

export type FileFnRateLimitMode = 'strict' | 'best-effort' | 'local';

export interface FileFnConfig {
  database?: Adapter;
  /** @deprecated Use `database`. */
  db?: Adapter;
  storage: StorageAdapter;
  stores?: RuntimeStores;
  policies?: Policy[];
  auth?: AuthConfig;
  quota?: QuotaProvider;
  rateLimiter?: RateLimiter;
  rateLimit?: {
    mode?: FileFnRateLimitMode;
    algorithm?: 'fixed-window' | 'sliding-window' | 'token-bucket';
    limits?: FileFnRouteRateLimits;
    /**
     * Identifies unauthenticated callers (for example by the client IP your
     * proxy reports), so each gets its own bucket instead of all sharing one.
     */
    clientKey?: RateLimitClientKey;
  };
  observability?: ObservabilityInput<FileFnObservationEvent>;
  authorizer?: Authorizer;
  /**
   * Share links. `enabled: false` removes the share-link routes (creating,
   * listing, revoking and downloading); `requireAuth` makes every new link
   * require a signed-in downloader; `maxTtlSeconds` caps a link's lifetime and
   * is the lifetime of a link created without `expiresAt`. By default links
   * are enabled, public and never expire unless the creator sets `expiresAt`.
   */
  shares?: { enabled?: boolean } & ShareLinkOptions;
  /**
   * Grants. `allowCrossTenant: true` lets an owner grant a tenant other than
   * the file's own; by default such a grant is refused (403).
   */
  grants?: { allowCrossTenant?: boolean };
  namespace?: string;
  /**
   * Path prefix the router serves every route under, e.g. `/files` when the
   * host mounts FileFn at `/files/*`. Omitted, `''` or `/` serves routes at the
   * root. URLs FileFn returns (proxy upload and download paths) stay relative
   * to this mount, so clients use `<origin><basePath>` as their base URL.
   */
  basePath?: string;
  /** Host runtime hooks, e.g. `{ defer: (work) => ctx.waitUntil(work) }` on Workers. */
  runtime?: FileFnRuntime;
  defaultChunkSizeBytes?: number;
  uploadSessionTtlSeconds?: number;
  signedUrlTtlSeconds?: number;
  /**
   * How long an upload completion may run before another completion call of
   * the same session may take it over (default 900).
   */
  completionTimeoutSeconds?: number;
  dedup?: {
    enabled?: boolean;
  };
  processing?: {
    enabled?: boolean;
    processors?: Processor[];
    flowFn?: FlowFnProvider;
  };
}

/** Public domain services bound to the same schema, adapters, policies, and event emitter as FileFn's router. */
export interface FileFnServices {
  files: FileService;
  uploads: UploadSessionService;
  grants: GrantsService;
  shares: SharesService;
  processing: Pick<
    ProcessingService,
    | 'isEnabled'
    | 'listArtifactsForFile'
    | 'getArtifactDownloadUrlForFile'
    | 'getArtifactDownloadStreamForFile'
    | 'getReadableVersionForFile'
    | 'attachClientArtifact'
  > & {
    /**
     * Enqueues or runs processing of a file version. `force` replaces
     * client-supplied artifacts too and needs write access to the file.
     */
    triggerProcessingForFile(
      fileId: string,
      ctx: FileProviderContext,
      versionId?: string,
      options?: { force?: boolean },
    ): ReturnType<ProcessingService['triggerProcessing']>;
  };
  policies: PolicyRegistryWithDefine;
}

export interface FileFn extends FileProvider {
  router: FileFnRouter;
  events: FileFnEventEmitter;
  readonly services: FileFnServices;
  definePolicy(name: string, policy: Omit<Policy, 'name'>): void;
  getSchema(): ReturnType<typeof getSchema>;
  /**
   * Deletes upload sessions that expired before completing, aborting their
   * multipart uploads and proxy part objects. Call it from a scheduled job
   * (for example a Workers cron trigger); FileFn does not run it on its own.
   */
  cleanupExpiredSessions(): ReturnType<UploadSessionService['cleanupExpiredSessions']>;
  /**
   * Deletes artifact objects left recorded for versions that no longer exist,
   * such as a client upload that finished after its file was deleted. Call it
   * from a scheduled job; FileFn does not run it on its own.
   */
  cleanupOrphanedArtifacts(): ReturnType<ProcessingService['cleanupOrphanedArtifacts']>;
}

function hasConfiguredRouteRateLimits(limits?: FileFnRouteRateLimits): boolean {
  if (!limits) return false;
  return Boolean(
    limits.uploadInit ||
    limits.uploadSign ||
    limits.uploadComplete ||
    limits.download ||
    limits.shareDownload ||
    limits.artifactDownload ||
    limits.list ||
    limits.processing ||
    limits.grantCreate ||
    limits.shareCreate
  );
}

export function createFileFn(config: FileFnConfig): FileFn {
  const {
    database,
    storage,
    stores,
    policies: initialPolicies = [],
    auth = {},
    quota: hostQuota,
    rateLimiter,
    rateLimit,
    observability,
    authorizer,
    namespace = 'filefn',
    basePath,
    runtime,
    defaultChunkSizeBytes,
    uploadSessionTtlSeconds,
    signedUrlTtlSeconds,
    completionTimeoutSeconds,
    dedup,
    processing: processingConfig,
  } = config;
  // Anonymous files are owned by 'anonymous'; their quota account is the
  // provider's unset principal, as anonymous uploads have always been checked
  // and charged, so existing anonymous usage keeps counting.
  const quota = hostQuota && anonymousAsUnsetPrincipal(hostQuota);
  const inputDatabase = database ?? config.db;
  if (!inputDatabase) {
    throw new Error('FILEFN_DATABASE_REQUIRED: database is required');
  }
  const { scope: observabilityScope, domainMetrics } = createFileFnObservability(
    observability,
    (work) => background.track(work),
  );
  const logger = fileFnLoggerFromObservability(observabilityScope?.logger);
  const background = createBackgroundScheduler(runtime, logger);
  const db = wrapWithSchema(inputDatabase, getSchema({ namespace }));
  const observedDb = instrumentAdapter(db, {
    observability: observabilityScope?.child({ component: 'filefn.db' }),
    kind: 'db',
  });
  const observedStorage = instrumentStorageAdapter(storage, {
    observability: observabilityScope?.child({ component: 'filefn.storage' }),
    kind: 'storage',
  });

  const policyRegistry = createPolicyRegistry(initialPolicies);
  const events = createEventEmitter(observabilityScope, background);
  const deduplication = createDeduplicationService({
    db: observedDb,
    policies: policyRegistry,
    namespace,
    enabled: dedup?.enabled ?? false,
  });

  const routeRateLimits = rateLimit?.limits;
  const hasRouteRateLimits = hasConfiguredRouteRateLimits(routeRateLimits);

  if (rateLimit && !hasRouteRateLimits) {
    throw new Error('RATE_LIMIT_CONFIG_INVALID: Missing route-category limits');
  }

  let finalRateLimiter = rateLimiter;
  if (!finalRateLimiter && rateLimit && routeRateLimits) {
    const seedLimit =
      routeRateLimits.uploadInit ||
      routeRateLimits.uploadSign ||
      routeRateLimits.uploadComplete ||
      routeRateLimits.download ||
      routeRateLimits.shareDownload ||
      routeRateLimits.artifactDownload ||
      routeRateLimits.list ||
      routeRateLimits.processing ||
      routeRateLimits.grantCreate ||
      routeRateLimits.shareCreate;

    const mode = rateLimit.mode ?? (stores?.atomicKv ? 'strict' : stores?.kv ? 'best-effort' : 'local');
    if (mode === 'strict' && !stores?.atomicKv) {
      throw new Error('FILEFN_ATOMIC_STORE_REQUIRED: rateLimit strict mode requires stores.atomicKv');
    }
    finalRateLimiter = createRateLimiter({
      windowMs: (seedLimit?.windowSeconds || 60) * 1000,
      maxRequests: seedLimit?.maxRequests || 100,
      atomicStore: mode === 'strict' ? stores?.atomicKv : undefined,
      persistence: mode === 'best-effort' ? stores?.kv : undefined,
      algorithm: rateLimit.algorithm,
    });
  }

  const legacyGlobalRateLimit = Boolean(rateLimiter && !rateLimit);

  // Create file service first so we can use it for authorization checks
  const fileService = createFileService({
    db: observedDb,
    storage: observedStorage,
    policies: policyRegistry,
    events,
    logger,
    quota,
    authorizer,
    namespace,
    signedUrlTtlSeconds,
    databaseIdentity: inputDatabase,
  });

  const processingService = createProcessingService({
    db: observedDb,
    storage: observedStorage,
    policies: policyRegistry,
    events,
    processors: processingConfig?.processors,
    flowFn: processingConfig?.flowFn,
    logger,
    metrics: domainMetrics,
    namespace,
    enabled: processingConfig?.enabled ?? false,
    background,
    writeChecker: fileService,
    readChecker: fileService,
  });

  const uploadService = createUploadSessionService({
    db: observedDb,
    storage: observedStorage,
    policies: policyRegistry,
    events,
    logger,
    metrics: domainMetrics,
    quota,
    dedup: deduplication,
    fileWriteChecker: fileService,
    processingService,
    namespace,
    defaultChunkSizeBytes,
    uploadSessionTtlSeconds,
    signedUrlTtlSeconds,
    completionTimeoutSeconds,
    databaseIdentity: inputDatabase,
  });
  // A sweep through either entry point (fileFn.cleanupExpiredSessions or
  // fileFn.services.uploads.cleanupExpiredSessions) counts once it has run.
  const runSweep = uploadService.cleanupExpiredSessions.bind(uploadService);
  uploadService.cleanupExpiredSessions = async (...args: Parameters<typeof runSweep>) => {
    const result = await runSweep(...args);
    sweepState.ran = true;
    return result;
  };

  const uploadRoutes = createUploadSessionRoutes({
    service: uploadService,
    auth,
    rateLimiter: finalRateLimiter,
    rateLimits: {
      uploadInit: routeRateLimits?.uploadInit,
      uploadSign: routeRateLimits?.uploadSign,
      uploadComplete: routeRateLimits?.uploadComplete,
    },
    legacyGlobalRateLimit,
    clientKey: rateLimit?.clientKey,
  });

  const fileRoutes = createFileRoutes({
    service: fileService,
    auth,
    rateLimiter: finalRateLimiter,
    rateLimits: {
      download: routeRateLimits?.download,
      list: routeRateLimits?.list,
    },
    legacyGlobalRateLimit,
    clientKey: rateLimit?.clientKey,
  });

  const grantsService = createGrantsService({
    db: observedDb,
    namespace,
    allowCrossTenantGrants: config.grants?.allowCrossTenant === true,
  });

  const grantsRoutes = createGrantsRoutes({
    service: grantsService,
    auth,
    rateLimiter: finalRateLimiter,
    rateLimits: { grantCreate: routeRateLimits?.grantCreate },
    clientKey: rateLimit?.clientKey,
  });

  const sharesService = createSharesService({
    db: observedDb,
    storage: observedStorage,
    policies: policyRegistry,
    namespace,
    signedUrlTtlSeconds,
    options: { requireAuth: config.shares?.requireAuth, maxTtlSeconds: config.shares?.maxTtlSeconds },
  });

  const sharesRoutes = createSharesRoutes({
    service: sharesService,
    auth,
    rateLimiter: finalRateLimiter,
    rateLimits: {
      shareDownload: routeRateLimits?.shareDownload,
      shareCreate: routeRateLimits?.shareCreate,
    },
    clientKey: rateLimit?.clientKey,
  });

  const processingRoutes = createProcessingRoutes({
    service: processingService,
    auth,
    rateLimiter: finalRateLimiter,
    rateLimits: {
      artifactDownload: routeRateLimits?.artifactDownload,
      processing: routeRateLimits?.processing,
    },
    clientKey: rateLimit?.clientKey,
  });

  const policyRoutes = createPolicyRoutes({
    policyRegistry,
    auth,
  });

  // The quota route reports the caller's own account as the host's provider
  // names it (the anonymous normalisation applies to upload accounting only).
  const quotaRoutes = createQuotaRoutes({
    quota: hostQuota,
    auth,
  });

  const baseRouter = createRouter({
    uploadRoutes,
    fileRoutes,
    grantsRoutes,
    sharesRoutes: config.shares?.enabled === false ? undefined : sharesRoutes,
    processingRoutes,
    policyRoutes,
    quotaRoutes,
    basePath,
  });
  // Expired sessions, their part objects and orphaned artifacts are removed
  // only by the host's scheduled sweeps. Say so once per process (not per
  // FileFn instance: hosts that build one per request share the process) when
  // uploads start and no sweep has run in the process yet.
  // Only a host logger with a warn method uses up the warning, and a sink that
  // throws never fails the upload.
  const hostWarn = typeof observabilityScope?.logger?.warn === 'function' ? logger?.warn : undefined;
  events.once('upload.started', () => {
    if (hostWarn && !sweepState.ran && !sweepState.warned) {
      sweepState.warned = true;
      try {
        const sent: unknown = hostWarn('Uploads started but cleanupExpiredSessions has not run in this process', {
          hint: 'Schedule cleanupExpiredSessions() and cleanupOrphanedArtifacts(); without them expired sessions and their stored objects are never removed.',
        });
        // An async sink that rejects must not become an unhandled rejection.
        if (sent && typeof (sent as PromiseLike<unknown>).then === 'function') {
          (sent as PromiseLike<unknown>).then(undefined, () => {});
        }
      } catch {
        // The warning is advisory.
      }
    }
  });

  const mountPath = normalizeBasePath(basePath);
  const router: FileFnRouter = observabilityScope
    ? {
        async handle(request) {
          if (stripBasePath(new URL(request.url).pathname, mountPath) === null) {
            return null; // Not FileFn's request: leave it unobserved for the host.
          }
          const existing = observabilityScope.getCurrentRequest();
          if (existing) {
            return baseRouter.handle(request);
          }
          // Share-link tokens are bearer secrets in the path: record the route
          // shape, never the token.
          const observation = observabilityScope.startRequest({
            request,
            path: redactObservedPath(new URL(request.url).pathname, mountPath),
          });
          const response = await observabilityScope.runWithRequest(
            observation,
            () => baseRouter.handle(request),
          );
          const snapshot = observation.finish({
            status: response?.status ?? 404,
          });
          if (!response) {
            return response;
          }
          const headers = new Headers(response.headers);
          applyObservationHeaders(headers, snapshot, {
            serverTiming: true,
            headers: { prefix: 'x-filefn' },
          });
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        },
      }
    : baseRouter;

  const fileFn: FileFn = {
    router,
    events,
    services: {
      files: fileService,
      uploads: uploadService,
      grants: grantsService,
      shares: sharesService,
      processing: {
        isEnabled: processingService.isEnabled.bind(processingService),
        listArtifactsForFile: processingService.listArtifactsForFile.bind(processingService),
        getArtifactDownloadUrlForFile: processingService.getArtifactDownloadUrlForFile.bind(processingService),
        getArtifactDownloadStreamForFile: processingService.getArtifactDownloadStreamForFile.bind(processingService),
        getReadableVersionForFile: processingService.getReadableVersionForFile.bind(processingService),
        attachClientArtifact: processingService.attachClientArtifact.bind(processingService),
        async triggerProcessingForFile(fileId, ctx, versionId, options) {
          const force = options?.force === true;
          // Forcing replaces client-supplied artifacts: it needs write access,
          // which the configured write check alone decides.
          const { file, version } = force
            ? await processingService.getWritableVersionForFile(fileId, ctx, versionId)
            : await (async () => {
              const readable = await fileService.getFile(fileId, ctx);
              return { file: readable, version: await fileService.getVersion(fileId, versionId ?? readable.currentVersionId, ctx) };
            })();
          return processingService.triggerProcessing({
            fileId: file.fileId,
            versionId: version.versionId,
            storageKey: version.storageKey,
            mimeType: version.mimeType,
            size: version.size,
            fileName: file.name,
            tenantId: file.tenantId ?? ctx.tenantId,
            force,
          }, ctx);
        },
      },
      policies: policyRegistry,
    },

    definePolicy(name: string, policy: Omit<Policy, 'name'>): void {
      policyRegistry.define(name, policy);
    },

    getSchema() {
      return getSchema({ namespace });
    },

    cleanupExpiredSessions() {
      return uploadService.cleanupExpiredSessions();
    },

    cleanupOrphanedArtifacts() {
      return processingService.cleanupOrphanedArtifacts();
    },

    // FileProvider implementation
    async createUploadSession(input, ctx) {
      return uploadService.createSession(input, ctx);
    },

    async getUploadSessionStatus(input, ctx) {
      const uploadSessionToken = (ctx as any)?.uploadSessionToken as string | undefined;
      return uploadService.getSessionStatus(input.uploadSessionId, ctx, uploadSessionToken);
    },

    async signUploadPart(input, ctx) {
      const uploadSessionToken = (ctx as any)?.uploadSessionToken as string | undefined;
      return uploadService.signPart(input.uploadSessionId, input.partNumber, input.contentLength, ctx, uploadSessionToken);
    },

    async completeUploadPart(input, ctx) {
      const uploadSessionToken = (ctx as any)?.uploadSessionToken as string | undefined;
      await uploadService.completePart(input.uploadSessionId, input.partNumber, input.etag, input.size, ctx, uploadSessionToken);
    },

    async completeUploadSession(input, ctx) {
      const uploadSessionToken = (ctx as any)?.uploadSessionToken as string | undefined;
      return uploadService.completeSession(input.uploadSessionId, ctx, uploadSessionToken);
    },

    async abortUploadSession(input, ctx) {
      const uploadSessionToken = (ctx as any)?.uploadSessionToken as string | undefined;
      await uploadService.abortSession(input.uploadSessionId, ctx, uploadSessionToken);
    },

    async getFile(input, ctx) {
      return fileService.getFile(input.fileId, ctx, input.versionId);
    },

    async listFiles(input, ctx) {
      return fileService.listFiles(ctx, input);
    },

    async deleteFile(input, ctx) {
      await fileService.deleteFile(input.fileId, ctx);
    },
  };
  bindProcessingJobs(fileFn, processingService);
  return fileFn;
}

// Re-exports
export { getSchema, getSchemaMap } from './schema.js';
export {
  DEFAULT_STORAGE_TARGET,
  NUCLEUS_ALLOWED_CONTENT_TYPES,
  NUCLEUS_MAX_SIZE_BYTES,
  computeStoragePath,
  createNucleusPolicies,
  createPolicyRegistry,
  matchesContentType,
  resolveArtifactStorageTarget,
  resolveStorageTarget,
  sanitizeStorageKeySegment,
  unsafeStorageKeyReason,
  validatePolicyConstraints,
} from './policies.js';
export type { Policy, PolicyRegistry, Visibility } from './policies.js';
export { createEventEmitter } from './events.js';
export type {
  FileDeletedEvent,
  FileFnEvent,
  FileFnEventEmitter,
  FileFnEventType,
  FileFnEventTypes,
  FileFnObservationEvent,
  FileFnObservationEventMap,
  FileFnObservationMetadata,
  FileUploadedEvent,
  PartRecordedEvent,
  ProcessingCompletedEvent,
  ProcessingFailedEvent,
  ProcessingStartedEvent,
  UploadStartedEvent,
} from './events.js';
export { resolvePrincipal } from './auth.js';
export type { AuthConfig, AuthProvider, FileFnPrincipal } from './auth.js';
export { createUploadSessionService } from './upload-sessions/service.js';
export type { QuotaProvider, UploadSessionService, CreateSessionInput, UploadSession } from './upload-sessions/service.js';
export { createFileService } from './files/service.js';
export type { FileService, FileRecord, FileVersionRecord, Authorizer } from './files/service.js';
export { DEFAULT_IMPORT_POLICY } from './files/import.js';
export type { ImportObjectInput, ImportObjectResult } from './files/import.js';
export * from './errors.js';
export type { FileFnRouter } from './router.js';
export type { FileFnRuntime } from './runtime.js';

// Authorization exports
export { composeAuthorizers, createDefaultAuthorizer } from './authz/authorizer.js';
export type { AuthorizerStrategy, ComposeAuthorizersOptions, FilePermissionRecord, DefaultAuthorizerConfig } from './authz/authorizer.js';
export { createGrantsService } from './authz/grants.service.js';
export type { GrantsService, CreateGrantInput } from './authz/grants.service.js';
export { createGrantsRoutes } from './authz/grants.routes.js';
export type { GrantsRoutes, GrantsRouteContext } from './authz/grants.routes.js';

// Share link exports
export { createSharesService } from './shares/service.js';
export type { SharesService, FileShareRecord, CreateShareLinkInput, ShareLinkOptions } from './shares/service.js';
export { createSharesRoutes } from './shares/routes.js';
export type { SharesRoutes, SharesRouteContext } from './shares/routes.js';

// Observability exports
export { createLogger, redactSecrets } from './observability/logger.js';
export type { Logger, LogContext, LoggerOptions } from './observability/logger.js';

// Processing exports
export { createProcessingService, PROCESSING_QUEUE_NAME, PROCESSING_RUN_KIND } from './processing/service.js';
export type {
  ArtifactProcessingMetadata,
  ClientArtifactUpload,
  ProcessingJob,
  ProcessingJobDelivery,
  ProcessingJobOutcome,
  ProcessorInstance,
  ProcessingService,
  Processor,
  ProcessorInput,
  ProcessorOutputArtifact,
  ProcessorResult,
  FileArtifactRecord,
  FlowFnProvider,
  FlowFnQueue,
} from './processing/service.js';
export { createProcessingRoutes } from './processing/routes.js';
export {
  CLIENT_ARTIFACT_KINDS,
  CLIENT_CONVERTED_KIND,
  CLIENT_THUMBNAIL_KINDS,
  CLIENT_THUMBNAIL_MAX_BYTES,
  clientArtifactRule,
} from './processing/client-artifacts.js';
export type {
  ArtifactSource,
  ClientArtifactProcessingMetadata,
  ClientArtifactRule,
} from './processing/client-artifacts.js';
export { createProcessingJobHandler } from './processing/job-handler.js';
export type {
  ProcessingJobDeliveryInfo,
  ProcessingJobHandler,
  ProcessingJobHandlerOptions,
  ProcessingQueueBatch,
  ProcessingQueueMessage,
} from './processing/job-handler.js';
export type { ProcessingRoutes, ProcessingRoutesConfig } from './processing/routes.js';

function fileFnLoggerFromObservability(logger: ObservationLogger | undefined): Logger | undefined {
  if (!logger) {
    return undefined;
  }
  // The same redaction as FileFn's own logger: signed URLs, bearer and session
  // tokens never reach the host's sink.
  const safe = (context: Parameters<Logger['info']>[1]) => (context ? redactLogContext(context) : context);
  return {
    info: (message, context) => logger.info?.(message, safe(context)),
    warn: (message, context) => logger.warn?.(message, safe(context)),
    error: (message, context) => logger.error?.(message, safe(context)),
    debug: (message, context) => logger.debug?.(message, safe(context)),
  };
}

function anonymousAsUnsetPrincipal(quota: QuotaProvider): QuotaProvider {
  const principal = (id: string | undefined) => (id === 'anonymous' ? undefined : id);
  return {
    ...quota,
    checkQuota: (input) => quota.checkQuota({ ...input, principalId: principal(input.principalId) }),
    recordUsage: (input) => quota.recordUsage({ ...input, principalId: principal(input.principalId) }),
    ...(quota.getUsage ? { getUsage: (principalId?: string, tenantId?: string) => quota.getUsage!(principal(principalId), tenantId) } : {}),
  };
}

// Process-wide: whether any FileFn instance in this process ran the expiry
// sweep, and whether the missing-sweep warning was already given.
const sweepState = { ran: false, warned: false };

// The router's share-link routes, on the path under the mount.
const SHARE_TOKEN_ROUTES: RegExp[] = [
  /^(\/share-links\/)[^/]+(\/download)$/,
  /^(\/proxy\/share-links\/)[^/]+(\/download)$/,
  /^(\/[^/]+\/share-links\/)[^/]+()$/,
];

/**
 * A request path with its share-link token replaced by `:token`. The token is
 * found on the route path under `mountPath` (FileFn's `basePath`), with the
 * router's own share-link patterns, so a mount path that itself contains
 * `share-links` can't shift the match off the token.
 */
export function redactObservedPath(pathname: string, mountPath = ''): string {
  const route = stripBasePath(pathname, mountPath);
  if (route === null) return pathname;
  for (const pattern of SHARE_TOKEN_ROUTES) {
    if (pattern.test(route)) {
      return `${mountPath}${route.replace(pattern, '$1:token$2')}`;
    }
  }
  return pathname;
}
export type { RateLimitClientKey } from './rate-limit-key.js';
export {
  INLINE_SAFE_CONTENT_TYPES,
  buildDownloadHeaders,
  contentDisposition,
  isInlineSafeContentType,
  signedDownloadConstraints,
} from './download-headers.js';

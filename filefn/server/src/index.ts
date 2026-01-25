import type { Adapter } from '@superfunctions/db';
import type { StorageAdapter } from '@superfunctions/storage';
import type { FileProvider } from '@superfunctions/files';
import type { RateLimiter } from '@superfunctions/middleware';
import { getSchema } from './schema.js';
import { createPolicyRegistry, type Policy } from './policies.js';
import { createEventEmitter, type FileFnEventEmitter } from './events.js';
import { createUploadSessionService, type QuotaProvider } from './upload-sessions/service.js';
import { createUploadSessionRoutes } from './upload-sessions/routes.js';
import { createFileService, type Authorizer } from './files/service.js';
import { createFileRoutes } from './files/routes.js';
import { createGrantsService } from './authz/grants.service.js';
import { createGrantsRoutes } from './authz/grants.routes.js';
import { createSharesService } from './shares/service.js';
import { createSharesRoutes } from './shares/routes.js';
import { createProcessingService, type Processor, type FlowFnProvider } from './processing/service.js';
import { createProcessingRoutes } from './processing/routes.js';
import { createRouter, type FileFnRouter } from './router.js';
import type { AuthConfig } from './auth.js';

export interface FileFnConfig {
  db: Adapter;
  storage: StorageAdapter;
  policies?: Policy[];
  auth?: AuthConfig;
  quota?: QuotaProvider;
  rateLimiter?: RateLimiter;
  authorizer?: Authorizer;
  namespace?: string;
  defaultChunkSizeBytes?: number;
  uploadSessionTtlSeconds?: number;
  signedUrlTtlSeconds?: number;
  processing?: {
    enabled?: boolean;
    processors?: Processor[];
    flowFn?: FlowFnProvider;
  };
}

export interface FileFn extends FileProvider {
  router: FileFnRouter;
  events: FileFnEventEmitter;
  definePolicy(name: string, policy: Omit<Policy, 'name'>): void;
  getSchema(): ReturnType<typeof getSchema>;
}

export function createFileFn(config: FileFnConfig): FileFn {
  const {
    db,
    storage,
    policies: initialPolicies = [],
    auth = {},
    quota,
    rateLimiter,
    authorizer,
    namespace = 'filefn',
    defaultChunkSizeBytes,
    uploadSessionTtlSeconds,
    signedUrlTtlSeconds,
    processing: processingConfig,
  } = config;

  const policyRegistry = createPolicyRegistry(initialPolicies);
  const events = createEventEmitter();

  const uploadService = createUploadSessionService({
    db,
    storage,
    policies: policyRegistry,
    events,
    quota,
    namespace,
    defaultChunkSizeBytes,
    uploadSessionTtlSeconds,
    signedUrlTtlSeconds,
  });

  const uploadRoutes = createUploadSessionRoutes({
    service: uploadService,
    auth,
    rateLimiter,
  });

  const fileService = createFileService({
    db,
    storage,
    events,
    quota,
    authorizer,
    namespace,
    signedUrlTtlSeconds,
  });

  const fileRoutes = createFileRoutes({
    service: fileService,
    auth,
    rateLimiter,
  });

  const grantsService = createGrantsService({
    db,
    namespace,
  });

  const grantsRoutes = createGrantsRoutes({
    service: grantsService,
    auth,
  });

  const sharesService = createSharesService({
    db,
    storage,
    namespace,
    signedUrlTtlSeconds,
  });

  const sharesRoutes = createSharesRoutes({
    service: sharesService,
    auth,
  });

  const processingService = createProcessingService({
    db,
    storage,
    events,
    processors: processingConfig?.processors,
    flowFn: processingConfig?.flowFn,
    namespace,
    enabled: processingConfig?.enabled ?? true,
  });

  const processingRoutes = createProcessingRoutes({
    service: processingService,
    auth,
  });

  const router = createRouter({ uploadRoutes, fileRoutes, grantsRoutes, sharesRoutes, processingRoutes });

  return {
    router,
    events,

    definePolicy(name: string, policy: Omit<Policy, 'name'>): void {
      policyRegistry.define(name, policy);
    },

    getSchema() {
      return getSchema({ namespace });
    },

    // FileProvider implementation
    async createUploadSession(input, ctx) {
      const result = await uploadService.createSession(input, ctx);
      return { uploadSessionId: result.uploadSessionId };
    },

    async getUploadSessionStatus(input, ctx) {
      return uploadService.getSessionStatus(input.uploadSessionId, ctx);
    },

    async signUploadPart(input, ctx) {
      return uploadService.signPart(input.uploadSessionId, input.partNumber, input.contentLength, ctx);
    },

    async completeUploadPart(input, ctx) {
      await uploadService.completePart(input.uploadSessionId, input.partNumber, input.etag, input.size, ctx);
    },

    async completeUploadSession(input, ctx) {
      return uploadService.completeSession(input.uploadSessionId, ctx);
    },

    async abortUploadSession(input, ctx) {
      await uploadService.abortSession(input.uploadSessionId, ctx);
    },

    async getFile(input, ctx) {
      return fileService.getFile(input.fileId, ctx);
    },

    async listFiles(input, ctx) {
      return fileService.listFiles(ctx, input);
    },

    async deleteFile(input, ctx) {
      await fileService.deleteFile(input.fileId, ctx);
    },
  };
}

// Re-exports
export { getSchema, getSchemaMap } from './schema.js';
export { createPolicyRegistry, validatePolicyConstraints, computeStoragePath } from './policies.js';
export type { Policy, PolicyRegistry, Visibility } from './policies.js';
export { createEventEmitter } from './events.js';
export type { FileFnEvent, FileFnEventTypes, FileFnEventEmitter } from './events.js';
export { resolvePrincipal } from './auth.js';
export type { AuthConfig, AuthProvider, FileFnPrincipal } from './auth.js';
export type { QuotaProvider } from './upload-sessions/service.js';
export { createFileService } from './files/service.js';
export type { FileService, FileRecord, FileVersionRecord, Authorizer } from './files/service.js';
export * from './errors.js';
export type { FileFnRouter } from './router.js';

// Authorization exports
export { composeAuthorizers, createDefaultAuthorizer } from './authz/authorizer.js';
export type { AuthorizerStrategy, ComposeAuthorizersOptions, FilePermissionRecord, DefaultAuthorizerConfig } from './authz/authorizer.js';
export { createGrantsService } from './authz/grants.service.js';
export type { GrantsService, CreateGrantInput } from './authz/grants.service.js';
export { createGrantsRoutes } from './authz/grants.routes.js';
export type { GrantsRoutes, GrantsRouteContext } from './authz/grants.routes.js';

// Share link exports
export { createSharesService } from './shares/service.js';
export type { SharesService, FileShareRecord, CreateShareLinkInput } from './shares/service.js';
export { createSharesRoutes } from './shares/routes.js';
export type { SharesRoutes, SharesRouteContext } from './shares/routes.js';

// Observability exports
export { createLogger, redactSecrets } from './observability/logger.js';
export type { Logger, LogContext, LoggerOptions } from './observability/logger.js';

// Processing exports
export { createProcessingService } from './processing/service.js';
export type {
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
export type { ProcessingRoutes, ProcessingRoutesConfig } from './processing/routes.js';

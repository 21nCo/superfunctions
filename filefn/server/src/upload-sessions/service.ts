import type { Adapter } from '@superfunctions/db';
import type { StorageAdapter } from '@superfunctions/storage';
import type { FileProviderContext } from '@superfunctions/files';
import type { Policy, PolicyRegistry } from '../policies.js';
import type { FileFnEventEmitter } from '../events.js';
import * as errors from '../errors.js';
import {
  createUploadStartedEvent,
  createPartRecordedEvent,
  createFileUploadedEvent,
} from '../events.js';

export interface QuotaProvider {
  checkQuota(input: { principalId?: string; tenantId?: string; requestedBytes: number }): Promise<{
    allowed: boolean;
    current: number;
    limit: number;
    warning?: string;
  }>;
  recordUsage(input: { principalId?: string; tenantId?: string; bytes: number }): Promise<void>;
}

export interface UploadSessionServiceConfig {
  db: Adapter;
  storage: StorageAdapter;
  policies: PolicyRegistry;
  events: FileFnEventEmitter;
  quota?: QuotaProvider;
  namespace?: string;
  defaultChunkSizeBytes?: number;
  uploadSessionTtlSeconds?: number;
  signedUrlTtlSeconds?: number;
  generateId?: () => string;
}

export interface CreateSessionInput {
  policy: string;
  fileName: string;
  size: number;
  mimeType: string;
  fileId?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface UploadSession {
  uploadSessionId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'aborted' | 'expired';
  policy: string;
  fileId: string | null;
  fileName: string;
  mimeType: string;
  size: number;
  uploadMode: string;
  chunkSizeBytes: number;
  totalParts: number;
  storageKey: string;
  storageUploadId: string | null;
  ownerId: string;
  tenantId: string | null;
  expiresAt: string;
  createdAt: string;
  idempotencyKey?: string | null;
  idempotencyPayloadHash?: string | null;
}

function generateDefaultId(): string {
  return `upl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function hashPayload(input: CreateSessionInput): string {
  const str = JSON.stringify({ p: input.policy, f: input.fileName, s: input.size, m: input.mimeType });
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

function computeStorageKey(
  policy: Policy,
  ctx: { fileName: string; principalId?: string; tenantId?: string; fileId: string; versionId: string }
): string {
  if (policy.storagePath) {
    return policy.storagePath(ctx);
  }
  const parts: string[] = [];
  if (ctx.tenantId) parts.push(ctx.tenantId);
  if (ctx.principalId) parts.push(ctx.principalId);
  parts.push(ctx.fileId);
  parts.push(`${ctx.versionId}-${ctx.fileName}`);
  return parts.join('/');
}

export function createUploadSessionService(config: UploadSessionServiceConfig) {
  const {
    db,
    storage,
    policies,
    events,
    quota,
    namespace = 'filefn',
    defaultChunkSizeBytes = 8 * 1024 * 1024, // 8 MiB
    uploadSessionTtlSeconds = 86400, // 24h
    signedUrlTtlSeconds = 900, // 15m
    generateId = generateDefaultId,
  } = config;

  function selectUploadMode(): string {
    if (storage.capabilities.signedUploadUrls && storage.capabilities.multipart) {
      return 'multipart-signed-url';
    }
    if (storage.capabilities.signedUploadUrls) {
      return 'signed-url';
    }
    if (storage.capabilities.proxyStreamingUpload) {
      return 'proxy';
    }
    throw errors.noSupportedUploadMode();
  }

  function computeTotalParts(size: number, chunkSize: number): number {
    return Math.ceil(size / chunkSize);
  }

  return {
    async createSession(input: CreateSessionInput, ctx: FileProviderContext): Promise<{
      uploadSessionId: string;
      uploadMode: string;
      chunkSizeBytes: number;
      totalParts: number;
      expiresAt: string;
      warnings: string[];
    }> {
      const warnings: string[] = [];

      // Check idempotency
      if (input.idempotencyKey) {
        const existing = await db.findOne<UploadSession>({
          model: 'uploadSessions',
          where: [{ field: 'idempotencyKey', operator: 'eq', value: input.idempotencyKey }],
          namespace,
        });

        if (existing) {
          const expectedHash = hashPayload(input);
          if (existing.idempotencyPayloadHash !== expectedHash) {
            throw errors.idempotencyConflict();
          }
          return {
            uploadSessionId: existing.uploadSessionId,
            uploadMode: existing.uploadMode,
            chunkSizeBytes: existing.chunkSizeBytes,
            totalParts: existing.totalParts,
            expiresAt: existing.expiresAt,
            warnings: [],
          };
        }
      }

      // Validate policy
      const policy = policies.get(input.policy);
      if (!policy) {
        throw errors.policyNotFound(input.policy);
      }

      // Validate constraints
      if (policy.contentTypes && policy.contentTypes.length > 0) {
        if (!policy.contentTypes.includes(input.mimeType)) {
          throw errors.policyContentTypeNotAllowed(input.policy, input.mimeType);
        }
      }

      if (policy.maxSizeBytes !== undefined && input.size > policy.maxSizeBytes) {
        throw errors.policyMaxSizeExceeded(input.policy, policy.maxSizeBytes, input.size);
      }

      // Check quota
      if (quota) {
        const quotaResult = await quota.checkQuota({
          principalId: ctx.principalId,
          tenantId: ctx.tenantId,
          requestedBytes: input.size,
        });

        if (!quotaResult.allowed) {
          throw errors.quotaExceeded(quotaResult.current, quotaResult.limit, input.size);
        }

        if (quotaResult.warning) {
          warnings.push(quotaResult.warning);
        }
      }

      const uploadMode = selectUploadMode();
      const chunkSizeBytes = defaultChunkSizeBytes;
      const totalParts = computeTotalParts(input.size, chunkSizeBytes);
      const uploadSessionId = generateId();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + uploadSessionTtlSeconds * 1000).toISOString();
      const fileId = input.fileId || `file_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const versionId = `ver_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

      const storageKey = computeStorageKey(policy, {
        fileName: input.fileName,
        principalId: ctx.principalId,
        tenantId: ctx.tenantId,
        fileId,
        versionId,
      });

      let storageUploadId: string | null = null;

      // Create multipart upload if supported
      if (storage.capabilities.multipart && storage.createMultipartUpload) {
        const result = await storage.createMultipartUpload({
          key: storageKey,
          contentType: input.mimeType,
        });
        storageUploadId = result.uploadId;
      }

      // Save session
      await db.create({
        model: 'uploadSessions',
        data: {
          uploadSessionId,
          status: 'pending',
          policy: input.policy,
          fileId: input.fileId || null,
          fileName: input.fileName,
          mimeType: input.mimeType,
          size: input.size,
          uploadMode,
          chunkSizeBytes,
          totalParts,
          storageKey,
          storageUploadId,
          ownerId: ctx.principalId || 'anonymous',
          tenantId: ctx.tenantId || null,
          idempotencyKey: input.idempotencyKey || null,
          idempotencyPayloadHash: input.idempotencyKey ? hashPayload(input) : null,
          expiresAt,
          createdAt: now.toISOString(),
        },
        namespace,
      });

      events.emit('upload.started', createUploadStartedEvent({
        uploadSessionId,
        fileName: input.fileName,
        size: input.size,
        mimeType: input.mimeType,
        policy: input.policy,
        principalId: ctx.principalId,
        tenantId: ctx.tenantId,
      }, ctx.requestId));

      return { uploadSessionId, uploadMode, chunkSizeBytes, totalParts, expiresAt, warnings };
    },

    async getSessionStatus(uploadSessionId: string, ctx: FileProviderContext): Promise<{
      uploadSessionId: string;
      status: string;
      totalParts: number;
      uploadedParts: number[];
    }> {
      void ctx;
      const session = await db.findOne<UploadSession>({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        namespace,
      });

      if (!session) {
        throw errors.sessionNotFound();
      }

      const parts = await db.findMany<{ partNumber: number }>({
        model: 'uploadParts',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        select: ['partNumber'],
        namespace,
      });

      return {
        uploadSessionId,
        status: session.status,
        totalParts: session.totalParts,
        uploadedParts: parts.map(p => p.partNumber).sort((a, b) => a - b),
      };
    },

    async signPart(uploadSessionId: string, partNumber: number, contentLength: number, ctx: FileProviderContext): Promise<{
      url: string;
      headers?: Record<string, string>;
      expiresAt: string;
    }> {
      void ctx;
      const session = await db.findOne<UploadSession>({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        namespace,
      });

      if (!session) throw errors.sessionNotFound();
      if (session.status === 'aborted') throw errors.uploadAborted();
      if (session.status === 'completed') throw errors.uploadAlreadyCompleted();
      if (new Date(session.expiresAt) < new Date()) throw errors.uploadExpired();
      if (partNumber < 1 || partNumber > session.totalParts) throw errors.invalidPartNumber();

      if (!storage.signMultipartUploadPartUrl) {
        throw errors.noSupportedUploadMode();
      }

      const result = await storage.signMultipartUploadPartUrl({
        key: session.storageKey,
        uploadId: session.storageUploadId!,
        partNumber,
        expiresInSeconds: signedUrlTtlSeconds,
        constraints: { contentLength },
      });

      const expiresAt = new Date(Date.now() + signedUrlTtlSeconds * 1000).toISOString();

      return { url: result.url, headers: result.headers, expiresAt };
    },

    async completePart(uploadSessionId: string, partNumber: number, etag: string, size: number, ctx: FileProviderContext): Promise<void> {
      const session = await db.findOne<UploadSession>({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        namespace,
      });

      if (!session) throw errors.sessionNotFound();
      if (session.status === 'aborted') throw errors.uploadAborted();
      if (session.status === 'completed') throw errors.uploadAlreadyCompleted();
      if (new Date(session.expiresAt) < new Date()) throw errors.uploadExpired();
      if (partNumber < 1 || partNumber > session.totalParts) throw errors.invalidPartNumber();
      if (!etag || etag.trim() === '') throw errors.invalidEtag();

      await db.upsert({
        model: 'uploadParts',
        where: [
          { field: 'uploadSessionId', operator: 'eq', value: uploadSessionId },
          { field: 'partNumber', operator: 'eq', value: partNumber },
        ],
        create: { uploadSessionId, partNumber, etag, size, checksumSha256Base64: null },
        update: { etag, size },
        namespace,
      });

      // Update status to in_progress if still pending
      if (session.status === 'pending') {
        await db.update({
          model: 'uploadSessions',
          where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
          data: { status: 'in_progress' },
          namespace,
        });
      }

      events.emit('part.recorded', createPartRecordedEvent({ uploadSessionId, partNumber, size }, ctx.requestId));
    },

    async completeSession(uploadSessionId: string, ctx: FileProviderContext): Promise<{ fileId: string; versionId: string }> {
      const session = await db.findOne<UploadSession>({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        namespace,
      });

      if (!session) throw errors.sessionNotFound();
      if (session.status === 'aborted') throw errors.uploadAborted();
      if (session.status === 'completed') {
        // Idempotent: return existing result
        const file = await db.findOne<{ fileId: string; currentVersionId: string }>({
          model: 'files',
          where: [{ field: 'fileId', operator: 'eq', value: session.fileId! }],
          namespace,
        });
        if (file) return { fileId: file.fileId, versionId: file.currentVersionId };
        throw errors.uploadAlreadyCompleted();
      }
      if (new Date(session.expiresAt) < new Date()) throw errors.uploadExpired();

      const parts = await db.findMany<{ partNumber: number; etag: string }>({
        model: 'uploadParts',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        namespace,
      });

      if (parts.length !== session.totalParts) {
        throw errors.uploadIncomplete();
      }

      // Re-check quota
      if (quota) {
        const quotaResult = await quota.checkQuota({
          principalId: ctx.principalId,
          tenantId: ctx.tenantId,
          requestedBytes: session.size,
        });
        if (!quotaResult.allowed) {
          throw errors.quotaExceeded(quotaResult.current, quotaResult.limit, session.size);
        }
      }

      // Complete multipart upload
      if (storage.capabilities.multipart && storage.completeMultipartUpload && session.storageUploadId) {
        await storage.completeMultipartUpload({
          key: session.storageKey,
          uploadId: session.storageUploadId,
          parts: parts.sort((a, b) => a.partNumber - b.partNumber).map(p => ({ partNumber: p.partNumber, etag: p.etag })),
        });
      }

      const now = new Date().toISOString();
      const fileId = session.fileId || `file_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const versionId = `ver_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const policy = policies.get(session.policy);

      // Create or update file
      const existingFile = session.fileId ? await db.findOne({ model: 'files', where: [{ field: 'fileId', operator: 'eq', value: session.fileId }], namespace }) : null;

      if (existingFile) {
        await db.update({
          model: 'files',
          where: [{ field: 'fileId', operator: 'eq', value: fileId }],
          data: { currentVersionId: versionId, size: session.size, mimeType: session.mimeType, updatedAt: now },
          namespace,
        });
      } else {
        await db.create({
          model: 'files',
          data: {
            fileId,
            currentVersionId: versionId,
            ownerId: session.ownerId,
            tenantId: session.tenantId,
            visibility: policy?.visibility || 'private',
            policy: session.policy,
            mimeType: session.mimeType,
            size: session.size,
            name: session.fileName,
            metadata: {},
            createdAt: now,
            updatedAt: now,
          },
          namespace,
        });
      }

      // Create version
      await db.create({
        model: 'fileVersions',
        data: {
          versionId,
          fileId,
          storageKey: session.storageKey,
          mimeType: session.mimeType,
          size: session.size,
          checksumSha256Base64: null,
          createdAt: now,
        },
        namespace,
      });

      // Update session
      await db.update({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        data: { status: 'completed', fileId },
        namespace,
      });

      // Record quota usage
      if (quota) {
        await quota.recordUsage({ principalId: ctx.principalId, tenantId: ctx.tenantId, bytes: session.size });
      }

      events.emit('file.uploaded', createFileUploadedEvent({
        fileId,
        versionId,
        fileName: session.fileName,
        size: session.size,
        mimeType: session.mimeType,
        ownerId: session.ownerId,
        tenantId: session.tenantId || undefined,
      }, ctx.requestId));

      return { fileId, versionId };
    },

    async abortSession(uploadSessionId: string, ctx: FileProviderContext): Promise<void> {
      void ctx;
      const session = await db.findOne<UploadSession>({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        namespace,
      });

      if (!session) throw errors.sessionNotFound();
      if (session.status === 'completed') throw errors.uploadAlreadyCompleted();

      // Abort multipart upload
      if (storage.capabilities.multipart && storage.abortMultipartUpload && session.storageUploadId) {
        try {
          await storage.abortMultipartUpload({ key: session.storageKey, uploadId: session.storageUploadId });
        } catch {
          // Ignore abort errors (may already be aborted)
        }
      }

      await db.update({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        data: { status: 'aborted' },
        namespace,
      });
    },
  };
}

export type UploadSessionService = ReturnType<typeof createUploadSessionService>;

import type { Adapter } from '@superfunctions/db';
import { getStorageCapabilities, type StorageAdapter } from '@superfunctions/storage';
import type { FileProviderContext } from '@superfunctions/files';
import {
  matchesContentType,
  resolveStorageTarget,
  type Policy,
  type PolicyRegistry,
} from '../policies.js';
import type { FileFnEventEmitter } from '../events.js';
import type { Logger } from '../observability/logger.js';
import type { DeduplicationService } from '../dedup/service.js';
import type { ProcessingService } from '../processing/service.js';
import * as errors from '../errors.js';
import { createHash, randomBytes } from 'crypto';
import { generateFileFnId } from '../ids.js';
import { parseClientFileId } from './file-id.js';
import { createFileClaims, isFileClaimRecord, updateAndVerify, type FileClaimRecord } from './file-claims.js';
import { proxyPartKey, proxyPartKeys } from './part-keys.js';
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
  getUsage?(principalId?: string, tenantId?: string): Promise<{ current: number; limit: number }>;
}

export interface FileWriteAuthChecker {
  canWriteFile(fileId: string, ctx: FileProviderContext): Promise<boolean>;
}

export interface UploadSessionServiceConfig {
  db: Adapter;
  storage: StorageAdapter;
  policies: PolicyRegistry;
  events: FileFnEventEmitter;
  logger?: Logger;
  quota?: QuotaProvider;
  dedup?: DeduplicationService;
  fileWriteChecker?: FileWriteAuthChecker;
  processingService?: ProcessingService;
  namespace?: string;
  defaultChunkSizeBytes?: number;
  uploadSessionTtlSeconds?: number;
  signedUrlTtlSeconds?: number;
  /** Lease on a file's completion claim; renewed before the version is recorded. Default 900. */
  fileClaimTtlSeconds?: number;
  /** How long a completion waits for another completion of the same file. Default 2000. */
  fileClaimWaitMs?: number;
  generateId?: () => string;
}

export interface CreateSessionInput {
  policy: string;
  fileName: string;
  size: number;
  mimeType: string;
  /**
   * Client-chosen file ID (`file_[A-Za-z0-9_-]{8,64}`). A new ID creates the
   * file owned by the caller when the session completes, if no other session
   * completed under it first; an existing ID replaces the file and needs write
   * permission on it, checked at init and again at completion. Omit to let
   * the server generate one.
   */
  fileId?: string | null;
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
  metadata?: Record<string, unknown> | null;
  expiresAt: string;
  createdAt: string;
  idempotencyKey?: string | null;
  idempotencyPayloadHash?: string | null;
  completionVersionId?: string | null;
  uploadSessionToken?: string | null;
  uploadSessionTokenHash?: string | null;
}

interface FileOwnerRecord {
  fileId: string;
  ownerId: string;
  tenantId?: string | null;
  currentVersionId: string;
}

function generateDefaultId(): string {
  return generateFileFnId('upl');
}

function hashPayload(input: CreateSessionInput, ctx: { principalId?: string; tenantId?: string }): string {
  const payload = {
    p: input.policy,
    fn: input.fileName,
    s: input.size,
    mt: input.mimeType,
    fid: input.fileId,
    md: input.metadata,
    pr: ctx.principalId,
    tn: ctx.tenantId
  };
  const str = JSON.stringify(payload);
  return createHash('sha256').update(str).digest('hex');
}

function isAnonymousContext(ctx: FileProviderContext): boolean {
  return !ctx.principalId || ctx.principalId === 'anonymous';
}

function isAnonymousSession(session: UploadSession): boolean {
  return session.ownerId === 'anonymous';
}

function generateUploadSessionToken(): string {
  return `upls_live_${randomBytes(18).toString('base64url')}`;
}

function hashUploadSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isExpiredAt(expiresAt: string): boolean {
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    return true;
  }
  return expiresAtMs <= Date.now();
}

async function forEachBodyChunk(
  body: ReadableStream | Blob | Buffer,
  onChunk: (chunk: Uint8Array) => Promise<void> | void
): Promise<void> {
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      await onChunk(chunk);
    }
    return;
  }

  if (body instanceof Blob) {
    await onChunk(new Uint8Array(await body.arrayBuffer()));
    return;
  }

  if (Buffer.isBuffer(body)) {
    await onChunk(body);
    return;
  }

  throw new Error('Unsupported body type for proxy upload');
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
    logger,
    quota,
    dedup,
    fileWriteChecker,
    processingService,
    namespace = 'filefn',
    defaultChunkSizeBytes = 8 * 1024 * 1024, // 8 MiB
    uploadSessionTtlSeconds = 86400, // 24h
    signedUrlTtlSeconds = 900, // 15m
    fileClaimTtlSeconds = 900, // 15m
    fileClaimWaitMs = 2000,
    generateId = generateDefaultId,
  } = config;

  const fileClaims = createFileClaims({ db, namespace, ttlSeconds: fileClaimTtlSeconds, waitMs: fileClaimWaitMs });

  /** Loads an upload session; a file claim record is not one. */
  async function findSession(uploadSessionId: string): Promise<UploadSession | null> {
    const session = await db.findOne<UploadSession>({
      model: 'uploadSessions',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
      namespace,
    });
    return session && !isFileClaimRecord(session) ? session : null;
  }

  function selectUploadMode(storageTarget: string): string {
    const capabilities = getStorageCapabilities(storage, storageTarget);
    if (capabilities.signedUploadUrls && capabilities.multipart) {
      return 'multipart-signed-url';
    }
    if (capabilities.proxyStreamingUpload) {
      return 'proxy';
    }
    throw errors.noSupportedUploadMode();
  }

  function computeTotalParts(size: number, chunkSize: number): number {
    return Math.ceil(size / chunkSize);
  }

  async function deleteProxyTempPartObjects(session: UploadSession): Promise<void> {
    if (session.uploadMode !== 'proxy' || !storage.deleteObject) {
      return;
    }
    const policy = policies.get(session.policy);
    const storageTarget = policy ? resolveStorageTarget(policy) : undefined;

    const parts = await db.findMany<{ partNumber: number }>({
      model: 'uploadParts',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId }],
      select: ['partNumber'],
      namespace,
    });

    for (const part of parts) {
      for (const key of proxyPartKeys(session.storageKey, session.uploadSessionId, part.partNumber)) {
        try {
          await storage.deleteObject({ key, target: storageTarget });
        } catch {
          // Best-effort cleanup.
        }
      }
    }
  }

  async function findFileRecord(fileId: string): Promise<FileOwnerRecord | null> {
    return db.findOne<FileOwnerRecord>({
      model: 'files',
      where: [{ field: 'fileId', operator: 'eq', value: fileId }],
      namespace,
    });
  }

  /**
   * Whether the caller may turn its session into a new version of an existing
   * file. Uses the configured checker against the row as it is now; without
   * one, only the same named owner in the same tenant may.
   */
  async function canReplaceFile(
    file: FileOwnerRecord,
    session: UploadSession,
    ctx: FileProviderContext
  ): Promise<boolean> {
    if (fileWriteChecker) {
      return fileWriteChecker.canWriteFile(file.fileId, ctx);
    }
    return (
      !isAnonymousSession(session) &&
      file.ownerId === session.ownerId &&
      (file.tenantId ?? null) === (session.tenantId ?? null)
    );
  }

  async function assertCanReplaceFile(
    file: FileOwnerRecord,
    session: UploadSession,
    ctx: FileProviderContext
  ): Promise<void> {
    if (!(await canReplaceFile(file, session, ctx))) {
      throw errors.forbidden({ fileId: file.fileId, operation: 'replace' });
    }
  }

  function sameFileState(a: FileOwnerRecord, b: FileOwnerRecord | null): boolean {
    return (
      b !== null &&
      a.ownerId === b.ownerId &&
      (a.tenantId ?? null) === (b.tenantId ?? null) &&
      a.currentVersionId === b.currentVersionId
    );
  }

  /**
   * Points `fileId` at the version this completion recorded, under the file's
   * claim. `authorized` is the row (or its absence) the caller was authorized
   * against before publishing. The write is conditional on the row it read:
   * a new file is inserted, an existing one is updated only while its owner and
   * current version are still the ones read. If the row changed (only a file
   * deletion or an out-of-band edit can change it while the claim is held),
   * the caller is authorized again against the row as it is now: a principal
   * that may not write it gets 403 and the file is left as it is.
   */
  async function commitFileRecord(
    fileRow: Record<string, unknown> & { fileId: string; currentVersionId: string },
    authorized: FileOwnerRecord | null,
    session: UploadSession,
    ctx: FileProviderContext
  ): Promise<void> {
    const { fileId, currentVersionId: versionId } = fileRow;
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await findFileRecord(fileId);
      if (!current) {
        try {
          await db.create({ model: 'files', data: fileRow, namespace });
          return;
        } catch (createError) {
          if (await findFileRecord(fileId)) continue;
          throw createError;
        }
      }
      if (!sameFileState(current, authorized)) {
        await assertCanReplaceFile(current, session, ctx);
      }
      const applied = await updateAndVerify<FileOwnerRecord>(
        db,
        {
          model: 'files',
          where: [
            { field: 'fileId', operator: 'eq', value: fileId },
            { field: 'ownerId', operator: 'eq', value: current.ownerId },
            { field: 'currentVersionId', operator: 'eq', value: current.currentVersionId },
          ],
          key: [{ field: 'fileId', operator: 'eq', value: fileId }],
          data: {
            currentVersionId: versionId,
            size: fileRow.size,
            mimeType: fileRow.mimeType,
            metadata: fileRow.metadata,
            updatedAt: fileRow.updatedAt,
          },
          namespace,
        },
        (row) => row.currentVersionId === versionId,
        (row) => sameFileState(current, row),
      );
      if (applied) return;
      authorized = null;
    }
    throw errors.fileBusy(fileId);
  }

  async function openProxyPart(session: UploadSession, partNumber: number, target: string | undefined) {
    const [key, legacyKey] = proxyPartKeys(session.storageKey, session.uploadSessionId, partNumber);
    try {
      return await storage.openDownloadStream!({ key, target });
    } catch (error) {
      // Parts recorded before part keys were scoped to their session.
      try {
        return await storage.openDownloadStream!({ key: legacyKey, target });
      } catch {
        throw error;
      }
    }
  }

  /**
   * Stores the session's bytes at its storage key (completes the multipart
   * upload, or stitches proxy parts), checks the size and applies dedup.
   * Returns the key the version should reference.
   */
  async function publishSessionObject(
    session: UploadSession,
    parts: Array<{ partNumber: number; etag: string }>,
    target: string | undefined
  ): Promise<{ storageKey: string; checksumSha256Base64: string | null }> {
    const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    if (
      session.uploadMode === 'multipart-signed-url' &&
      getStorageCapabilities(storage, target).multipart &&
      storage.completeMultipartUpload &&
      session.storageUploadId
    ) {
      await storage.completeMultipartUpload({
        key: session.storageKey,
        target,
        uploadId: session.storageUploadId,
        parts: sortedParts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
      });
    } else if (session.uploadMode === 'proxy') {
      if (!storage.openUploadStream || !storage.openDownloadStream) {
        throw new Error('Storage adapter does not support streaming required for proxy upload completion');
      }

      const writeStream = await storage.openUploadStream({
        key: session.storageKey,
        target,
        contentType: session.mimeType,
      });
      const writer = writeStream.getWriter();
      try {
        for (const part of sortedParts) {
          const reader = (await openProxyPart(session, part.partNumber, target)).getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              await writer.write(value);
            }
          } finally {
            reader.releaseLock();
          }
        }
      } finally {
        await writer.close();
      }

      await deleteProxyTempPartObjects(session);
    }

    // Validate size if supported
    if (storage.statObject) {
      try {
        const stat = await storage.statObject({ key: session.storageKey, target });
        if (stat.size !== session.size) {
          throw errors.uploadSizeMismatch(session.size, stat.size);
        }
      } catch (err) {
        if (err instanceof errors.FileFnError) throw err;
        // Ignore stat errors if object doesn't exist (should exist though)
      }
    }

    if (!dedup || !dedup.isEnabled()) {
      return { storageKey: session.storageKey, checksumSha256Base64: null };
    }
    const dedupResult = await dedup.computeAndCheckDuplicate(session.storageKey, session.tenantId, target ?? null, storage);
    if (!dedupResult.isDuplicate || !dedupResult.existingStorageKey) {
      return { storageKey: session.storageKey, checksumSha256Base64: dedupResult.checksumSha256Base64 };
    }
    // Reuse the existing object and drop the one just stored.
    if (storage.deleteObject && dedupResult.existingStorageKey !== session.storageKey) {
      try {
        await storage.deleteObject({ key: session.storageKey, target });
      } catch {
        // Ignore deletion errors - storage cleanup is non-critical
      }
    }
    return { storageKey: dedupResult.existingStorageKey, checksumSha256Base64: dedupResult.checksumSha256Base64 };
  }

  async function deleteVersionRecord(fileId: string, versionId: string): Promise<void> {
    try {
      await db.delete({
        model: 'fileVersions',
        where: [
          { field: 'versionId', operator: 'eq', value: versionId },
          { field: 'fileId', operator: 'eq', value: fileId },
        ],
        namespace,
      });
    } catch {
      // Best-effort: a version no file points at is unreachable.
    }
  }

  return {
    assertSessionAccess(session: UploadSession, ctx: FileProviderContext, uploadSessionToken?: string): void {
      // Legacy safety: pre-binding records may not carry ownerId.
      // Current sessions always persist ownerId, so this only preserves older fixtures.
      if (!session.ownerId) {
        return;
      }

      if (!isAnonymousSession(session)) {
        if (!ctx.principalId || ctx.principalId !== session.ownerId) {
          throw errors.forbidden();
        }

        const sessionTenant = session.tenantId ?? null;
        const callerTenant = ctx.tenantId ?? null;
        if (sessionTenant !== callerTenant) {
          throw errors.forbidden();
        }

        return;
      }

      if (!uploadSessionToken) {
        throw errors.sessionTokenRequired();
      }

      if (!session.uploadSessionTokenHash) {
        throw errors.sessionTokenRequired();
      }

      if (hashUploadSessionToken(uploadSessionToken) !== session.uploadSessionTokenHash) {
        throw errors.sessionTokenInvalid();
      }
    },

    async createSession(input: CreateSessionInput, ctx: FileProviderContext): Promise<{
      uploadSessionId: string;
      uploadMode: string;
      chunkSizeBytes: number;
      totalParts: number;
      expiresAt: string;
      warnings: string[];
      uploadSessionToken?: string;
    }> {
      const warnings: string[] = [];
      const clientFileId = parseClientFileId(input.fileId);

      // Check idempotency
      if (input.idempotencyKey) {
        const existing = await db.findOne<UploadSession>({
          model: 'uploadSessions',
          where: [{ field: 'idempotencyKey', operator: 'eq', value: input.idempotencyKey }],
          namespace,
        });

        if (existing) {
          const expectedHash = hashPayload(input, { principalId: ctx.principalId, tenantId: ctx.tenantId });
          if (existing.idempotencyPayloadHash !== expectedHash) {
            throw errors.idempotencyConflict();
          }

          let uploadSessionToken: string | undefined;
          if (isAnonymousSession(existing)) {
            if (existing.uploadSessionToken) {
              uploadSessionToken = existing.uploadSessionToken;
            } else {
              // Older sessions may only have the hash persisted. Preserve access by
              // minting and persisting a replacement token once, then replay it
              // deterministically for future idempotent responses.
              uploadSessionToken = generateUploadSessionToken();
              await db.update({
                model: 'uploadSessions',
                where: [{ field: 'uploadSessionId', operator: 'eq', value: existing.uploadSessionId }],
                data: {
                  uploadSessionToken,
                  uploadSessionTokenHash: hashUploadSessionToken(uploadSessionToken),
                },
                namespace,
              });
            }
          }

          return {
            uploadSessionId: existing.uploadSessionId,
            uploadMode: existing.uploadMode,
            chunkSizeBytes: existing.chunkSizeBytes,
            totalParts: existing.totalParts,
            expiresAt: existing.expiresAt,
            warnings: [],
            uploadSessionToken,
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
        if (!policy.contentTypes.some((pattern) => matchesContentType(pattern, input.mimeType))) {
          throw errors.policyContentTypeNotAllowed(input.policy, input.mimeType);
        }
      }

      if (policy.maxSizeBytes !== undefined && input.size > policy.maxSizeBytes) {
        throw errors.policyMaxSizeExceeded(input.policy, policy.maxSizeBytes, input.size);
      }

      // A client-chosen ID that already names a file replaces it, which needs
      // write permission. A new ID is not reserved here: the first session to
      // complete creates the file, and completion authorizes every later one
      // against it (see completeSession).
      if (clientFileId && fileWriteChecker) {
        const canWrite = await fileWriteChecker.canWriteFile(clientFileId, ctx);
        if (!canWrite) {
          throw errors.forbidden({ fileId: clientFileId, operation: 'replace' });
        }
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

      const storageTarget = resolveStorageTarget(policy);
      const uploadMode = selectUploadMode(storageTarget);
      const chunkSizeBytes = defaultChunkSizeBytes;
      const totalParts = computeTotalParts(input.size, chunkSizeBytes);
      const uploadSessionId = generateId();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + uploadSessionTtlSeconds * 1000).toISOString();
      const fileId = clientFileId ?? generateFileFnId('file');
      const versionId = generateFileFnId('ver');

      const storageKey = computeStorageKey(policy, {
        fileName: input.fileName,
        principalId: ctx.principalId,
        tenantId: ctx.tenantId,
        fileId,
        versionId,
      });

      let storageUploadId: string | null = null;
      let uploadSessionToken: string | undefined;
      let uploadSessionTokenHash: string | null = null;

      if (isAnonymousContext(ctx)) {
        uploadSessionToken = generateUploadSessionToken();
        uploadSessionTokenHash = hashUploadSessionToken(uploadSessionToken);
      }

      // Create multipart upload only for multipart mode.
      if (uploadMode === 'multipart-signed-url' && storage.createMultipartUpload) {
        const result = await storage.createMultipartUpload({
          key: storageKey,
          target: storageTarget,
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
          fileId,
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
          metadata: input.metadata ?? {},
          idempotencyKey: input.idempotencyKey || null,
          idempotencyPayloadHash: input.idempotencyKey ? hashPayload(input, { principalId: ctx.principalId, tenantId: ctx.tenantId }) : null,
          uploadSessionToken: uploadSessionToken || null,
          uploadSessionTokenHash,
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

      logger?.info('Upload session created', {
        uploadSessionId,
        requestId: ctx.requestId,
        fileName: input.fileName,
        size: input.size,
        uploadMode,
        fileId,
      });

      return { uploadSessionId, uploadMode, chunkSizeBytes, totalParts, expiresAt, warnings, uploadSessionToken };
    },

    async getSessionStatus(uploadSessionId: string, ctx: FileProviderContext, uploadSessionToken?: string): Promise<{
      uploadSessionId: string;
      fileId?: string;
      status: string;
      totalParts: number;
      recordedParts: number[];
      uploadedParts: number[];
      chunkSizeBytes: number;
      fileSize: number;
      expiresAt: string;
    }> {
      const session = await findSession(uploadSessionId);

      if (!session) {
        throw errors.sessionNotFound();
      }

      this.assertSessionAccess(session, ctx, uploadSessionToken);

      const parts = await db.findMany<{ partNumber: number }>({
        model: 'uploadParts',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        select: ['partNumber'],
        namespace,
      });

      const recordedParts = parts.map(p => p.partNumber).sort((a, b) => a - b);

      return {
        uploadSessionId,
        fileId: session.fileId ?? undefined,
        status: session.status,
        totalParts: session.totalParts,
        recordedParts,
        uploadedParts: recordedParts,
        chunkSizeBytes: session.chunkSizeBytes,
        fileSize: session.size,
        expiresAt: session.expiresAt,
      };
    },

    async signPart(uploadSessionId: string, partNumber: number, contentLength: number, ctx: FileProviderContext, uploadSessionToken?: string): Promise<{
      url: string;
      headers?: Record<string, string>;
      expiresAt: string;
    }> {
      const session = await findSession(uploadSessionId);

      if (!session) throw errors.sessionNotFound();
      this.assertSessionAccess(session, ctx, uploadSessionToken);
      if (session.status === 'aborted') throw errors.uploadAborted();
      if (session.status === 'completed') throw errors.uploadAlreadyCompleted();
      if (isExpiredAt(session.expiresAt)) throw errors.uploadExpired();
      if (partNumber < 1 || partNumber > session.totalParts) throw errors.invalidPartNumber();

      if (session.uploadMode === 'proxy') {
        // Return URL to the proxy PUT endpoint
        // The client will PUT to this URL
        // We assume the router is mounted at root or handled correctly by client
        // Returning a relative path that the client SDK resolves against baseUrl
        return {
          url: `/upload/${uploadSessionId}/parts/${partNumber}`,
          headers: {
            'content-type': session.mimeType === 'application/octet-stream' ? 'application/octet-stream' : session.mimeType
          },
          expiresAt: session.expiresAt
        };
      }

      if (!storage.signMultipartUploadPartUrl) {
        throw errors.noSupportedUploadMode();
      }

      const result = await storage.signMultipartUploadPartUrl({
        key: session.storageKey,
        target: policies.get(session.policy) ? resolveStorageTarget(policies.get(session.policy)!) : undefined,
        uploadId: session.storageUploadId!,
        partNumber,
        expiresInSeconds: signedUrlTtlSeconds,
        constraints: { contentLength },
      });

      const expiresAt = new Date(Date.now() + signedUrlTtlSeconds * 1000).toISOString();

      logger?.info('Upload part signed', {
        uploadSessionId,
        partNumber,
        requestId: ctx.requestId,
      });

      return { url: result.url, headers: result.headers, expiresAt };
    },

    async uploadPartBytes(uploadSessionId: string, partNumber: number, body: ReadableStream | Blob | Buffer, contentLength: number, ctx: FileProviderContext, uploadSessionToken?: string): Promise<{ etag: string; size: number }> {
      void contentLength;
      const session = await findSession(uploadSessionId);

      if (!session) throw errors.sessionNotFound();
      this.assertSessionAccess(session, ctx, uploadSessionToken);
      if (session.status === 'aborted') throw errors.uploadAborted();
      if (session.status === 'completed') throw errors.uploadAlreadyCompleted();
      if (isExpiredAt(session.expiresAt)) throw errors.uploadExpired();
      if (partNumber < 1 || partNumber > session.totalParts) throw errors.invalidPartNumber();
      if (session.uploadMode !== 'proxy') throw errors.noSupportedUploadMode();

      const existingPart = await db.findOne<{ etag: string; size: number }>({
        model: 'uploadParts',
        where: [
          { field: 'uploadSessionId', operator: 'eq', value: uploadSessionId },
          { field: 'partNumber', operator: 'eq', value: partNumber },
        ],
        namespace,
      });

      if (existingPart) {
        const hasher = createHash('sha256');
        let incomingSize = 0;
        await forEachBodyChunk(body, (chunk) => {
          hasher.update(chunk);
          incomingSize += chunk.byteLength;
        });

        const incomingEtag = `proxy-sha256-${hasher.digest('hex')}`;
        if (existingPart.etag === incomingEtag && existingPart.size === incomingSize) {
          return { etag: incomingEtag, size: incomingSize };
        }

        throw errors.partConflict(uploadSessionId, partNumber);
      }

      const partKey = proxyPartKey(session.storageKey, uploadSessionId, partNumber);
      const storageTarget = policies.get(session.policy) ? resolveStorageTarget(policies.get(session.policy)!) : undefined;

      if (!storage.openUploadStream) {
        throw new Error('Storage adapter does not support streaming upload required for proxy mode');
      }

      const writeStream = await storage.openUploadStream({
        key: partKey,
        target: storageTarget,
        contentType: session.mimeType
      });

      const hasher = createHash('sha256');
      let size = 0;
      const writer = writeStream.getWriter();
      try {
        await forEachBodyChunk(body, async (chunk) => {
          hasher.update(chunk);
          size += chunk.byteLength;
          await writer.write(chunk);
        });
      } finally {
        await writer.close();
      }

      const etag = `proxy-sha256-${hasher.digest('hex')}`;

      await db.create({
        model: 'uploadParts',
        data: { uploadSessionId, partNumber, etag, size, checksumSha256Base64: null },
        namespace,
      });

      if (session.status === 'pending') {
        await db.update({
          model: 'uploadSessions',
          where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
          data: { status: 'in_progress' },
          namespace,
        });
      }

      events.emit('part.recorded', createPartRecordedEvent({ uploadSessionId, partNumber, size }, ctx.requestId));
      return { etag, size };
    },

    async completePart(uploadSessionId: string, partNumber: number, etag: string, size: number, ctx: FileProviderContext, uploadSessionToken?: string): Promise<void> {
      const session = await findSession(uploadSessionId);

      if (!session) throw errors.sessionNotFound();
      this.assertSessionAccess(session, ctx, uploadSessionToken);
      if (session.status === 'aborted') throw errors.uploadAborted();
      if (session.status === 'completed') throw errors.uploadAlreadyCompleted();
      if (isExpiredAt(session.expiresAt)) throw errors.uploadExpired();
      if (partNumber < 1 || partNumber > session.totalParts) throw errors.invalidPartNumber();
      if (!etag || etag.trim() === '') throw errors.invalidEtag();

      const existingPart = await db.findOne<{ partNumber: number; etag: string; size: number }>({
        model: 'uploadParts',
        where: [
          { field: 'uploadSessionId', operator: 'eq', value: uploadSessionId },
          { field: 'partNumber', operator: 'eq', value: partNumber },
        ],
        namespace,
      });

      if (existingPart) {
        if (existingPart.etag === etag && existingPart.size === size) return; // Idempotent success
        throw errors.partConflict(uploadSessionId, partNumber);
      }

      await db.create({
        model: 'uploadParts',
        data: { uploadSessionId, partNumber, etag, size, checksumSha256Base64: null },
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

    async completeSession(uploadSessionId: string, ctx: FileProviderContext, uploadSessionToken?: string): Promise<{ fileId: string; versionId: string }> {
      const session = await findSession(uploadSessionId);

      if (!session) throw errors.sessionNotFound();
      this.assertSessionAccess(session, ctx, uploadSessionToken);
      if (session.status === 'aborted') throw errors.uploadAborted();
      if (session.status === 'completed') {
        // Idempotent: return existing result
        if (session.fileId && session.completionVersionId) {
          return { fileId: session.fileId, versionId: session.completionVersionId };
        }
        // Fallback for legacy sessions or partial failures (should not happen with transaction, but we assume eventual consistency here)
        const file = await db.findOne<{ fileId: string; currentVersionId: string }>({
          model: 'files',
          where: [{ field: 'fileId', operator: 'eq', value: session.fileId! }],
          namespace,
        });
        if (file) return { fileId: file.fileId, versionId: file.currentVersionId };
        throw errors.uploadAlreadyCompleted();
      }
      if (isExpiredAt(session.expiresAt)) throw errors.uploadExpired();

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

      const policy = policies.get(session.policy);
      const policyStorageTarget = policy ? resolveStorageTarget(policy) : undefined;
      const now = new Date().toISOString();
      const fileId = session.fileId || generateFileFnId('file');
      const metadata = session.metadata ?? {};

      // Hold the file's claim while deciding who owns it, publishing and
      // recording the version, so a caller that may not write the file never
      // stores bytes (a custom storagePath can give every session of a file the
      // same key) and no files row exists before its version does.
      let versionId = generateFileFnId('ver');
      const claimToken = versionId;
      const claim = await fileClaims.acquire(fileId, {
        uploadSessionId,
        ownerId: session.ownerId,
        tenantId: session.tenantId,
        policy: session.policy,
        mimeType: session.mimeType,
      }, claimToken);

      let finalStorageKey = session.storageKey;
      let versionRecorded = false;
      let fileCommitted = false;
      try {
        if (claim.recovered?.uploadSessionId === uploadSessionId) {
          // An earlier attempt of this session committed the file and was
          // interrupted before recording its session; recovery recorded it.
          versionId = claim.recovered.versionId;
          const version = await db.findOne<{ storageKey: string }>({
            model: 'fileVersions',
            where: [{ field: 'versionId', operator: 'eq', value: versionId }],
            namespace,
          });
          finalStorageKey = version?.storageKey ?? finalStorageKey;
          fileCommitted = true;
        } else {
          // Another request for this session may have finished or aborted it
          // while this one waited for the claim.
          const latest = await findSession(uploadSessionId);
          if (latest?.status === 'aborted') throw errors.uploadAborted();
          if (latest?.status === 'completed' && latest.completionVersionId) {
            await fileClaims.release(fileId, claimToken);
            return { fileId: latest.fileId ?? fileId, versionId: latest.completionVersionId };
          }

          const authorized = await findFileRecord(fileId);
          if (authorized) await assertCanReplaceFile(authorized, session, ctx);

          const published = await publishSessionObject(session, parts, policyStorageTarget);
          finalStorageKey = published.storageKey;

          if (!(await fileClaims.renew(fileId, claimToken))) {
            throw errors.fileBusy(fileId);
          }

          await db.create({
            model: 'fileVersions',
            data: {
              versionId,
              fileId,
              storageKey: finalStorageKey,
              mimeType: session.mimeType,
              size: session.size,
              checksumSha256Base64: published.checksumSha256Base64,
              tenantId: session.tenantId,
              createdAt: now,
            },
            namespace,
          });
          versionRecorded = true;

          await commitFileRecord({
            fileId,
            currentVersionId: versionId,
            ownerId: session.ownerId,
            tenantId: session.tenantId,
            visibility: policy?.visibility || 'private',
            policy: session.policy,
            mimeType: session.mimeType,
            size: session.size,
            name: session.fileName,
            metadata,
            createdAt: now,
            updatedAt: now,
          }, authorized, session, ctx);
          fileCommitted = true;
        }

        await db.update({
          model: 'uploadSessions',
          where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
          data: { status: 'completed', fileId, completionVersionId: versionId },
          namespace,
        });
      } catch (completionError) {
        // Before the file points at the version, undo it and free the file. After,
        // keep the claim: when it expires, recovery records this session.
        if (!fileCommitted) {
          if (versionRecorded) await deleteVersionRecord(fileId, versionId);
          await fileClaims.release(fileId, claimToken);
        }
        throw completionError;
      }
      await fileClaims.release(fileId, claimToken);

      await db.deleteMany({
        model: 'uploadParts',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        namespace,
      });

      // Record quota usage
      if (quota) {
        await quota.recordUsage({ principalId: ctx.principalId, tenantId: ctx.tenantId, bytes: session.size });
      }

      events.emit('file:uploaded', createFileUploadedEvent({
        fileId,
        versionId,
        fileName: session.fileName,
        size: session.size,
        mimeType: session.mimeType,
        ownerId: session.ownerId,
        tenantId: session.tenantId || undefined,
      }, ctx.requestId));

      logger?.info('Upload session completed', {
        uploadSessionId,
        fileId,
        versionId,
        requestId: ctx.requestId,
      });

      if (processingService) {
        await processingService.triggerProcessing({
          fileId,
          versionId,
          storageKey: finalStorageKey,
          mimeType: session.mimeType,
          size: session.size,
          fileName: session.fileName,
          tenantId: session.tenantId || undefined,
        }, ctx);
      }

      return { fileId, versionId };
    },

    async abortSession(uploadSessionId: string, ctx: FileProviderContext, uploadSessionToken?: string): Promise<void> {
      const session = await findSession(uploadSessionId);

      if (!session) throw errors.sessionNotFound();
      this.assertSessionAccess(session, ctx, uploadSessionToken);
      if (session.status === 'completed') throw errors.uploadAlreadyCompleted();

      // Abort multipart upload
      const policy = policies.get(session.policy);
      const storageTarget = policy ? resolveStorageTarget(policy) : undefined;
      if (
        getStorageCapabilities(storage, storageTarget).multipart &&
        storage.abortMultipartUpload &&
        session.storageUploadId
      ) {
        try {
          await storage.abortMultipartUpload({ key: session.storageKey, target: storageTarget, uploadId: session.storageUploadId });
        } catch {
          // Ignore abort errors (may already be aborted)
        }
      }

      await deleteProxyTempPartObjects(session);
      await db.deleteMany({
        model: 'uploadParts',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        namespace,
      });

      await db.update({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        data: { status: 'aborted' },
        namespace,
      });
    },

    async cleanupExpiredSessions(): Promise<{ deletedSessions: number; abortedMultipart: number }> {
        const now = new Date().toISOString();
        const expiredSessions = await db.findMany<UploadSession>({
            model: 'uploadSessions',
            where: [
                { field: 'expiresAt', operator: 'lt', value: now },
                { field: 'status', operator: 'ne', value: 'completed' }
            ],
            namespace
        });

        let deletedSessions = 0;
        let abortedMultipart = 0;

        for (const session of expiredSessions) {
            if (isFileClaimRecord(session)) {
                await fileClaims.cleanupExpired(session as unknown as FileClaimRecord);
                continue;
            }
            const policy = policies.get(session.policy);
            const storageTarget = policy ? resolveStorageTarget(policy) : undefined;
            if (session.storageUploadId && storage.abortMultipartUpload) {
                try {
                    await storage.abortMultipartUpload({
                        key: session.storageKey,
                        target: storageTarget,
                        uploadId: session.storageUploadId
                    });
                    abortedMultipart++;
                } catch {
                    // ignore
                }
            }

            await deleteProxyTempPartObjects(session);
            await db.deleteMany({
                model: 'uploadParts',
                where: [{ field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId }],
                namespace
            });
            
            await db.delete({
                model: 'uploadSessions',
                where: [{ field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId }],
                namespace
            });
            deletedSessions++;
        }

        return { deletedSessions, abortedMultipart };
    }
  };
}

export type UploadSessionService = ReturnType<typeof createUploadSessionService>;

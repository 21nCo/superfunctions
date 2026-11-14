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
import { createFileIdReservations, isFileIdReservation, ownsReservation } from './file-id-reservations.js';
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
  generateId?: () => string;
}

export interface CreateSessionInput {
  policy: string;
  fileName: string;
  size: number;
  mimeType: string;
  /**
   * Client-chosen file ID (`file_[A-Za-z0-9_-]{8,64}`); omit or pass null to
   * let the server generate one. An ID with no file is reserved for a named
   * caller on init (first caller wins; another principal gets 403, the same
   * one may init again). An anonymous caller does not reserve; it gets 403
   * only if a named principal reserved the ID, at init or at completion.
   * An ID with a file replaces it with a new version:
   * init checks write permission with the configured `fileWriteChecker`, and
   * completion checks it again.
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
  tenantId: string | null;
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
    generateId = generateDefaultId,
  } = config;

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

  function proxyPartKey(storageKey: string, partNumber: number): string {
    return `${storageKey}.part${partNumber}`;
  }

  const reservations = createFileIdReservations({ db, namespace });

  /** An upload session by ID; a file ID reservation is not one. */
  async function findSession(uploadSessionId: string): Promise<UploadSession | null> {
    const session = await db.findOne<UploadSession>({
      model: 'uploadSessions',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
      namespace,
    });
    return session && !isFileIdReservation(session) ? session : null;
  }

  async function findFile(fileId: string): Promise<FileOwnerRecord | null> {
    return db.findOne<FileOwnerRecord>({
      model: 'files',
      where: [{ field: 'fileId', operator: 'eq', value: fileId }],
      namespace,
    });
  }

  /**
   * Checks, before any bytes are published, that the session may complete into
   * its file: an existing file needs write permission (the configured
   * checker); a missing one must not be reserved by another principal.
   * Returns whether the file existed.
   */
  async function assertMayCompleteInto(session: UploadSession, ctx: FileProviderContext): Promise<boolean> {
    const fileId = session.fileId!;
    if (await findFile(fileId)) {
      if (fileWriteChecker && !(await fileWriteChecker.canWriteFile(fileId, ctx))) {
        throw errors.forbidden({ fileId, operation: 'replace' });
      }
      return true;
    }
    await assertNotReservedByOther(fileId, session);
    return false;
  }

  /** A session may create a file under an ID only if no other principal reserved it. */
  async function assertNotReservedByOther(fileId: string, session: UploadSession): Promise<void> {
    const reservation = await reservations.find(fileId);
    if (reservation && !ownsReservation(reservation, session)) {
      throw errors.forbidden({ fileId, operation: 'create' });
    }
  }

  /**
   * Checks a file row that appeared after `assertMayCompleteInto` found none
   * (another completion created it): the session may only add a version to it
   * with write permission, or, without a checker, as its named owner. For a
   * reserved ID only its owner can have created it, so this admits the same
   * caller's other session and refuses anyone else.
   */
  async function assertMayWriteAppearedFile(
    file: FileOwnerRecord,
    session: UploadSession,
    ctx: FileProviderContext
  ): Promise<void> {
    const allowed = fileWriteChecker
      ? await fileWriteChecker.canWriteFile(file.fileId, ctx)
      : ownsReservation(file, session);
    if (!allowed) {
      throw errors.forbidden({ fileId: file.fileId, operation: 'replace' });
    }
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
      try {
        await storage.deleteObject({ key: proxyPartKey(session.storageKey, part.partNumber), target: storageTarget });
      } catch {
        // Best-effort cleanup.
      }
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
      // A malformed ID is rejected before anything else, idempotent replay included.
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

      // A client-chosen ID that names a file replaces it, which needs write
      // permission. One with no file is reserved for a named caller: the first
      // caller wins, so another principal gets 403 here and never uploads
      // under it, while the same caller may init again (a retry). An
      // anonymous caller cannot be told apart from another one, so it does
      // not reserve: its ID stays unowned until the upload completes, and it
      // may not use an ID a named principal reserved.
      if (clientFileId) {
        if (await findFile(clientFileId)) {
          if (fileWriteChecker && !(await fileWriteChecker.canWriteFile(clientFileId, ctx))) {
            throw errors.forbidden({ fileId: clientFileId, operation: 'replace' });
          }
        } else {
          const owner = { ownerId: ctx.principalId || 'anonymous', tenantId: ctx.tenantId || null };
          const allowed = owner.ownerId === 'anonymous'
            ? !(await reservations.find(clientFileId))
            : await reservations.reserve(clientFileId, owner, input.policy);
          if (!allowed) {
            throw errors.forbidden({ fileId: clientFileId, operation: 'create' });
          }
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

      const partKey = proxyPartKey(session.storageKey, partNumber);
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

      const fileExistedBeforePublish = session.fileId ? await assertMayCompleteInto(session, ctx) : false;
      const policy = policies.get(session.policy);
      const policyStorageTarget = policy ? resolveStorageTarget(policy) : undefined;

      // Complete multipart upload
      if (
        session.uploadMode === 'multipart-signed-url' &&
        getStorageCapabilities(storage, policyStorageTarget).multipart &&
        storage.completeMultipartUpload &&
        session.storageUploadId
      ) {
        await storage.completeMultipartUpload({
          key: session.storageKey,
          target: policyStorageTarget,
          uploadId: session.storageUploadId,
          parts: parts.sort((a, b) => a.partNumber - b.partNumber).map(p => ({ partNumber: p.partNumber, etag: p.etag })),
        });
      } else if (session.uploadMode === 'proxy') {
        // Stitch proxy parts
        if (!storage.openUploadStream || !storage.openDownloadStream) {
            throw new Error('Storage adapter does not support streaming required for proxy upload completion');
        }

        const sortedParts = parts.sort((a, b) => a.partNumber - b.partNumber);
        const writeStream = await storage.openUploadStream({ 
            key: session.storageKey,
            target: policyStorageTarget,
            contentType: session.mimeType
        });

        const writer = writeStream.getWriter();
        try {
            for (const part of sortedParts) {
                const partKey = proxyPartKey(session.storageKey, part.partNumber);
                const readStream = await storage.openDownloadStream({ key: partKey, target: policyStorageTarget });
                const reader = readStream.getReader();

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

        // Cleanup parts
        for (const part of sortedParts) {
             const partKey = proxyPartKey(session.storageKey, part.partNumber);
             try {
                 await storage.deleteObject({ key: partKey, target: policyStorageTarget });
             } catch {
                 // ignore
             }
        }
      }

      // Validate size if supported
      if (storage.statObject) {
        try {
          const stat = await storage.statObject({ key: session.storageKey, target: policyStorageTarget });
          if (stat.size !== session.size) {
            throw errors.uploadSizeMismatch(session.size, stat.size);
          }
        } catch (err) {
            if (err instanceof errors.FileFnError) throw err;
            // Ignore stat errors if object doesn't exist (should exist though)
        }
      }

      const now = new Date().toISOString();
      const fileId = session.fileId || generateFileFnId('file');
      const versionId = generateFileFnId('ver');
      const metadata = session.metadata ?? {};

      // Check for deduplication
      let finalStorageKey = session.storageKey;
      let checksumSha256Base64: string | null = null;
      let isDeduplicated = false;

      if (dedup && dedup.isEnabled()) {
        const dedupResult = await dedup.computeAndCheckDuplicate(
          session.storageKey,
          session.tenantId,
          policyStorageTarget ?? null,
          storage
        );

        checksumSha256Base64 = dedupResult.checksumSha256Base64;

        if (dedupResult.isDuplicate && dedupResult.existingStorageKey) {
          // Reuse existing storage key (reference to existing object)
          finalStorageKey = dedupResult.existingStorageKey;
          isDeduplicated = true;

          // Delete the newly uploaded file since we're reusing an existing one
          if (storage.deleteObject && finalStorageKey !== session.storageKey) {
            try {
              await storage.deleteObject({ key: session.storageKey, target: policyStorageTarget });
            } catch {
              // Ignore deletion errors - storage cleanup is non-critical
            }
          }
        }
      }

      // Create or update file
      const updateFile = async () => {
        await db.update({
          model: 'files',
          where: [{ field: 'fileId', operator: 'eq', value: fileId }],
          data: {
            currentVersionId: versionId,
            size: session.size,
            mimeType: session.mimeType,
            metadata,
            updatedAt: now,
          },
          namespace,
        });
      };
      const existingFile = session.fileId ? await findFile(session.fileId) : null;

      if (existingFile) {
        if (!fileExistedBeforePublish) {
          // Another completion of this ID created the file after the check
          // above; authorize against the row it created.
          await assertMayWriteAppearedFile(existingFile, session, ctx);
        }
        await updateFile();
      } else {
        if (fileExistedBeforePublish) {
          // The file was deleted while this completion was publishing; it may
          // only be recreated by the ID's owner.
          await assertNotReservedByOther(fileId, session);
        }
        try {
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
              metadata,
              createdAt: now,
              updatedAt: now,
            },
            namespace,
          });
        } catch (createError) {
          // Another completion created it between our read and our insert.
          const created = session.fileId ? await findFile(session.fileId) : null;
          if (!created) throw createError;
          await assertMayWriteAppearedFile(created, session, ctx);
          await updateFile();
        }
      }

      // Create version
      await db.create({
        model: 'fileVersions',
        data: {
          versionId,
          fileId,
          storageKey: finalStorageKey,
          mimeType: session.mimeType,
          size: session.size,
          checksumSha256Base64,
          tenantId: session.tenantId,
          createdAt: now,
        },
        namespace,
      });

      // Update session
      await db.update({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        data: { status: 'completed', fileId, completionVersionId: versionId },
        namespace,
      });

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

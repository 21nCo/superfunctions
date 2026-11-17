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
import { parseRequestedFileId } from './file-id.js';
import { createFileCommitLock, runFileFnSerialized } from '../files/file-commit-lock.js';
import { findReferencedStorageRefs, storageRef } from '../storage-references.js';
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
  /**
   * The database adapter the host passed (before FileFn wraps it). On adapters
   * with unique constraints, in-process completion serialization of a fileId is
   * scoped to it. Defaults to `db`.
   */
  databaseIdentity?: object;
}

export interface CreateSessionInput {
  policy: string;
  fileName: string;
  size: number;
  mimeType: string;
  /**
   * File ID the client chose, matching `file_[A-Za-z0-9_-]{8,64}`. `null` or
   * omitted lets the server generate one. Validated at runtime: the route
   * passes the JSON body through unchanged.
   */
  fileId?: string | null;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface UploadSession {
  uploadSessionId: string;
  // 'refused' is a completion refused at commit or admission whose own objects
  // may still need deleting; clients see it as 'aborted'.
  status: 'pending' | 'in_progress' | 'completed' | 'aborted' | 'refused' | 'expired';
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

// Upload completion serializes, through the process-wide serializer it shares
// with import (see files/file-commit-lock.ts), the calls completing one upload
// session and, per namespace and fileId, the commit decisions (database steps
// only, never storage I/O). On adapters without unique constraints, which are
// single-process, the fileId key is the only guard and is scoped to one store
// (see createFileCommitLock). With unique constraints it is scoped to the
// adapter object. Keys: `session\0...` then `file\0...`, always acquired in that
// order. A call that waits longer than SERIALIZED_WAIT_TIMEOUT_MS for its
// session key fails with the retryable 409 FILEFN_UPLOAD_COMPLETION_IN_PROGRESS
// before changing anything; so does one that waits that long, before its
// storage step, for a commit of its fileId already running. A call waiting for
// its fileId key to commit has already completed its storage upload, which a
// retry could not redo, so it keeps waiting (unless it may take the key, see
// fileKeyEvictableAt); that key is only held for database steps.
const runSerialized = runFileFnSerialized;

function isAbortedStatus(status: string): boolean {
  return status === 'aborted' || status === 'refused';
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
    databaseIdentity = db,
  } = config;

  // The per-fileId commit key. A holder stuck forever (for example a Workers
  // request cancelled when its client disconnected) stops blocking it where an
  // overlap is harmless: on adapters with unique constraints a call that has
  // waited out SERIALIZED_WAIT_TIMEOUT_MS takes the key, and the unique
  // `files.fileId` constraint arbitrates the two as it does calls in two
  // processes. Without unique constraints the key is taken only after the
  // holder's session has expired; a completion still running then is a session
  // expiring during its completion, which FileFn does not guard (FILE-14).
  const fileCommitLock = createFileCommitLock({ db, namespace, databaseIdentity });
  const { uniqueConstraints } = fileCommitLock;
  function fileKeyEvictableAt(expiresAt: string): number | undefined {
    if (uniqueConstraints) return 0;
    const expiresAtMs = Date.parse(expiresAt);
    return Number.isNaN(expiresAtMs) ? undefined : expiresAtMs;
  }
  function fileKeyOptions(session: UploadSession) {
    return {
      evictableAt: fileKeyEvictableAt(session.expiresAt),
      member: session.uploadSessionId,
      sharesKeyWith: fileCommitLock.sharesKeyWith,
    };
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

  function proxyPartKey(storageKey: string, partNumber: number): string {
    return `${storageKey}.part${partNumber}`;
  }

  // Deletes the session's proxy part objects. Returns false if any delete
  // failed; callers that must not lose track of the parts keep the session.
  async function deleteProxyTempPartObjects(session: UploadSession): Promise<boolean> {
    if (session.uploadMode !== 'proxy' || !storage.deleteObject) {
      return true;
    }
    const policy = policies.get(session.policy);
    const storageTarget = policy ? resolveStorageTarget(policy) : undefined;

    const parts = await db.findMany<{ partNumber: number }>({
      model: 'uploadParts',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId }],
      select: ['partNumber'],
      namespace,
    });

    let allDeleted = true;
    for (const part of parts) {
      try {
        await storage.deleteObject({ key: proxyPartKey(session.storageKey, part.partNumber), target: storageTarget });
      } catch {
        allDeleted = false;
      }
    }
    return allDeleted;
  }

  // Without a configured checker the service trusts its caller, as at init.
  async function canWriteFileNow(fileId: string, ctx: FileProviderContext): Promise<boolean> {
    return fileWriteChecker ? fileWriteChecker.canWriteFile(fileId, ctx) : true;
  }

  async function endSessionAborted(uploadSessionId: string): Promise<void> {
    await db.deleteMany({
      model: 'uploadParts',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
      namespace,
    });

    // Conditional: a zero-match write (the session was refused meanwhile) is a
    // no-op, so this uses the count-returning updateMany, never update.
    await db.updateMany({
      model: 'uploadSessions',
      where: [
        { field: 'uploadSessionId', operator: 'eq', value: uploadSessionId },
        { field: 'status', operator: 'ne', value: 'refused' },
      ],
      data: { status: 'aborted' },
      namespace,
    });
  }

  function ownObjectRef(session: UploadSession): string | undefined {
    if (!storage.deleteObject || !session.completionVersionId) {
      return undefined;
    }
    return storageRef(resolveStorageTarget(policies.get(session.policy) ?? {}), session.storageKey);
  }

  // Deletes the session's own final object unless something may still use it:
  // any file version or artifact referencing the same storage target and key
  // keeps it (the session's own published version, or another file's version
  // that dedup pointed at it), and sessions from before per-session keys (no
  // pre-allocated versionId) may share a key. Callers only pass refused
  // sessions, which no completion can publish any more, so nothing can newly
  // reference the object while this runs.
  // Returns false when the delete failed. `referenced` is a reference lookup the
  // caller already ran over this session's own ref (the expiry sweep runs one
  // for all its sessions); without it, this runs its own.
  async function deleteOwnUnpublishedObject(
    session: UploadSession,
    referenced?: ReadonlySet<string>,
  ): Promise<boolean> {
    const ownRef = ownObjectRef(session);
    if (!storage.deleteObject || ownRef === undefined) {
      return true;
    }
    const policy = policies.get(session.policy);
    const storageTarget = policy ? resolveStorageTarget(policy) : undefined;
    const references =
      referenced ?? (await findReferencedStorageRefs({ db, namespace, policies }, new Set([ownRef])));
    if (references.has(ownRef)) {
      return true;
    }
    try {
      await storage.deleteObject({ key: session.storageKey, target: storageTarget });
      return true;
    } catch {
      return false;
    }
  }

  // Ends a refused completion and keeps nothing it uploaded. The session is
  // first marked 'refused', so no completion call can publish it (or let dedup
  // share its object) any more; only then are its proxy part objects and its own
  // final object deleted (never a key dedup pointed it at). Its part rows are
  // dropped once every delete succeeded. The refused session row stays until the
  // expiry sweep deletes it, which first deletes whatever is left; neither an
  // owner abort nor deleteFile touches it.
  async function refuseSession(session: UploadSession): Promise<void> {
    await fenceRefusedSession(session.uploadSessionId);
    await deleteRefusedUploads(session);
  }

  async function fenceRefusedSession(uploadSessionId: string): Promise<void> {
    await db.update({
      model: 'uploadSessions',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
      data: { status: 'refused' },
      namespace,
    });
  }

  // The storage half of refuseSession, for a session already marked 'refused'.
  async function deleteRefusedUploads(session: UploadSession): Promise<void> {
    const partsDeleted = await deleteProxyTempPartObjects(session);
    const objectDeleted = await deleteOwnUnpublishedObject(session);
    if (partsDeleted && objectDeleted) {
      await db.deleteMany({
        model: 'uploadParts',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId }],
        namespace,
      });
    }
  }

  // Aborts the session's storage upload, deletes its proxy part objects and ends
  // it as aborted; a refused session is ended by refuseSession instead.
  async function discardSessionUpload(session: UploadSession, options: { refused?: boolean } = {}): Promise<void> {
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

    if (options.refused) {
      await refuseSession(session);
      return;
    }
    await deleteProxyTempPartObjects(session);
    await endSessionAborted(session.uploadSessionId);
  }

  const service = {
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
      const requestedFileId = parseRequestedFileId(input.fileId as unknown);

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

      // A client-chosen ID that names an existing file needs write permission on
      // it. A new ID is accepted without reserving anything: the first completion
      // that inserts the `files` row owns the file (see completeSession).
      if (requestedFileId && fileWriteChecker) {
        const canWrite = await fileWriteChecker.canWriteFile(requestedFileId, ctx);
        if (!canWrite) {
          throw errors.forbidden({ fileId: requestedFileId, operation: 'replace' });
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
      const fileId = requestedFileId ?? generateFileFnId('file');
      // The version this session will publish is fixed here, so its storage key is
      // the one object key no other session can write.
      const versionId = generateFileFnId('ver');
      const storageKey = computeStorageKey(policy, {
        fileName: input.fileName,
        principalId: ctx.principalId,
        tenantId: ctx.tenantId,
        fileId,
        versionId,
      });

      // The key must contain this session's whole versionId. Every session gets a
      // fresh random versionId, so two sessions can then never share a key (or the
      // `<key>.partN` proxy part keys derived from it). A storagePath that drops or
      // shortens versionId is refused before any storage upload or session row.
      if (!storageKey.includes(versionId)) {
        throw errors.storagePathNotPerVersion(input.policy);
      }

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
          // Pre-allocated version ID; read as a result only once status is 'completed'.
          completionVersionId: versionId,
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
      const session = await db.findOne<UploadSession>({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        namespace,
      });

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
        status: session.status === 'refused' ? 'aborted' : session.status,
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
      const session = await db.findOne<UploadSession>({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        namespace,
      });

      if (!session) throw errors.sessionNotFound();
      this.assertSessionAccess(session, ctx, uploadSessionToken);
      if (isAbortedStatus(session.status)) throw errors.uploadAborted();
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
      const session = await db.findOne<UploadSession>({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        namespace,
      });

      if (!session) throw errors.sessionNotFound();
      this.assertSessionAccess(session, ctx, uploadSessionToken);
      if (isAbortedStatus(session.status)) throw errors.uploadAborted();
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
        // Conditional on 'pending': updateMany, so a session refused or moved on
        // meanwhile is a zero-match no-op rather than a not-found error.
        await db.updateMany({
          model: 'uploadSessions',
          where: [
            { field: 'uploadSessionId', operator: 'eq', value: uploadSessionId },
            { field: 'status', operator: 'eq', value: 'pending' },
          ],
          data: { status: 'in_progress' },
          namespace,
        });
      }

      events.emit('part.recorded', createPartRecordedEvent({ uploadSessionId, partNumber, size }, ctx.requestId));
      return { etag, size };
    },

    async completePart(uploadSessionId: string, partNumber: number, etag: string, size: number, ctx: FileProviderContext, uploadSessionToken?: string): Promise<void> {
      const session = await db.findOne<UploadSession>({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        namespace,
      });

      if (!session) throw errors.sessionNotFound();
      this.assertSessionAccess(session, ctx, uploadSessionToken);
      if (isAbortedStatus(session.status)) throw errors.uploadAborted();
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
        // Conditional on 'pending': updateMany, so a session refused or moved on
        // meanwhile is a zero-match no-op rather than a not-found error.
        await db.updateMany({
          model: 'uploadSessions',
          where: [
            { field: 'uploadSessionId', operator: 'eq', value: uploadSessionId },
            { field: 'status', operator: 'eq', value: 'pending' },
          ],
          data: { status: 'in_progress' },
          namespace,
        });
      }

      events.emit('part.recorded', createPartRecordedEvent({ uploadSessionId, partNumber, size }, ctx.requestId));
    },

    async completeSession(uploadSessionId: string, ctx: FileProviderContext, uploadSessionToken?: string): Promise<{ fileId: string; versionId: string }> {
      const session = await db.findOne<UploadSession>({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        namespace,
      });

      if (!session) throw errors.sessionNotFound();
      this.assertSessionAccess(session, ctx, uploadSessionToken);
      if (isAbortedStatus(session.status)) throw errors.uploadAborted();
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

      // An earlier attempt may have written this session's version and then failed
      // before marking the session completed. Its object and rows are already
      // published, so resume from that version instead of re-running storage
      // completion or inserting the same unique versionId again.
      const publishedVersion = session.completionVersionId
        ? await db.findOne<{ fileId: string; versionId: string; storageKey: string }>({
            model: 'fileVersions',
            where: [{ field: 'versionId', operator: 'eq', value: session.completionVersionId }],
            namespace,
          })
        : null;

      const fileId = publishedVersion?.fileId || session.fileId || generateFileFnId('file');
      // Publish the version allocated at init, whose ID is part of the storage key.
      // Sessions created before init allocated it have none, so mint one for them.
      const versionId = session.completionVersionId || generateFileFnId('ver');

      const findFile = () => db.findOne<{ fileId: string; currentVersionId: string }>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });
      const findOwnVersion = () => db.findOne({
        model: 'fileVersions',
        where: [{ field: 'versionId', operator: 'eq', value: versionId }],
        namespace,
      });
      // A files row pointing at this session's own versionId was written by this
      // session (another call of it may still be committing), never by a rival.
      const isOwnRow = (file: { currentVersionId: string } | null) => file?.currentVersionId === versionId;
      const fileKey = fileCommitLock.fileKey(fileId);

      // Refuse early, before any storage completion, when the file already exists
      // and the caller cannot write it (for example a session whose init ran
      // before another principal created the file). Nothing the session uploaded
      // is kept, including a final object an interrupted attempt left. A session
      // whose own commit is published or in flight skips this.
      if (!publishedVersion && session.fileId) {
        const current = await findFile();
        if (current && !isOwnRow(current)) {
          // Another call of this session may have published since this call
          // read it, and a later writer may have moved the file on since.
          if (await findOwnVersion()) {
            return { fileId, versionId };
          }
          if (!(await canWriteFileNow(fileId, ctx))) {
            await discardSessionUpload(session, { refused: true });
            throw errors.forbidden({ fileId, operation: 'replace' });
          }
        }
      }

      // Before storage completion, wait for a commit of this fileId that is
      // already running. A stuck one makes this call fail with the retryable
      // 409 while it has changed nothing; only a commit that starts during this
      // call's own storage step can keep it waiting below.
      if (!publishedVersion) {
        await runSerialized(fileKey, async () => {}, { ...fileKeyOptions(session), evictableAt: undefined });
      }

      // Complete multipart upload
      if (publishedVersion) {
        // Storage completion already succeeded for this version.
      } else if (
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
      if (!publishedVersion && storage.statObject) {
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
      const metadata = session.metadata ?? {};

      // Check for deduplication
      let finalStorageKey = publishedVersion?.storageKey || session.storageKey;
      let checksumSha256Base64: string | null = null;
      let isDeduplicated = false;

      if (!publishedVersion && dedup && dedup.isEnabled()) {
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

      // Commit section: create the file or add a version to it. The first
      // completion to insert the `files` row owns the file; init reserves nothing.
      // Within this process the commit decisions per fileId run one at a time
      // (only these database steps: storage I/O above and refusal deletes below
      // run outside the key, so a completion stuck in storage blocks no other).
      // That is the only guard on adapters without unique constraints
      // (single-process only). Across processes the unique `files.fileId`
      // constraint decides the winner.
      const commitOutcome = publishedVersion
        ? 'resumed'
        : await runSerialized(fileKey, async (): Promise<'published' | 'recorded' | 'refused'> => {
            // Another completion call of this same session already published it.
            if (await findOwnVersion()) return 'recorded';

            let current = await findFile();
            if (!current) {
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
              } catch (err) {
                // Lost the insert to another process: re-read the row it wrote.
                current = await findFile();
                if (!current) throw err;
              }
            }

            // Someone else's row (or a later version of it). Permission is decided
            // from the row as it is now, not from the checks at init or above.
            // A row this session wrote itself skips straight to its version.
            if (current && !isOwnRow(current)) {
              if (await findOwnVersion()) return 'recorded';
              if (!(await canWriteFileNow(fileId, ctx))) {
                // Fenced under the key; its storage deletes run after release.
                await fenceRefusedSession(session.uploadSessionId);
                return 'refused';
              }
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
            }

            try {
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
            } catch (err) {
              // Another call of this session inserted the same version first.
              if (await findOwnVersion()) return 'recorded';
              throw err;
            }
            return 'published';
          }, { ...fileKeyOptions(session), keepWaiting: true });

      if (commitOutcome === 'recorded') {
        // The recorded result belongs to the call that published it; this call
        // deletes nothing and emits nothing.
        return { fileId, versionId };
      }

      if (commitOutcome === 'refused') {
        // Dedup's own delete of the session's object ignores failures, and
        // stitching's proxy part deletes too; these delete them again and check
        // the result.
        await deleteRefusedUploads(session);
        throw errors.forbidden({ fileId, operation: 'replace' });
      }

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
      const session = await db.findOne<UploadSession>({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        namespace,
      });

      if (!session) throw errors.sessionNotFound();
      this.assertSessionAccess(session, ctx, uploadSessionToken);
      if (session.status === 'completed') throw errors.uploadAlreadyCompleted();
      // Already ended. A refused session may still have objects to delete; its
      // row records them for the expiry sweep, so leave it in place.
      if (isAbortedStatus(session.status)) return;

      await discardSessionUpload(session);
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

        // The sweep deletes a session's final object only when the session was
        // refused: no completion can publish that object or let dedup share it.
        // Any other expired session keeps its final object, as a completion of
        // it may still be running and publish it.
        // One reference lookup for the whole sweep keeps any refused session's
        // object that a version or artifact references anyway.
        const candidateRefs = new Set<string>();
        for (const session of expiredSessions) {
            const ownRef = ownObjectRef(session);
            if (ownRef !== undefined && session.status === 'refused') candidateRefs.add(ownRef);
        }
        const referencedRefs = await findReferencedStorageRefs({ db, namespace, policies }, candidateRefs);

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

            // If a part object or a refused session's final object cannot be
            // deleted, keep the session and its part rows for the next sweep.
            const partsDeleted = await deleteProxyTempPartObjects(session);
            const objectDeleted = session.status === 'refused'
                ? await deleteOwnUnpublishedObject(session, referencedRefs)
                : true;
            if (!partsDeleted || !objectDeleted) {
                continue;
            }
            // Only while it still has the status this sweep read: a session
            // refused meanwhile keeps its row, the record of what to delete.
            const removed = await db.deleteMany({
                model: 'uploadSessions',
                where: [
                    { field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId },
                    { field: 'status', operator: 'eq', value: session.status },
                ],
                namespace
            });
            if (removed === 0) {
                continue;
            }
            await db.deleteMany({
                model: 'uploadParts',
                where: [{ field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId }],
                namespace
            });
            deletedSessions++;
        }

        return { deletedSessions, abortedMultipart };
    }
  };

  // Calls completing one session run one at a time in this process, so a
  // retried call never finalizes storage or refuses alongside another call of
  // the same session; it reads the result the earlier call recorded. After the
  // session has expired its key may be taken by a call that has waited out
  // SERIALIZED_WAIT_TIMEOUT_MS: that call only reads the session and reports it
  // expired. Sessions of one fileId run their storage steps concurrently (each
  // has its own storage key) and only their commit decision per fileId (see the
  // commit section) one at a time.
  const completeSessionNow = service.completeSession;
  service.completeSession = async (uploadSessionId, ctx, uploadSessionToken) => {
    const complete = () => completeSessionNow.call(service, uploadSessionId, ctx, uploadSessionToken);
    // expiresAt never changes after init; status is read again inside.
    const session = await db.findOne<UploadSession>({
      model: 'uploadSessions',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
      namespace,
    });
    if (!session) {
      return complete();
    }
    const expiresAtMs = Date.parse(session.expiresAt);
    return runSerialized(`session\u0000${namespace}\u0000${uploadSessionId}`, complete, {
      evictableAt: Number.isNaN(expiresAtMs) ? undefined : expiresAtMs,
    });
  };

  return service;
}

export type UploadSessionService = ReturnType<typeof createUploadSessionService>;

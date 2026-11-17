import type { Adapter, WhereClause } from '@superfunctions/db';
import { getStorageCapabilities, type StorageAdapter, type StorageTargetName } from '@superfunctions/storage';
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
import { parseRequestedFileId, SERIALIZED_WAIT_TIMEOUT_MS } from './file-id.js';
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
  /**
   * How long a completion may hold its upload session in `completing` before
   * another completion call may take the session over (for example after the
   * completing process crashed). Defaults to 900 (15 minutes).
   */
  completionTimeoutSeconds?: number;
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
  // may still need deleting; clients see it as 'aborted'. 'completing' is held
  // by one completion call (see claimCompletion); clients see it as
  // 'in_progress'.
  status: 'pending' | 'in_progress' | 'completing' | 'completed' | 'aborted' | 'refused' | 'expired';
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
  /**
   * The claim of the completion call holding the session ('completing') or,
   * once completed, of the call that completed it: `<ISO time> <random>`, the
   * time the call claimed the session. Conditional writes match on it.
   */
  completionClaim?: string | null;
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

// How often a completion call polls a session another process is completing.
const COMPLETION_POLL_INTERVAL_MS = 200;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    completionTimeoutSeconds = 900, // 15m
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

  const completionTimeoutMs = completionTimeoutSeconds * 1000;

  async function readSession(uploadSessionId: string): Promise<UploadSession | null> {
    return db.findOne<UploadSession>({
      model: 'uploadSessions',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
      namespace,
    });
  }

  // A claim older than the completion timeout belongs to a completion that
  // crashed or stalled; another completion call may take the session over. A
  // stalled holder that resumes cannot undo what the call that took over did:
  // it stitches into an object of its own (attemptStorageKey), moves the file
  // only from the version it read (compare-and-set), refuses and completes the
  // session only with writes conditional on its claim, and the unique versionId
  // admits one version insert of the session.
  function isStaleClaim(session: UploadSession): boolean {
    const claimedAtMs = Date.parse((session.completionClaim ?? '').split(' ')[0]);
    return Number.isNaN(claimedAtMs) || Date.now() - claimedAtMs >= completionTimeoutMs;
  }

  // How far the session's own version is published: 'version' once its
  // fileVersions row exists, 'file' while only the files row points at it (the
  // version insert failed, or has not run yet), null when neither. A session
  // published either way is never released, aborted or discarded: the file
  // may already point at its version. One with a 'version' row may be taken
  // over at once: what remains is to mark it completed, which the holder's
  // claim-matched write then cannot do.
  async function publicationOf(session: UploadSession): Promise<'version' | 'file' | null> {
    if (!session.completionVersionId) return null;
    const version = await db.findOne({
      model: 'fileVersions',
      where: [{ field: 'versionId', operator: 'eq', value: session.completionVersionId }],
      namespace,
    });
    if (version) return 'version';
    if (!session.fileId) return null;
    const file = await db.findOne<{ currentVersionId: string }>({
      model: 'files',
      where: [{ field: 'fileId', operator: 'eq', value: session.fileId }],
      namespace,
    });
    return file?.currentVersionId === session.completionVersionId ? 'file' : null;
  }

  // Writes `data` to the session only while it still has `expected`'s status
  // (and claim, when given: null matches a session never claimed), through `db.update`: `updateMany`'s count is not
  // reliable on every adapter. `db.update` returns the row it wrote; a write
  // that matches no row throws (or returns nothing) and is lost. On a throw the
  // row read back decides: `applied` (the write landed after all), still
  // matching `expected` (the write itself failed: rethrown), or changed by
  // another writer first (lost).
  async function updateSessionIf(
    uploadSessionId: string,
    expected: Pick<UploadSession, 'status'> & { completionClaim?: string | null },
    data: Partial<UploadSession>,
    applied: (row: UploadSession) => boolean,
  ): Promise<{ applied: true } | { applied: false; current: UploadSession | null }> {
    const where: WhereClause[] = [
      { field: 'uploadSessionId', operator: 'eq', value: uploadSessionId },
      { field: 'status', operator: 'eq', value: expected.status },
    ];
    const claimMatters = expected.completionClaim !== undefined;
    if (claimMatters) {
      where.push({ field: 'completionClaim', operator: 'eq', value: expected.completionClaim ?? null });
    }
    let failure: unknown;
    try {
      const updated = await db.update<UploadSession | null | undefined>({ model: 'uploadSessions', where, data, namespace });
      if (updated) return { applied: true };
    } catch (err) {
      failure = err;
    }
    const current = await readSession(uploadSessionId);
    if (current && applied(current)) return { applied: true };
    if (
      current &&
      current.status === expected.status &&
      (!claimMatters || (current.completionClaim ?? null) === (expected.completionClaim ?? null))
    ) {
      throw failure ?? new Error(`Conditional update of upload session ${uploadSessionId} did not apply`);
    }
    return { applied: false, current };
  }

  // Moves the session into 'completing' for the calling completion: from
  // 'pending' or 'in_progress', or from a stale claim. One call wins each state
  // of the row (its status and the claim it last had); an abort, which leaves
  // those states the same way, excludes it. A claim is "<claimedAt> <nonce>";
  // one of a session claimed before (taken over, or after a released claim)
  // ends in " retake", so its proxy stitch uses a key of its own.
  async function claimCompletion(session: UploadSession): Promise<{ claim: string } | { current: UploadSession | null }> {
    const retake = session.completionClaim ? ' retake' : '';
    const claim = `${new Date().toISOString()} ${randomBytes(6).toString('hex')}${retake}`;
    const outcome = await updateSessionIf(
      session.uploadSessionId,
      { status: session.status, completionClaim: session.completionClaim ?? null },
      { status: 'completing', completionClaim: claim },
      (row) => row.status === 'completing' && row.completionClaim === claim,
    );
    return outcome.applied ? { claim } : { current: outcome.current };
  }

  // Returns a claimed session to the status it was claimed from, after its
  // completion failed before publishing anything, so the client can retry or
  // abort at once. A failed release leaves the claim to lapse. The claim stays
  // on the row: an earlier holder that was taken over may still be writing the
  // session's key, so the next claim is a retake and stitches elsewhere.
  async function releaseClaim(uploadSessionId: string, claim: string, status: UploadSession['status']): Promise<void> {
    try {
      // Conditional and count-free: a no-op once the session left this claim.
      await db.updateMany({
        model: 'uploadSessions',
        where: [
          { field: 'uploadSessionId', operator: 'eq', value: uploadSessionId },
          { field: 'status', operator: 'eq', value: 'completing' },
          { field: 'completionClaim', operator: 'eq', value: claim },
        ],
        data: { status },
        namespace,
      });
    } catch {
      // The claim lapses after the completion timeout.
    }
  }

  // Leaves a claim whose completion failed after (part of) the session's
  // version may have been published open to the next completion call at once:
  // its time is set to the epoch, so it reads as stale. The session stays
  // 'completing', so no abort can end it, and its nonce stays, so the call
  // taking it over still knows the object this claim stitched. A failed write
  // leaves the claim to lapse after the completion timeout.
  async function expireClaim(uploadSessionId: string, claim: string): Promise<void> {
    const expired = [new Date(0).toISOString(), ...claim.split(' ').slice(1)].join(' ');
    try {
      await db.updateMany({
        model: 'uploadSessions',
        where: [
          { field: 'uploadSessionId', operator: 'eq', value: uploadSessionId },
          { field: 'status', operator: 'eq', value: 'completing' },
          { field: 'completionClaim', operator: 'eq', value: claim },
        ],
        data: { completionClaim: expired },
        namespace,
      });
    } catch {
      // The claim lapses after the completion timeout.
    }
  }

  // The checks a completion passes before it claims the session: every part
  // recorded, and the quota still allowing the session's size.
  async function admitCompletion(
    session: UploadSession,
    ctx: FileProviderContext,
  ): Promise<{ parts: Array<{ partNumber: number; etag: string }> } | { error: Error }> {
    const parts = await db.findMany<{ partNumber: number; etag: string }>({
      model: 'uploadParts',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId }],
      namespace,
    });
    if (parts.length !== session.totalParts) {
      return { error: errors.uploadIncomplete() };
    }
    if (quota) {
      const quotaResult = await quota.checkQuota({
        principalId: ctx.principalId,
        tenantId: ctx.tenantId,
        requestedBytes: session.size,
      });
      if (!quotaResult.allowed) {
        return { error: errors.quotaExceeded(quotaResult.current, quotaResult.limit, session.size) };
      }
    }
    return { parts };
  }

  // Whether the session is still held by `claim`.
  async function holdsClaim(uploadSessionId: string, claim: string): Promise<boolean> {
    const holder = await readSession(uploadSessionId);
    return holder?.status === 'completing' && holder.completionClaim === claim;
  }

  // The object a completion of the session publishes. Multipart completion
  // writes no bytes of its own (storage assembles the recorded parts), so every
  // claim uses the session's key. A proxy completion stitches the bytes itself:
  // the first claim into the session's key, a retake (which may overlap an
  // earlier holder that stalled while writing) into a key of its own, so no two
  // completions ever write one object.
  function attemptStorageKey(session: UploadSession, claim: string): string {
    const [, nonce, retake] = claim.split(' ');
    return session.uploadMode === 'proxy' && retake === 'retake' && nonce
      ? `${session.storageKey}.c${nonce}`
      : session.storageKey;
  }

  // Deletes a proxy object a completion stitched that the session's version
  // does not use (the completion lost its claim, failed or was refused). Only
  // the session's own version could publish such a key, so it is kept only when
  // that version (or a read failure, or a session from before per-session keys)
  // leaves it in doubt.
  async function deleteAttemptObject(session: UploadSession, key: string, target: StorageTargetName | undefined): Promise<void> {
    if (session.uploadMode !== 'proxy' || !storage.deleteObject || !session.completionVersionId) return;
    try {
      const version = await db.findOne<{ storageKey: string }>({
        model: 'fileVersions',
        where: [{ field: 'versionId', operator: 'eq', value: session.completionVersionId }],
        namespace,
      });
      if (version?.storageKey === key) return;
      await storage.deleteObject({ key, target });
    } catch {
      // Left behind; the object is unreferenced.
    }
  }

  // Whether the session's own final object is already in storage at its full
  // size: a multipart completion that finalized storage and then failed or
  // crashed before publishing left it (its multipart upload is consumed). The
  // key is the session's own (FILE-16), so no other upload wrote it.
  async function isStorageFinalized(session: UploadSession, target: StorageTargetName | undefined): Promise<boolean> {
    if (!storage.statObject) return false;
    try {
      const stat = await storage.statObject({ key: session.storageKey, target });
      return stat.size === session.size;
    } catch {
      return false;
    }
  }

  // Whether every proxy part object of the session is still in storage. Without
  // statObject this cannot be told, and stitching runs as before.
  async function proxyPartsPresent(
    session: UploadSession,
    parts: Array<{ partNumber: number }>,
    target: StorageTargetName | undefined,
  ): Promise<boolean> {
    if (!storage.statObject) return true;
    for (const part of parts) {
      try {
        await storage.statObject({ key: proxyPartKey(session.storageKey, part.partNumber), target });
      } catch {
        return false;
      }
    }
    return true;
  }

  // The result a completed session recorded.
  async function recordedResult(session: UploadSession): Promise<{ fileId: string; versionId: string }> {
    if (session.fileId && session.completionVersionId) {
      return { fileId: session.fileId, versionId: session.completionVersionId };
    }
    // Sessions completed before completionVersionId was recorded.
    const file = session.fileId
      ? await db.findOne<{ fileId: string; currentVersionId: string }>({
          model: 'files',
          where: [{ field: 'fileId', operator: 'eq', value: session.fileId }],
          namespace,
        })
      : null;
    if (file) return { fileId: file.fileId, versionId: file.currentVersionId };
    throw errors.uploadAlreadyCompleted();
  }

  // The answer of a completion that lost its claim (taken over after the
  // completion timeout): the session's state as it is now. It deletes nothing.
  async function lostClaimResult(uploadSessionId: string, current?: UploadSession | null): Promise<{ fileId: string; versionId: string }> {
    const session = current === undefined ? await readSession(uploadSessionId) : current;
    if (!session) throw errors.sessionNotFound();
    if (session.status === 'completed') return recordedResult(session);
    if (isAbortedStatus(session.status)) throw errors.uploadAborted();
    throw errors.uploadCompletionInProgress();
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

  // Ends a refused completion: the session is marked 'refused' while this
  // completion still holds it (a write conditional on its claim), so no
  // completion call can publish it (or let dedup share its object) any more,
  // and a completion whose claim was taken over refuses (and deletes) nothing.
  // Returns whether the refusal applied. The caller then deletes what the
  // session uploaded (deleteRefusedUploads). The refused session row stays until
  // the expiry sweep deletes it, which first deletes whatever is left; neither
  // an owner abort nor deleteFile touches it.
  async function fenceRefusedSession(uploadSessionId: string, claim: string): Promise<boolean> {
    const fenced = await updateSessionIf(
      uploadSessionId,
      { status: 'completing', completionClaim: claim },
      { status: 'refused' },
      (row) => row.status === 'refused',
    );
    return fenced.applied;
  }

  // Deletes what a refused session uploaded: its proxy part objects and its own
  // final object (never a key dedup pointed it at). Its part rows are dropped
  // once every delete succeeded.
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

  async function abortStorageUpload(session: UploadSession): Promise<void> {
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
  }

  // Aborts the session's storage upload, deletes its proxy part objects and ends
  // it as aborted; a refused session is ended by fenceRefusedSession instead.
  async function discardSessionUpload(session: UploadSession): Promise<void> {
    await abortStorageUpload(session);
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
          // Never claimed; the first completion claims it conditional on null.
          completionClaim: null,
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
        status: session.status === 'refused'
          ? 'aborted'
          : session.status === 'completing' ? 'in_progress' : session.status,
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
      // The completion has read the parts it publishes.
      if (session.status === 'completing') throw errors.uploadCompletionInProgress();
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
      // The completion has read the parts it publishes.
      if (session.status === 'completing') throw errors.uploadCompletionInProgress();
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
      // The completion has read the parts it publishes.
      if (session.status === 'completing') throw errors.uploadCompletionInProgress();
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
      let session = await readSession(uploadSessionId);
      if (!session) throw errors.sessionNotFound();
      this.assertSessionAccess(session, ctx, uploadSessionToken);

      // Claim the session ('completing') before changing anything, so it
      // completes at most once and no abort runs alongside. A session another
      // call holds (in another process: calls in this one run one at a time) is
      // polled until that call ends, for at most SERIALIZED_WAIT_TIMEOUT_MS; its
      // recorded result is then returned. A claim past the completion timeout,
      // or one whose version is already published, is taken over.
      const waitUntil = Date.now() + SERIALIZED_WAIT_TIMEOUT_MS;
      let claim: string | undefined;
      let parts: Array<{ partNumber: number; etag: string }> = [];
      while (claim === undefined) {
        if (isAbortedStatus(session.status)) throw errors.uploadAborted();
        if (session.status === 'completed') return recordedResult(session);
        if (isExpiredAt(session.expiresAt)) throw errors.uploadExpired();

        let current: UploadSession | null;
        // A session whose own version is already published only has to be
        // marked completed: its parts and quota were admitted by the call that
        // published it, and that call may be deleting its parts and recording
        // its usage right now, so neither is checked again. One the file
        // already points at (its version insert failed, or its holder is
        // about to run it) is taken over once its claim is stale (a holder
        // that failed there expires its claim at once); its quota was
        // admitted too, and its parts are read once it is claimed.
        const publication = session.status === 'completing' ? await publicationOf(session) : null;
        if (session.status === 'completing' && publication !== 'version' && !isStaleClaim(session)) {
          if (Date.now() >= waitUntil) throw errors.uploadCompletionInProgress();
          await delay(COMPLETION_POLL_INTERVAL_MS);
          current = await readSession(uploadSessionId);
        } else {
          parts = [];
          if (publication === null) {
            const admission = await admitCompletion(session, ctx);
            if ('error' in admission) {
              // Checked against a session another call may have moved on
              // meanwhile (completed it, or published it): decide again from
              // the session as it is now.
              const fresh = await readSession(uploadSessionId);
              if (!fresh) throw errors.sessionNotFound();
              if (fresh.status === session.status && fresh.completionClaim === session.completionClaim) {
                // A stale claim this call cannot take over is ended (claimed
                // and released at once), so the owner can abort the session
                // instead of waiting for it to expire. The stale holder may
                // have moved on meanwhile: a lost end-claim decides again from
                // the session as it is now (its recorded result once
                // completed), and a won one whose version was published (or
                // the file moved to it) in between finishes that version
                // instead of releasing it.
                if (session.status === 'completing') {
                  const ended = await claimCompletion(session);
                  if (!('claim' in ended)) {
                    if (!ended.current) throw errors.sessionNotFound();
                    session = ended.current;
                    continue;
                  }
                  // Kept on a failed check: the claim lapses, never released
                  // over a version that may be published.
                  if ((await publicationOf(session)) !== null) {
                    claim = ended.claim;
                    parts = [];
                    break;
                  }
                  await releaseClaim(uploadSessionId, ended.claim, 'in_progress');
                }
                throw admission.error;
              }
              session = fresh;
              continue;
            }
            parts = admission.parts;
          }

          const claimed = await claimCompletion(session);
          if ('claim' in claimed) {
            claim = claimed.claim;
            break;
          }
          current = claimed.current;
        }
        if (!current) throw errors.sessionNotFound();
        session = current;
      }

      // A failure before the session's version is published returns the
      // session to the status it was claimed from ('in_progress' for a claim
      // taken over from a stale one, whose parts were all recorded), so it can
      // be retried or aborted at once. Once the file points at the version (or
      // that cannot be told), the session stays 'completing' with its claim
      // expired: the next completion call takes it over at once and finishes
      // the version, and no abort can end it meanwhile. A call that failed after
      // its claim was taken over and the session completed returns the
      // recorded result instead of its own failure. A proxy object it stitched
      // and did not publish is deleted.
      const claimedSession = session;
      let published = false;
      let stitchedKey: string | undefined;
      const claimedTarget = (() => {
        const claimedPolicy = policies.get(claimedSession.policy);
        return claimedPolicy ? resolveStorageTarget(claimedPolicy) : undefined;
      })();
      const discardStitched = async () => {
        if (stitchedKey !== undefined) await deleteAttemptObject(claimedSession, stitchedKey, claimedTarget);
      };
      try {
        return await completeClaimedSession(session, claim, parts, () => { published = true; });
      } catch (err) {
        await discardStitched();
        const now = await readSession(uploadSessionId).catch(() => undefined);
        if (now?.status === 'completed' && now.completionClaim !== claim) {
          return recordedResult(now);
        }
        if (now?.status === 'completing' && now.completionClaim === claim) {
          // A files or version write that failed may have landed anyway.
          const landed = published || (await publicationOf(claimedSession).catch(() => 'unknown' as const)) !== null;
          if (landed) {
            await expireClaim(uploadSessionId, claim);
          } else {
            const releasedStatus = claimedSession.status === 'completing' ? 'in_progress' : claimedSession.status;
            await releaseClaim(uploadSessionId, claim, releasedStatus);
          }
        }
        throw err;
      }

      async function completeClaimedSession(
        session: UploadSession,
        claim: string,
        parts: Array<{ partNumber: number; etag: string }>,
        markPublished: () => void,
      ): Promise<{ fileId: string; versionId: string }> {
        const policy = policies.get(session.policy);
        const policyStorageTarget = policy ? resolveStorageTarget(policy) : undefined;
        // The object this call finalizes, and the one the claim it took over (or
        // followed) finalized: see attemptStorageKey.
        const attemptKey = attemptStorageKey(session, claim);
        const predecessorKey = session.completionClaim ? attemptStorageKey(session, session.completionClaim) : undefined;

        // An earlier attempt may have written this session's version and then failed
        // before marking the session completed. Its object and rows are already
        // published, so resume from that version instead of re-running storage
        // completion or inserting the same unique versionId again.
        let publishedVersion = session.completionVersionId
          ? await db.findOne<{ fileId: string; versionId: string; storageKey: string }>({
              model: 'fileVersions',
              where: [{ field: 'versionId', operator: 'eq', value: session.completionVersionId }],
              namespace,
            })
          : null;
        if (publishedVersion) markPublished();

        // A call that took over a session the file already points at skipped
        // the admission checks (they passed for the call that moved the file),
        // so it reads the parts storage completion needs here.
        if (!publishedVersion && parts.length !== session.totalParts) {
          parts = await db.findMany<{ partNumber: number; etag: string }>({
            model: 'uploadParts',
            where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
            namespace,
          });
          if (parts.length !== session.totalParts) throw errors.uploadIncomplete();
        }

        const fileId = publishedVersion?.fileId || session.fileId || generateFileFnId('file');
        // Publish the version allocated at init, whose ID is part of the storage key.
        // Sessions created before init allocated it have none, so mint one for them.
        const versionId = session.completionVersionId || generateFileFnId('ver');

        const findFile = () => db.findOne<{ fileId: string; currentVersionId: string }>({
          model: 'files',
          where: [{ field: 'fileId', operator: 'eq', value: fileId }],
          namespace,
        });
        const findOwnVersion = () => db.findOne<{ fileId: string; versionId: string; storageKey: string }>({
          model: 'fileVersions',
          where: [{ field: 'versionId', operator: 'eq', value: versionId }],
          namespace,
        });
        // A files row pointing at this session's own versionId was written by this
        // session (another call of it may still be committing), never by a rival.
        const isOwnRow = (file: { currentVersionId: string } | null) => file?.currentVersionId === versionId;
        const fileKey = fileCommitLock.fileKey(fileId);
        // Moves the file from `fromVersionId` to this session's version, only if
        // it still points there. Returns false when another writer moved it
        // first; a write that failed while the row is unchanged rethrows.
        const moveFileTo = async (fromVersionId: string): Promise<boolean> => {
          let failure: unknown;
          try {
            const updated = await db.update<unknown>({
              model: 'files',
              where: [
                { field: 'fileId', operator: 'eq', value: fileId },
                { field: 'currentVersionId', operator: 'eq', value: fromVersionId },
              ],
              data: {
                currentVersionId: versionId,
                size: session.size,
                mimeType: session.mimeType,
                metadata: session.metadata ?? {},
                updatedAt: new Date().toISOString(),
              },
              namespace,
            });
            if (updated) return true;
          } catch (err) {
            failure = err;
          }
          const file = await findFile();
          if (isOwnRow(file)) return true;
          if (file?.currentVersionId === fromVersionId) {
            throw failure ?? new Error(`Conditional update of file ${fileId} did not apply`);
          }
          return false;
        };

        // Refuse early, before any storage completion, when the file already exists
        // and the caller cannot write it (for example a session whose init ran
        // before another principal created the file). Nothing the session uploaded
        // is kept, including a final object an interrupted attempt left. A session
        // whose own commit is published or in flight skips this.
        if (!publishedVersion && session.fileId) {
          const current = await findFile();
          if (current && !isOwnRow(current)) {
            // An earlier holder of the session may have published since this
            // call read it, and a later writer may have moved the file on since:
            // finish from that version.
            publishedVersion = await findOwnVersion();
            if (publishedVersion) {
              markPublished();
            } else if (!(await canWriteFileNow(fileId, ctx))) {
              // Refused only while this call still holds the session: one
              // whose claim was taken over refuses and deletes nothing.
              if (!(await fenceRefusedSession(uploadSessionId, claim))) return lostClaimResult(uploadSessionId);
              await abortStorageUpload(session);
              await deleteRefusedUploads(session);
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

        // Finalize storage. A proxy stitch writes only this call's own object
        // (attemptKey), so a holder that stalled past the completion timeout
        // and was taken over cannot rewrite or truncate the object the call that
        // took over published, even with its I/O already in flight; the claim
        // checks before each storage step only save it work. Multipart
        // completion assembles the same recorded parts whoever runs it; a call
        // that finds the upload already consumed by an earlier holder of the
        // session goes on from the object it left.
        if (publishedVersion) {
          // Storage completion already succeeded for this version.
        } else if (
          session.uploadMode === 'multipart-signed-url' &&
          getStorageCapabilities(storage, policyStorageTarget).multipart &&
          storage.completeMultipartUpload &&
          session.storageUploadId
        ) {
          if (!(await holdsClaim(uploadSessionId, claim))) return lostClaimResult(uploadSessionId);
          try {
            await storage.completeMultipartUpload({
              key: session.storageKey,
              target: policyStorageTarget,
              uploadId: session.storageUploadId,
              parts: parts.sort((a, b) => a.partNumber - b.partNumber).map(p => ({ partNumber: p.partNumber, etag: p.etag })),
            });
          } catch (err) {
            // S3 and R2 answer NoSuchUpload for an upload already completed.
            if (!(await isStorageFinalized(session, policyStorageTarget))) throw err;
          }
        } else if (session.uploadMode === 'proxy') {
          // Stitch proxy parts
          if (!storage.openUploadStream || !storage.openDownloadStream) {
              throw new Error('Storage adapter does not support streaming required for proxy upload completion');
          }

          // The part objects stay until the session is completed, so every
          // holder of the session finds them.
          const sortedParts = parts.sort((a, b) => a.partNumber - b.partNumber);
          if (!(await proxyPartsPresent(session, sortedParts, policyStorageTarget))) {
            // Never open (and so truncate) an object without every part.
            throw new Error(`Proxy part objects of upload session ${uploadSessionId} are missing`);
          } else {
            if (!(await holdsClaim(uploadSessionId, claim))) return lostClaimResult(uploadSessionId);
            stitchedKey = attemptKey;
            const writeStream = await storage.openUploadStream({
                key: attemptKey,
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
            } catch (err) {
                // A failed stitch never commits the object it was writing.
                await writer.abort(err).catch(() => {});
                throw err;
            }
            await writer.close();
          }
        }

        // Validate size if supported
        if (!publishedVersion && storage.statObject) {
          try {
            const stat = await storage.statObject({ key: attemptKey, target: policyStorageTarget });
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
        let finalStorageKey = publishedVersion?.storageKey || attemptKey;
        let checksumSha256Base64: string | null = null;

        if (!publishedVersion && dedup && dedup.isEnabled()) {
          const dedupResult = await dedup.computeAndCheckDuplicate(
            attemptKey,
            session.tenantId,
            policyStorageTarget ?? null,
            storage
          );

          checksumSha256Base64 = dedupResult.checksumSha256Base64;

          if (dedupResult.isDuplicate && dedupResult.existingStorageKey) {
            // Reuse existing storage key (reference to existing object). This
            // call's own object is deleted once the session is completed
            // (below), so a call that takes the session over after this one
            // stalled or crashed still finds it.
            finalStorageKey = dedupResult.existingStorageKey;
          }
        }

        // Commit section: create the file or add a version to it. The first
        // completion to insert the `files` row owns the file; init reserves nothing.
        // Within this process the commit decisions per fileId run one at a time
        // (only these database steps: storage I/O above and refusal deletes below
        // run outside the key, so a completion stuck in storage blocks no other).
        // That is the only guard on adapters without unique constraints
        // (single-process only). Across processes the unique `files.fileId`
        // constraint decides the winner. A call whose claim was taken over
        // (it ran past the completion timeout) commits nothing.
        const commitOutcome = publishedVersion
          ? 'resumed'
          : await runSerialized(fileKey, async (): Promise<'published' | 'recorded' | 'refused' | 'lost'> => {
              const holder = await readSession(uploadSessionId);
              if (holder?.status !== 'completing' || holder.completionClaim !== claim) return 'lost';
              // An earlier holder of this session already published it.
              if (await findOwnVersion()) return 'recorded';

              // Point the file at this version. A row this session wrote itself
              // skips straight to its version. Someone else's row (or a later
              // version of it) is decided from the row as it is now, not from
              // the checks at init or above, and moved only from the version
              // read here (compare-and-set): a call that stalled anywhere in
              // between, and was taken over, never moves the file back.
              for (;;) {
                const current = await findFile();
                if (!current) {
                  if (!(await holdsClaim(uploadSessionId, claim))) return 'lost';
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
                    break;
                  } catch (err) {
                    // Lost the insert to another process: decide from the row it wrote.
                    if (!(await findFile())) throw err;
                    continue;
                  }
                }
                if (isOwnRow(current)) break;
                if (await findOwnVersion()) return 'recorded';
                const writable = await canWriteFileNow(fileId, ctx);
                // The check above may have taken any time: decide on the claim
                // as it is now.
                if (!(await holdsClaim(uploadSessionId, claim))) return 'lost';
                if (!writable) {
                  // Fenced under the key; its storage deletes run after release.
                  return (await fenceRefusedSession(uploadSessionId, claim)) ? 'refused' : 'lost';
                }
                if (await moveFileTo(current.currentVersionId)) break;
              }

              // The file points at this version now: from here on the session
              // is never released. Reads above (or the files write itself) may
              // have taken any time, so the version is inserted only while this
              // call still holds the session; one taken over inserts nothing
              // and the call that took it over finishes the version.
              markPublished();
              if (!(await holdsClaim(uploadSessionId, claim))) return 'lost';
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

        if (commitOutcome === 'lost') {
          await discardStitched();
          return lostClaimResult(uploadSessionId);
        }
        if (commitOutcome === 'published') markPublished();

        if (commitOutcome === 'recorded') {
          // An earlier holder published this version and lost its claim before
          // marking the session completed; this call, the holder now, finishes
          // the session (the earlier one deletes and emits nothing).
          markPublished();
          finalStorageKey = (await findOwnVersion())?.storageKey || finalStorageKey;
        }

        if (commitOutcome === 'refused') {
          // The session's own object is deleted (or kept for the sweep) here;
          // a retake's stitch only this call knows of.
          await deleteRefusedUploads(session);
          if (attemptKey !== session.storageKey) await discardStitched();
          stitchedKey = undefined;
          throw errors.forbidden({ fileId, operation: 'replace' });
        }

        // Complete the session while this call still holds it. Only the call that
        // does so records usage, emits and triggers processing; one whose claim
        // was taken over returns the session's state instead.
        const finished = await updateSessionIf(
          uploadSessionId,
          { status: 'completing', completionClaim: claim },
          { status: 'completed', fileId, completionVersionId: versionId },
          (row) => row.status === 'completed' && row.completionClaim === claim,
        );
        if (!finished.applied) {
          // This call published the session's version, or lost the claim before
          // its version insert; the call that took the session over completes
          // it with the version published. Its object is deleted unless that
          // version uses it.
          await discardStitched();
          if (finished.current?.status === 'completed') return recordedResult(finished.current);
          if (finished.current?.status === 'completing') return { fileId, versionId };
          return lostClaimResult(uploadSessionId, finished.current);
        }

        // Only the call that completed the session deletes its proxy part
        // objects: every holder before may still need them.
        await deleteProxyTempPartObjects(session);
        await db.deleteMany({
          model: 'uploadParts',
          where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
          namespace,
        });

        // Delete the session's objects the published version does not use: its
        // own copy when the version reuses an existing object (dedup), this
        // call's stitch when an earlier holder's version was published, and the
        // stitch of the claim this call took over. Nothing references them.
        // Sessions from before per-session keys (no pre-allocated versionId) may
        // share their key, so only this call's own object is deleted for them.
        const unused = new Set([attemptKey]);
        if (session.completionVersionId) {
          unused.add(session.storageKey);
          if (predecessorKey !== undefined) unused.add(predecessorKey);
        }
        unused.delete(finalStorageKey);
        if (storage.deleteObject) {
          for (const key of unused) {
            try {
              await storage.deleteObject({ key, target: policyStorageTarget });
            } catch {
              // Ignore deletion errors - storage cleanup is non-critical
            }
          }
        }

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
      }
    },

    async abortSession(uploadSessionId: string, ctx: FileProviderContext, uploadSessionToken?: string): Promise<void> {
      let session = await readSession(uploadSessionId);

      if (!session) throw errors.sessionNotFound();
      this.assertSessionAccess(session, ctx, uploadSessionToken);
      // The session is ended with a conditional write before anything is
      // deleted, so an abort and a completion's claim exclude each other: a
      // session a completion holds gets 409, and one this abort ended can no
      // longer be claimed.
      for (;;) {
        if (session.status === 'completed') throw errors.uploadAlreadyCompleted();
        if (session.status === 'completing') throw errors.uploadCompletionInProgress();
        // Already ended. A refused session may still have objects to delete; its
        // row records them for the expiry sweep, so leave it in place.
        if (isAbortedStatus(session.status)) return;
        // A session whose version is (partly) published is never aborted, even
        // when an earlier release left it open: the file may point at the
        // version. A completion call finishes it. No completion can publish
        // it between this check and the write below without claiming it
        // first, which the write's status condition excludes.
        if ((await publicationOf(session)) !== null) throw errors.uploadCompletionInProgress();

        const ended = await updateSessionIf(
          uploadSessionId,
          { status: session.status },
          { status: 'aborted' },
          (row) => row.status === 'aborted',
        );
        if (ended.applied) break;
        // Deleted meanwhile by the expiry sweep, which also cleaned it up.
        if (!ended.current) return;
        session = ended.current;
      }

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
  // the same session; it reads the result the earlier call recorded. Across
  // processes the session's 'completing' claim does the same (see
  // completeSession). After the
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

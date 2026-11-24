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
  // by one completion call (see claimCompletion); 'publishing' records the
  // version that call decided to publish (completionPublication), which any
  // completion call then finishes. Clients see both as 'in_progress'.
  status: 'pending' | 'in_progress' | 'completing' | 'publishing' | 'completed' | 'aborted' | 'refused' | 'expired';
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
   * The claim of the completion call holding the session ('completing'):
   * `<ISO time> <random>`, the time the call claimed the session. A
   * 'publishing' session's claim also carries the revision of its publication
   * (see revisedClaim). Conditional writes match on it.
   */
  completionClaim?: string | null;
  /** What a 'publishing' (and then 'completed') session publishes. */
  completionPublication?: CompletionPublication | null;
  uploadSessionToken?: string | null;
  uploadSessionTokenHash?: string | null;
}

/**
 * The commit record of an upload completion, written with the move to
 * 'publishing' before the version or the file is written. `baseVersionId` is
 * the file's version the publication replaces (null: it creates the file).
 * `unusedKeys` are the session's objects the version does not use, deleted
 * once the session is completed.
 */
export interface CompletionPublication {
  versionId: string;
  storageKey: string;
  checksumSha256Base64: string | null;
  baseVersionId: string | null;
  unusedKeys: string[];
  /** The call that completed the session. */
  finishedBy?: string;
  /**
   * Set by deleteFile on a completed session once the file is being deleted
   * (with fileDeletedAt and the session's completionClaim FILE_DELETED_CLAIM,
   * the expiry sweep's record of it).
   */
  fileDeleted?: boolean;
  fileDeletedAt?: string;
}

// The completionClaim deleteFile writes on a completed session of a file it
// deletes: the expiry sweep's record of the publication whose late rows it
// removes (see cleanupExpiredSessions). Mirrored in files/service.ts.
export const FILE_DELETED_CLAIM = 'file-deleted';

// Thrown inside rollForward when the session no longer holds the publication a
// call read (another call rewrote, completed or refused it).
class PublicationMoved extends Error {
  constructor(readonly current: UploadSession | null) {
    super('Upload session publication moved on');
  }
}

/** The account a file's storage is charged to (see quotaAccountFor). */
type QuotaAccount = { principalId?: string; tenantId?: string };

type PublishOutcome =
  | { kind: 'completed'; storageKey: string; quotaAccount: QuotaAccount }
  | { kind: 'refused' }
  | { kind: 'other'; current: UploadSession | null };

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
  // it stitches into an object of its own (attemptStorageKey), and it publishes
  // or refuses only through a write conditional on its claim (the move to
  // 'publishing', fenceRefusedSession), so one taken over writes no file or
  // version row.
  function isStaleClaim(session: UploadSession): boolean {
    const claimedAtMs = Date.parse((session.completionClaim ?? '').split(' ')[0].split('/')[0]);
    return Number.isNaN(claimedAtMs) || Date.now() - claimedAtMs >= completionTimeoutMs;
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
  // ends in " retake", so its proxy stitch uses a key of its own, followed by
  // the nonces of the earlier retakes whose stitched objects may remain
  // (comma-separated), so every one of them stays known until deleted.
  async function claimCompletion(session: UploadSession): Promise<{ claim: string } | { current: UploadSession | null }> {
    const nonce = randomBytes(6).toString('hex');
    let claim = `${new Date().toISOString()} ${nonce}`;
    if (session.completionClaim) {
      const [, previousNonce, previousRetake, history] = session.completionClaim.split(' ');
      const nonces = [...(history ? history.split(',') : []), ...(previousRetake === 'retake' && previousNonce ? [previousNonce] : [])];
      claim += nonces.length > 0 ? ` retake ${nonces.join(',')}` : ' retake';
    }
    const outcome = await updateSessionIf(
      session.uploadSessionId,
      { status: session.status, completionClaim: session.completionClaim ?? null },
      { status: 'completing', completionClaim: claim },
      (row) => row.status === 'completing' && row.completionClaim === claim,
    );
    return outcome.applied ? { claim } : { current: outcome.current };
  }

  // The claim of a 'publishing' session: the claim it moved there from (its
  // nonce and retake history, see attemptStorageKey) with a fresh random
  // revision after its time ("<time>/<revision> <nonce> ..."), written with
  // every move to 'publishing' and every rewrite of the publication. Writes
  // conditional on it apply only for a call holding the publication as it is
  // now, never for one that read an earlier decision, even one made within the
  // same millisecond.
  function claimNonce(claim: string | null | undefined): string {
    return (claim ?? '').split(' ').slice(1).join(' ');
  }
  function revisedClaim(claim: string | null): string {
    const [, ...rest] = (claim ?? `- ${randomBytes(6).toString('hex')}`).split(' ');
    return [`${new Date().toISOString()}/${randomBytes(6).toString('hex')}`, ...rest].join(' ');
  }

  // Returns a claimed session to the status it was claimed from, after its
  // completion failed before publishing anything (it never moved to
  // 'publishing'), so the client can retry or abort at once. A failed release
  // leaves the claim to lapse. The row keeps `keptClaim`: the claim whose
  // stitched object may still exist (this one's, or the one it took over when
  // it left no object of its own), so the next completion, an abort or the
  // expiry sweep can find and delete that object, and the next claim is a
  // retake that stitches elsewhere.
  async function releaseClaim(
    uploadSessionId: string,
    claim: string,
    status: UploadSession['status'],
    keptClaim: string | null = claim,
  ): Promise<void> {
    try {
      // Conditional and count-free: a no-op once the session left this claim.
      await db.updateMany({
        model: 'uploadSessions',
        where: [
          { field: 'uploadSessionId', operator: 'eq', value: uploadSessionId },
          { field: 'status', operator: 'eq', value: 'completing' },
          { field: 'completionClaim', operator: 'eq', value: claim },
        ],
        data: { status, completionClaim: keptClaim },
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
        ...(await quotaAccountFor(session.fileId, ctx, session)),
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

  // Every object a claim and the earlier retakes it records may have stitched.
  function claimStitchKeys(session: UploadSession, claim: string): string[] {
    const history = session.uploadMode === 'proxy' ? (claim.split(' ')[3] ?? '') : '';
    return [
      attemptStorageKey(session, claim),
      ...history.split(',').filter(Boolean).map((nonce) => `${session.storageKey}.c${nonce}`),
    ];
  }

  // Deletes a proxy object a completion stitched that the session's version
  // does not use (the completion lost its claim, failed or was refused). Only
  // the session's own publication could use such a key, so it is kept only when
  // that publication or version (or a read failure, or a session from before
  // per-session keys) leaves it in doubt. Returns whether it was deleted.
  async function deleteAttemptObject(session: UploadSession, key: string, target: StorageTargetName | undefined): Promise<boolean> {
    return (await removeAttemptObject(session, key, target)) === 'deleted';
  }

  // deleteAttemptObject's outcome: 'kept' when the object is not this
  // cleanup's to delete, 'failed' when a read or the delete failed (the
  // object may be left behind unreferenced).
  async function removeAttemptObject(
    session: UploadSession,
    key: string,
    target: StorageTargetName | undefined,
  ): Promise<'deleted' | 'kept' | 'failed'> {
    if (session.uploadMode !== 'proxy' || !storage.deleteObject || !session.completionVersionId) return 'kept';
    try {
      const now = await readSession(session.uploadSessionId);
      if (now?.completionPublication?.storageKey === key) return 'kept';
      const version = await db.findOne<{ storageKey: string }>({
        model: 'fileVersions',
        where: [{ field: 'versionId', operator: 'eq', value: session.completionVersionId }],
        namespace,
      });
      if (version?.storageKey === key) return 'kept';
      await storage.deleteObject({ key, target });
      return 'deleted';
    } catch {
      return 'failed';
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

  // Deletes the retake objects (`<storageKey>.c<nonce>`, this session's alone)
  // a refused session's claim or publication recorded. Returns false when a
  // delete failed: the session row is then kept for the expiry sweep.
  async function deleteRefusedAttemptObjects(session: UploadSession): Promise<boolean> {
    if (session.uploadMode !== 'proxy' || !storage.deleteObject) return true;
    const publication = session.completionPublication;
    const keys = new Set([
      ...(session.completionClaim ? claimStitchKeys(session, session.completionClaim) : []),
      ...(publication ? [publication.storageKey, ...publication.unusedKeys] : []),
    ]);
    const target = resolveStorageTarget(policies.get(session.policy) ?? {});
    let allDeleted = true;
    for (const key of keys) {
      if (!key.startsWith(`${session.storageKey}.c`)) continue;
      try {
        await storage.deleteObject({ key, target });
      } catch {
        allDeleted = false;
      }
    }
    return allDeleted;
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

  // Aborts the session's storage upload, deletes its proxy part objects and the
  // object its last claim stitched (released unpublished, see releaseClaim), and
  // ends it as aborted; a refused session is ended by fenceRefusedSession instead.
  async function discardSessionUpload(session: UploadSession): Promise<void> {
    await abortStorageUpload(session);
    await deleteProxyTempPartObjects(session);
    await deleteClaimStitch(session);
    await endSessionAborted(session.uploadSessionId);
  }

  // Deletes the objects the session's claims stitched, for a session no
  // completion can publish any more (aborted). Returns false when a delete
  // failed: the session row, which records them, is then kept for the sweep.
  async function deleteClaimStitch(session: UploadSession): Promise<boolean> {
    if (!session.completionClaim) return true;
    const target = resolveStorageTarget(policies.get(session.policy) ?? {});
    let allDeleted = true;
    for (const key of claimStitchKeys(session, session.completionClaim)) {
      if ((await removeAttemptObject(session, key, target)) === 'failed') allDeleted = false;
    }
    return allDeleted;
  }

  // A session an earlier FileFn (before the publication record) left partly
  // published: its file points at its version, but the session never reached
  // 'completed' (its version row may be missing). It is moved to 'publishing' with
  // the publication rebuilt from what was written, its base being its own
  // version (so its file is never moved off a later version), and finished
  // like any publication: never admitted (quota, parts), released, aborted or
  // expired again. Returns undefined for any other session, else the session
  // as it is now (adopted, or moved on first by another call).
  async function adoptLegacyPublication(session: UploadSession): Promise<UploadSession | null | undefined> {
    const versionId = session.completionVersionId;
    if (
      !versionId ||
      session.completionPublication ||
      session.status === 'publishing' ||
      session.status === 'completed' ||
      isAbortedStatus(session.status)
    ) {
      return undefined;
    }
    const version = await db.findOne<{ fileId: string; storageKey: string; checksumSha256Base64?: string | null }>({
      model: 'fileVersions',
      where: [{ field: 'versionId', operator: 'eq', value: versionId }],
      namespace,
    });
    const fileId = session.fileId ?? version?.fileId;
    if (!fileId) return undefined;
    const file = await db.findOne<{ currentVersionId: string }>({
      model: 'files',
      where: [{ field: 'fileId', operator: 'eq', value: fileId }],
      namespace,
    });
    if (file?.currentVersionId !== versionId) return undefined;
    // Without its version row, the version's bytes are the session's own
    // object, which an earlier FileFn's dedup may have deleted before it
    // created the file. Unless that object is confirmed in storage at its full
    // size, the session stays as it is (no completion, effects, abort or
    // expiry): a 409 to its callers, and the sweep checks it again.
    if (!version && !(await isStorageFinalized(session, resolveStorageTarget(policies.get(session.policy) ?? {})))) {
      throw errors.uploadCompletionInProgress();
    }
    const claim = revisedClaim(session.completionClaim ?? null);
    const adopted: Partial<UploadSession> = {
      status: 'publishing',
      fileId,
      completionClaim: claim,
      completionPublication: {
        versionId,
        storageKey: version?.storageKey ?? session.storageKey,
        checksumSha256Base64: version?.checksumSha256Base64 ?? null,
        baseVersionId: versionId,
        unusedKeys: [],
      },
    };
    const moved = await updateSessionIf(
      session.uploadSessionId,
      { status: session.status, completionClaim: session.completionClaim ?? null },
      adopted,
      (row) => row.status === 'publishing' && row.completionClaim === claim,
    );
    return moved.applied ? { ...session, ...adopted } : moved.current;
  }

  // Removes the files row still pointing at a publication's version and its
  // version row: what a completion call that resumed late wrote for a
  // publication nothing may keep (refused, or completed and its file deleted
  // since, see rollForward).
  async function deletePublicationRows(fileId: string, versionId: string): Promise<void> {
    await db.deleteMany({
      model: 'files',
      where: [
        { field: 'fileId', operator: 'eq', value: fileId },
        { field: 'currentVersionId', operator: 'eq', value: versionId },
      ],
      namespace,
    });
    await db.deleteMany({
      model: 'fileVersions',
      where: [{ field: 'versionId', operator: 'eq', value: versionId }],
      namespace,
    });
  }

  // Finishes a 'publishing' session, whichever completion call runs it (the
  // one that moved it there, or any later call of the session, also after
  // that one stalled or crashed). Every step is idempotent, so calls may
  // overlap: the version row (unique versionId) and the file pointing at it,
  // then 'completed', which one call wins (it alone runs the effects, see
  // finishCompletedSession). A call writes a row only while it still holds the
  // publication as it read it (its claim's revision, see revisedClaim), so a
  // call another one moved on writes nothing; a write already in flight then is
  // checked afterwards and removed again (see undoAfterDelete). A replacement
  // inserts its version first and then moves the file from the recorded base
  // version (compare-and-set), so the file never points at a missing version
  // and a call that resumes late never moves it back; a file another writer
  // moved on meanwhile keeps that writer's version, and this one stays in its
  // history. A new file is created first, recording this version as its origin
  // (files.originVersionId, never changed afterwards), the unique
  // `files.fileId` deciding between rivals. A file this publication created
  // and a later upload replaced meanwhile keeps that upload's version: this
  // one joins its history. No version joins a file another principal created:
  // a rival's file is written only with the caller's write permission (the base
  // is recorded again, under a new revision), otherwise the session is refused.
  // Database steps only; the caller holds the fileId key.
  async function rollForward(session: UploadSession, ctx: FileProviderContext): Promise<PublishOutcome> {
    const { uploadSessionId } = session;
    const fileId = session.fileId!;
    const findFile = () => db.findOne<{ currentVersionId: string; originVersionId?: string | null; ownerId?: string; tenantId?: string | null }>({
      model: 'files',
      where: [{ field: 'fileId', operator: 'eq', value: fileId }],
      namespace,
    });
    // A failed read of the session is retried before it fails the call.
    const readNow = async (): Promise<UploadSession | null> => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await readSession(uploadSessionId);
        } catch (err) {
          if (attempt >= 3) throw err;
        }
      }
    };
    for (;;) {
      const publication = session.completionPublication!;
      const claim = session.completionClaim ?? null;
      const { versionId, baseVersionId } = publication;
      const findOwnVersion = () => db.findOne<{ storageKey: string }>({
        model: 'fileVersions',
        where: [{ field: 'versionId', operator: 'eq', value: versionId }],
        namespace,
      });
      // Before each row write: the session still holds the publication as
      // this call read it. Otherwise the call goes on from the session as it
      // is now (see publishSession).
      const assertHeld = async (): Promise<void> => {
        const now = await readNow();
        if (now?.status !== 'publishing' || now.completionClaim !== claim) throw new PublicationMoved(now);
      };
      // Both return whether this call's insert created the row.
      const ensureVersion = async (): Promise<boolean> => {
        if (await findOwnVersion()) return false;
        await assertHeld();
        try {
          await db.create({
            model: 'fileVersions',
            data: {
              versionId,
              fileId,
              storageKey: publication.storageKey,
              mimeType: session.mimeType,
              size: session.size,
              checksumSha256Base64: publication.checksumSha256Base64,
              tenantId: session.tenantId,
              createdAt: new Date().toISOString(),
            },
            namespace,
          });
          return true;
        } catch (err) {
          // Another call of this session inserted it first.
          if (!(await findOwnVersion())) throw err;
          return false;
        }
      };
      // Creates the file at this version; a failed insert rethrows unless a
      // row exists after all (another writer's, or this session's).
      const createFile = async (): Promise<boolean> => {
        await assertHeld();
        const now = new Date().toISOString();
        try {
          await db.create({
            model: 'files',
            data: {
              fileId,
              currentVersionId: versionId,
              originVersionId: versionId,
              ownerId: session.ownerId,
              tenantId: session.tenantId,
              visibility: policies.get(session.policy)?.visibility || 'private',
              policy: session.policy,
              mimeType: session.mimeType,
              size: session.size,
              name: session.fileName,
              metadata: session.metadata ?? {},
              createdAt: now,
              updatedAt: now,
            },
            namespace,
          });
          return true;
        } catch (err) {
          if (!(await findFile())) throw err;
          return false;
        }
      };
      // A write in flight while another call completed the session and the
      // file was deleted since (deleteFile marks the completed session first),
      // or refused the publication (a rival's file, deleted since, was in the
      // way), creates a row nothing may keep. A row this call created is
      // checked against the session and removed again; one left by a call that
      // stopped in between (or whose check failed) is removed by the expiry
      // sweep, which keeps the record of both cases.
      const undoAfterDelete = async (created: boolean): Promise<UploadSession | null | undefined> => {
        if (!created) return undefined;
        const now = await readNow();
        // A session gone meanwhile was refused (or aborted) and swept: no
        // publishing or completed session is ever deleted.
        if (now && now.status !== 'refused' && !now.completionPublication?.fileDeleted) return undefined;
        await deletePublicationRows(fileId, versionId);
        return now;
      };

      const file = await findFile();
      let rewrite: Partial<UploadSession> | undefined;
      let undone: UploadSession | null | undefined;
      if (file?.currentVersionId === versionId) {
        undone = await undoAfterDelete(await ensureVersion());
      } else if (baseVersionId === null) {
        if (!file) {
          undone = await undoAfterDelete(await createFile());
          if (undone !== undefined) return { kind: 'other', current: undone };
          continue;
        }
        if (file.originVersionId === versionId) {
          // This publication created the file, and a later upload replaced
          // it meanwhile: its version joins the history.
          undone = await undoAfterDelete(await ensureVersion());
        } else {
          // Another writer created the file first.
          rewrite = (await canWriteFileNow(fileId, ctx))
            ? {
                completionClaim: revisedClaim(claim),
                completionPublication: { ...publication, baseVersionId: file.currentVersionId },
              }
            : { status: 'refused', completionClaim: revisedClaim(claim) };
        }
      } else {
        undone = await undoAfterDelete(await ensureVersion());
        if (undone !== undefined) return { kind: 'other', current: undone };
        if (!file) {
          // Deleted meanwhile: the upload creates it again.
          undone = await undoAfterDelete(await createFile());
          if (undone !== undefined) return { kind: 'other', current: undone };
          continue;
        }
        if (file.currentVersionId === baseVersionId) {
          await assertHeld();
          // Compare-and-set. A write that matched nothing (another writer
          // moved the file first) throws or returns nothing on some adapters:
          // the row read back decides, and a failed write of an unchanged row
          // rethrows.
          let failure: unknown;
          try {
            const moved = await db.update<unknown>({
              model: 'files',
              where: [
                { field: 'fileId', operator: 'eq', value: fileId },
                { field: 'currentVersionId', operator: 'eq', value: baseVersionId },
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
            if (moved) continue;
          } catch (err) {
            failure = err;
          }
          if ((await findFile())?.currentVersionId === baseVersionId) {
            throw failure ?? new Error(`Conditional update of file ${fileId} did not apply`);
          }
          continue;
        }
      }

      if (undone !== undefined) return { kind: 'other', current: undone };

      if (rewrite) {
        // Under a new revision, so a call still holding the decision it
        // replaces (even one rewritten within the same millisecond) writes
        // nothing more; then the row as written decides.
        const target = rewrite;
        const next = await updateSessionIf(
          uploadSessionId,
          { status: 'publishing', completionClaim: claim },
          target,
          (row) => row.status === (target.status ?? 'publishing') && row.completionClaim === (target.completionClaim ?? claim),
        );
        if (next.applied && target.status === 'refused') return { kind: 'refused' };
        const current = next.applied ? await readNow() : next.current;
        if (current?.status !== 'publishing') return { kind: 'other', current };
        session = current;
        continue;
      }

      // Calls finishing one publication share its claim, so the one that
      // completes it is told by a token of its own. The version's object is
      // read first: nothing may fail between completing the session and its
      // effects.
      const storageKey = (await findOwnVersion())?.storageKey || publication.storageKey;
      // The account the completion charges, fixed now from the published
      // file's owner (the session owner when this upload created it), so the
      // charge never depends on a later lookup the file may be deleted under.
      const published = await findFile();
      const quotaAccount: QuotaAccount = published?.ownerId
        ? { principalId: published.ownerId, tenantId: published.tenantId ?? undefined }
        : sessionQuotaAccount(session);
      const finishedBy = randomBytes(6).toString('hex');
      const finished = await updateSessionIf(
        uploadSessionId,
        { status: 'publishing', completionClaim: claim },
        { status: 'completed', completionVersionId: versionId, completionPublication: { ...publication, finishedBy } },
        (row) => row.status === 'completed' && row.completionPublication?.finishedBy === finishedBy,
      );
      if (finished.applied) return { kind: 'completed', storageKey, quotaAccount };
      if (finished.current?.status !== 'publishing') return { kind: 'other', current: finished.current };
      session = finished.current;
    }
  }

  // Finishes a 'publishing' session (rollForward, under the fileId key) and,
  // in the call that completed it, runs the completion's effects.
  async function publishSession(session: UploadSession, ctx: FileProviderContext): Promise<{ fileId: string; versionId: string }> {
    const fileId = session.fileId!;
    const publication = session.completionPublication!;
    const outcome = await runSerialized(
      fileCommitLock.fileKey(fileId),
      async (): Promise<PublishOutcome> => {
        for (let current = session; ;) {
          try {
            return await rollForward(current, ctx);
          } catch (err) {
            if (!(err instanceof PublicationMoved)) throw err;
            if (err.current?.status !== 'publishing') return { kind: 'other', current: err.current };
            current = err.current;
          }
        }
      },
      { ...fileKeyOptions(session), keepWaiting: true },
    );
    if (outcome.kind === 'other') return lostClaimResult(session.uploadSessionId, outcome.current);
    if (outcome.kind === 'refused') {
      // Nothing was published: the rival's file never pointed at the version.
      // A retake object left behind is deleted by the expiry sweep.
      await deleteRefusedAttemptObjects(session);
      await deleteRefusedUploads(session);
      throw errors.forbidden({ fileId, operation: 'replace' });
    }
    await finishCompletedSession(session, fileId, publication, outcome.storageKey, outcome.quotaAccount, ctx);
    return { fileId, versionId: publication.versionId };
  }

  // The account a file's storage is charged to: its owner. Usage is recorded
  // and refunded (when the file is deleted) against the same account, so a
  // writer with a grant adds to the owner's usage, not their own.
  // A session's own account: the owner and tenant it was created for.
  function sessionQuotaAccount(session: Pick<UploadSession, 'ownerId' | 'tenantId'>): QuotaAccount {
    return { principalId: session.ownerId || 'anonymous', tenantId: session.tenantId ?? undefined };
  }

  async function quotaAccountFor(
    fileId: string | null | undefined,
    ctx: FileProviderContext,
    session?: Pick<UploadSession, 'ownerId' | 'tenantId'>,
  ): Promise<QuotaAccount> {
    if (fileId) {
      const file = await db.findOne<{ ownerId: string; tenantId?: string | null }>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });
      if (file) {
        return { principalId: file.ownerId, tenantId: file.tenantId ?? undefined };
      }
    }
    // A new file belongs to the session's owner, whoever completes it.
    if (session) return sessionQuotaAccount(session);
    return { principalId: ctx.principalId || 'anonymous', tenantId: ctx.tenantId };
  }

  // The effects of a completion, run once by the call that completed the
  // session: usage, the file:uploaded event and processing. Cleanup runs after
  // the usage and the event and never stops them: a proxy part object that
  // cannot be deleted keeps its part row, which the expiry sweep finishes.
  async function finishCompletedSession(
    session: UploadSession,
    fileId: string,
    publication: CompletionPublication,
    storageKey: string,
    quotaAccount: QuotaAccount,
    ctx: FileProviderContext,
  ): Promise<void> {
    const { uploadSessionId } = session;
    const { versionId } = publication;
    if (quota) {
      await quota.recordUsage({ ...quotaAccount, bytes: session.size });
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

    logger?.info('Upload session completed', { uploadSessionId, fileId, versionId, requestId: ctx.requestId });

    try {
      await deleteCompletedParts(session);
      // The session's objects the version does not use (see the publication).
      const target = resolveStorageTarget(policies.get(session.policy) ?? {});
      for (const key of publication.unusedKeys) {
        if (key === storageKey || !storage.deleteObject) continue;
        await storage.deleteObject({ key, target }).catch(() => {});
      }
    } catch (err) {
      logger?.warn('Upload session cleanup failed; the expiry sweep retries it', {
        uploadSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (processingService) {
      await processingService.triggerProcessing({
        fileId,
        versionId,
        storageKey,
        mimeType: session.mimeType,
        size: session.size,
        fileName: session.fileName,
        tenantId: session.tenantId || undefined,
      }, ctx);
    }
  }

  // Deletes a completed session's proxy part objects, then its part rows (kept
  // while any object delete failed).
  async function deleteCompletedParts(session: UploadSession): Promise<void> {
    if (!(await deleteProxyTempPartObjects(session))) return;
    await db.deleteMany({
      model: 'uploadParts',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId }],
      namespace,
    });
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
          ...(await quotaAccountFor(requestedFileId, ctx)),
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
          : session.status === 'completing' || session.status === 'publishing' ? 'in_progress' : session.status,
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
      if (session.status === 'completing' || session.status === 'publishing') throw errors.uploadCompletionInProgress();
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
      if (session.status === 'completing' || session.status === 'publishing') throw errors.uploadCompletionInProgress();
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
      if (session.status === 'completing' || session.status === 'publishing') throw errors.uploadCompletionInProgress();
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
      // call holds (in another process: calls in this one run one at a time,
      // see below) is polled until that call ends, for at most
      // SERIALIZED_WAIT_TIMEOUT_MS; its recorded result is then returned. A
      // claim past the completion timeout is taken over. A 'publishing'
      // session is finished at once, even past its expiry: what it publishes
      // is decided, and any completion call may finish it (publishSession).
      const waitUntil = Date.now() + SERIALIZED_WAIT_TIMEOUT_MS;
      let claim: string | undefined;
      let parts: Array<{ partNumber: number; etag: string }> = [];
      while (claim === undefined) {
        if (isAbortedStatus(session.status)) throw errors.uploadAborted();
        if (session.status === 'completed') return recordedResult(session);
        if (session.status === 'publishing') return publishSession(session, ctx);
        if (!(session.status === 'completing' && !isStaleClaim(session))) {
          // A partly published session of an earlier FileFn is finished as published.
          const adopted = await adoptLegacyPublication(session);
          if (adopted !== undefined) {
            if (!adopted) throw errors.sessionNotFound();
            session = adopted;
            continue;
          }
        }
        if (isExpiredAt(session.expiresAt)) throw errors.uploadExpired();

        let current: UploadSession | null;
        if (session.status === 'completing' && !isStaleClaim(session)) {
          if (Date.now() >= waitUntil) throw errors.uploadCompletionInProgress();
          await delay(COMPLETION_POLL_INTERVAL_MS);
          current = await readSession(uploadSessionId);
        } else {
          const admission = await admitCompletion(session, ctx);
          if ('error' in admission) {
            // Checked against a session another call may have moved on
            // meanwhile: decide again from the session as it is now.
            const fresh = await readSession(uploadSessionId);
            if (!fresh) throw errors.sessionNotFound();
            if (fresh.status !== session.status || fresh.completionClaim !== session.completionClaim) {
              session = fresh;
              continue;
            }
            // A stale claim this call cannot take over is ended (claimed and
            // released at once, the row keeping the stale claim for the object
            // it may have stitched), so the owner can abort the session instead
            // of waiting for it to expire. A stale holder that moved on
            // meanwhile (to 'publishing', or completed) makes the end-claim
            // lost: decide again from the session as it is now.
            if (session.status === 'completing') {
              const ended = await claimCompletion(session);
              if (!('claim' in ended)) {
                if (!ended.current) throw errors.sessionNotFound();
                session = ended.current;
                continue;
              }
              await releaseClaim(uploadSessionId, ended.claim, 'in_progress', session.completionClaim ?? null);
            }
            throw admission.error;
          }
          parts = admission.parts;
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

      // A failure before the move to 'publishing' (this call writes nothing
      // else) returns the session to the status it was claimed from
      // ('in_progress' for a claim taken over from a stale one, whose parts
      // were all recorded), so it can be retried or aborted at once, and
      // deletes a proxy object it stitched. A failure after it leaves the
      // session 'publishing' for the next completion call to finish; no abort,
      // release or expiry ends it meanwhile. A call that failed after its claim
      // was taken over and the session completed returns the recorded result.
      const claimedSession = session;
      let stitchedKey: string | undefined;
      const claimedTarget = (() => {
        const claimedPolicy = policies.get(claimedSession.policy);
        return claimedPolicy ? resolveStorageTarget(claimedPolicy) : undefined;
      })();
      const discardStitched = async (): Promise<boolean> =>
        stitchedKey === undefined || deleteAttemptObject(claimedSession, stitchedKey, claimedTarget);
      try {
        return await completeClaimedSession(session, claim, parts);
      } catch (err) {
        const discarded = await discardStitched();
        const now = await readSession(uploadSessionId).catch(() => undefined);
        // Completed by another call (a claim of another nonce): its result.
        // An error of this call's own publication (its effects) is rethrown.
        if (now?.status === 'completed' && claimNonce(now.completionClaim) !== claimNonce(claim)) {
          return recordedResult(now);
        }
        if (now?.status === 'completing' && now.completionClaim === claim) {
          const releasedStatus = claimedSession.status === 'completing' ? 'in_progress' : claimedSession.status;
          // A stitch left behind keeps this claim, so the next call deletes it.
          await releaseClaim(uploadSessionId, claim, releasedStatus, discarded ? claimedSession.completionClaim ?? null : claim);
        }
        throw err;
      }

      async function completeClaimedSession(
        session: UploadSession,
        claim: string,
        parts: Array<{ partNumber: number; etag: string }>,
      ): Promise<{ fileId: string; versionId: string }> {
        const policy = policies.get(session.policy);
        const policyStorageTarget = policy ? resolveStorageTarget(policy) : undefined;
        // The object this call finalizes, and the one the claim it took over (or
        // followed) finalized: see attemptStorageKey.
        const attemptKey = attemptStorageKey(session, claim);
        const predecessorKey = session.completionClaim ? attemptStorageKey(session, session.completionClaim) : undefined;

        const fileId = session.fileId || generateFileFnId('file');
        // Publish the version allocated at init, whose ID is part of the storage key.
        // Sessions created before init allocated it have none, so mint one for
        // them; the move to 'publishing' records it before anything uses it.
        const versionId = session.completionVersionId || generateFileFnId('ver');

        const findFile = () => db.findOne<{ fileId: string; currentVersionId: string }>({
          model: 'files',
          where: [{ field: 'fileId', operator: 'eq', value: fileId }],
          namespace,
        });
        // A files row pointing at this session's own versionId was written by this
        // session (as an earlier version of FileFn published), never by a rival.
        const isOwnRow = (file: { currentVersionId: string } | null) => file?.currentVersionId === versionId;
        const fileKey = fileCommitLock.fileKey(fileId);

        // Refuse early, before any storage completion, when the file already exists
        // and the caller cannot write it (for example a session whose init ran
        // before another principal created the file). Nothing the session uploaded
        // is kept, including a final object an interrupted attempt left.
        if (session.fileId) {
          const current = await findFile();
          if (current && !isOwnRow(current) && !(await canWriteFileNow(fileId, ctx))) {
            // Refused only while this call still holds the session: one
            // whose claim was taken over refuses and deletes nothing.
            if (!(await fenceRefusedSession(uploadSessionId, claim))) return lostClaimResult(uploadSessionId);
            await abortStorageUpload(session);
            await deleteRefusedUploads(session);
            throw errors.forbidden({ fileId, operation: 'replace' });
          }
        }

        // Before storage completion, wait for a commit of this fileId that is
        // already running. A stuck one makes this call fail with the retryable
        // 409 while it has changed nothing; only a commit that starts during this
        // call's own storage step can keep it waiting below.
        await runSerialized(fileKey, async () => {}, { ...fileKeyOptions(session), evictableAt: undefined });

        // Finalize storage. A proxy stitch writes only this call's own object
        // (attemptKey), so a holder that stalled past the completion timeout
        // and was taken over cannot rewrite or truncate the object the call that
        // took over published, even with its I/O already in flight; the claim
        // checks before each storage step only save it work. Multipart
        // completion assembles the same recorded parts whoever runs it; a call
        // that finds the upload already consumed by an earlier holder of the
        // session goes on from the object it left.
        if (
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
        if (storage.statObject) {
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

        // Check for deduplication
        let finalStorageKey = attemptKey;
        let checksumSha256Base64: string | null = null;

        if (dedup && dedup.isEnabled()) {
          const dedupResult = await dedup.computeAndCheckDuplicate(
            attemptKey,
            session.tenantId,
            policyStorageTarget ?? null,
            storage
          );

          checksumSha256Base64 = dedupResult.checksumSha256Base64;

          if (dedupResult.isDuplicate && dedupResult.existingStorageKey) {
            // Reuse existing storage key (reference to existing object). This
            // call's own object is deleted once the session is completed (it
            // is in the publication's unusedKeys), so a call that takes the
            // session over after this one stalled or crashed still finds it.
            finalStorageKey = dedupResult.existingStorageKey;
          }
        }

        // Publish. Under the fileId key (only database steps, see
        // runSerialized above), decide against the file as it is now, refusing
        // a file the caller cannot write, and move the session to 'publishing'
        // with that decision recorded (completionPublication) before any file
        // or version row is written. The move is conditional on this call's
        // claim, so a call taken over (it ran past the completion timeout)
        // writes nothing. From it on, the session is never released, aborted or
        // expired, and any completion call finishes it (publishSession).
        // This claim's history names the earlier retakes' objects.
        const unused = new Set([attemptKey, ...claimStitchKeys(session, claim).slice(1)]);
        if (session.completionVersionId) {
          // Sessions from before per-session keys may share their key.
          unused.add(session.storageKey);
          if (predecessorKey !== undefined) unused.add(predecessorKey);
        }
        unused.delete(finalStorageKey);
        const publication: CompletionPublication = {
          versionId,
          storageKey: finalStorageKey,
          checksumSha256Base64,
          baseVersionId: null,
          unusedKeys: [...unused],
        };
        const publishingClaim = revisedClaim(claim);
        const decision = await runSerialized(fileKey, async (): Promise<'publishing' | 'refused' | 'lost'> => {
          const current = await findFile();
          if (current && !isOwnRow(current) && !(await canWriteFileNow(fileId, ctx))) {
            // Fenced under the key; its storage deletes run after release.
            return (await fenceRefusedSession(uploadSessionId, claim)) ? 'refused' : 'lost';
          }
          publication.baseVersionId = current?.currentVersionId ?? null;
          const moved = await updateSessionIf(
            uploadSessionId,
            { status: 'completing', completionClaim: claim },
            { status: 'publishing', fileId, completionClaim: publishingClaim, completionPublication: publication },
            (row) => row.status !== 'completing' && row.completionClaim === publishingClaim,
          );
          return moved.applied ? 'publishing' : 'lost';
        }, { ...fileKeyOptions(session), keepWaiting: true });

        if (decision === 'lost') {
          await discardStitched();
          const now = await readSession(uploadSessionId);
          // Taken over and published by another call: help finish it.
          if (now?.status === 'publishing') return publishSession(now, ctx);
          return lostClaimResult(uploadSessionId, now);
        }
        if (decision === 'refused') {
          // The session's own object is deleted (or kept for the sweep) here;
          // a retake's stitch only this call knows of.
          await deleteRefusedUploads(session);
          if (attemptKey !== session.storageKey) await discardStitched();
          stitchedKey = undefined;
          throw errors.forbidden({ fileId, operation: 'replace' });
        }
        return publishSession(
          { ...session, status: 'publishing', fileId, completionClaim: publishingClaim, completionPublication: publication },
          ctx,
        );
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
        // Held by a completion, or publishing: a completion call finishes it.
        if (session.status === 'completing' || session.status === 'publishing') {
          throw errors.uploadCompletionInProgress();
        }
        // Already ended. A refused session may still have objects to delete; its
        // row records them for the expiry sweep, so leave it in place.
        if (isAbortedStatus(session.status)) return;
        // A partly published session of an earlier FileFn is finished by a
        // completion call (or the sweep), never aborted.
        const adopted = await adoptLegacyPublication(session);
        if (adopted !== undefined) {
          if (!adopted) throw errors.sessionNotFound();
          session = adopted;
          continue;
        }

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
        // A 'publishing' session is finished by its next completion call, even
        // past its expiry (the file may already point at its version), and a
        // 'completing' one whose claim is live is still running: the sweep
        // leaves both. A stale claim's holder writes nothing once the sweep
        // deleted its row (see the conditional delete below).
        const unfinished = await db.findMany<UploadSession>({
            model: 'uploadSessions',
            where: [
                { field: 'expiresAt', operator: 'lt', value: now },
                { field: 'status', operator: 'ne', value: 'completed' }
            ],
            namespace
        });
        // A partly published session of an earlier FileFn is adopted as a
        // publication (adoptLegacyPublication) and finished with them; one
        // whose check fails is left for the next sweep.
        const toFinish: UploadSession[] = [];
        const expiredSessions: UploadSession[] = [];
        for (const session of unfinished) {
            if (session.status === 'publishing') {
                toFinish.push(session);
                continue;
            }
            if (session.status === 'completing' && !isStaleClaim(session)) continue;
            // A refused publication is cleaned up once the completion timeout
            // has passed since the refusal (its claim time, see rollForward);
            // its record is kept for good (see below).
            if (session.status === 'refused' && session.completionPublication && !isStaleClaim(session)) continue;
            let adopted: UploadSession | null | undefined;
            try {
                adopted = await adoptLegacyPublication(session);
            } catch {
                continue;
            }
            if (adopted === undefined) expiredSessions.push(session);
            else if (adopted?.status === 'publishing') toFinish.push(adopted);
        }
        // Nobody finished it: the sweep finishes it, as its owner's completion
        // call would (a failure leaves it for the next sweep).
        for (const session of toFinish) {
            const ownerCtx = { principalId: isAnonymousSession(session) ? undefined : session.ownerId, tenantId: session.tenantId ?? undefined };
            await publishSession(session, ownerCtx).catch((err: unknown) => {
                logger?.warn('Expired upload session publication not finished; the next sweep retries it', {
                    uploadSessionId: session.uploadSessionId,
                    error: err instanceof Error ? err.message : String(err),
                });
            });
        }

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
            // A refused publication's storage was finalized before its move to
            // 'publishing': no multipart upload is left to abort.
            if (session.storageUploadId && storage.abortMultipartUpload && !(session.status === 'refused' && session.completionPublication)) {
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

            // A refused publication's rows a completion call created and did
            // not remove again (see rollForward).
            const refusedVersionId = session.status === 'refused' ? session.completionPublication?.versionId : undefined;
            if (refusedVersionId && session.fileId) {
                await deletePublicationRows(session.fileId, refusedVersionId);
            }

            // If a part object or a refused session's final object cannot be
            // deleted, keep the session and its part rows for the next sweep.
            const partsDeleted = await deleteProxyTempPartObjects(session);
            const objectDeleted = session.status === 'refused'
                ? (await deleteOwnUnpublishedObject(session, referencedRefs)) && (await deleteRefusedAttemptObjects(session))
                : true;
            if (!partsDeleted || !objectDeleted) {
                continue;
            }
            // A refused publication's record is never deleted: a completion
            // call may resume after any delay and write its rows, which every
            // later sweep removes (above). Its parts and objects are deleted.
            if (session.status === 'refused' && session.completionPublication) {
                await db.deleteMany({
                    model: 'uploadParts',
                    where: [{ field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId }],
                    namespace
                });
                continue;
            }
            // A proxy session's claims may have stitched objects, which its
            // row records. It is first ended as aborted while it still has the
            // status and claim this sweep read (a stale holder that moved it on
            // meanwhile keeps it, and one that did not can no longer publish),
            // then those objects are deleted; the row stays for the next sweep
            // while a delete fails.
            let status = session.status;
            if (status !== 'refused' && session.uploadMode === 'proxy' && session.completionClaim) {
                if (status !== 'aborted') {
                    const fenced = await updateSessionIf(
                        session.uploadSessionId,
                        { status, completionClaim: session.completionClaim },
                        { status: 'aborted' },
                        (row) => row.status === 'aborted',
                    ).catch(() => ({ applied: false as const }));
                    if (!fenced.applied) continue;
                    status = 'aborted';
                }
                if (!(await deleteClaimStitch(session))) continue;
            }
            // Only while it still has the status this sweep read (or ended it
            // with): a session refused meanwhile keeps its row, the record of
            // what to delete, and so does one a completion moved on (to
            // 'publishing' or 'completed'). An expired session is never claimed
            // anew, so a completion of it that loses its row here writes nothing.
            const removed = await db.deleteMany({
                model: 'uploadSessions',
                where: [
                    { field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId },
                    { field: 'status', operator: 'eq', value: status },
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

        // Rows a completion call resuming late wrote for a completed
        // publication whose file was deleted since, and did not remove again
        // (see rollForward). deleteFile records such a session (its claim),
        // and the record is kept: a completion call may resume after any
        // delay, so every sweep removes such rows again.
        const deletedPublications = await db.findMany<UploadSession>({
            model: 'uploadSessions',
            where: [
                { field: 'status', operator: 'eq', value: 'completed' },
                { field: 'completionClaim', operator: 'eq', value: FILE_DELETED_CLAIM },
            ],
            namespace
        });
        for (const session of deletedPublications) {
            const publication = session.completionPublication;
            try {
                if (publication && session.fileId) await deletePublicationRows(session.fileId, publication.versionId);
            } catch (err) {
                logger?.warn('Deleted file\'s late publication rows not removed; the next sweep retries it', {
                    uploadSessionId: session.uploadSessionId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        // Part rows a completed session kept because a part object delete
        // failed (see finishCompletedSession).
        const partRows = await db.findMany<{ uploadSessionId: string }>({
            model: 'uploadParts',
            where: [],
            select: ['uploadSessionId'],
            namespace
        });
        for (const uploadSessionId of new Set(partRows.map((part) => part.uploadSessionId))) {
            const session = await readSession(uploadSessionId);
            if (session?.status === 'completed') await deleteCompletedParts(session);
        }

        return { deletedSessions, abortedMultipart };
    }
  };

  // Calls completing one session run one at a time in this process, so a
  // retried call never finalizes storage or refuses alongside another call of
  // the same session; it reads the result the earlier call recorded. Across
  // processes the session's 'completing' claim does the same (see
  // completeSession). Once the call has run past the completion timeout (or
  // the session has expired), its key may be taken by a call that has waited
  // out SERIALIZED_WAIT_TIMEOUT_MS: that call finds the call's claim stale and
  // takes the session over (or reports it expired), as a call in another
  // process would. Sessions of one fileId run their storage steps concurrently (each
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
    const staleAtMs = Date.now() + completionTimeoutMs;
    return runSerialized(`session\u0000${namespace}\u0000${uploadSessionId}`, complete, {
      evictableAt: Number.isNaN(expiresAtMs) ? staleAtMs : Math.min(expiresAtMs, staleAtMs),
    });
  };

  return service;
}

export type UploadSessionService = ReturnType<typeof createUploadSessionService>;

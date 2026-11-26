import type { PendingLocalDescriptor, UploadResult } from '../types.js';
import type { PendingLocalSourceMetadata } from '../preprocessing/types.js';
import {
  isConfirmedSessionEnd,
  REPLAY_SCOPE_MISMATCH_ERROR,
  assertValidExplicitFileId,
  isValidIdempotencyKey,
  isReplayScope,
  derivePendingLocalSource,
  generateFileId,
} from '../upload-manager.js';
import { decodeFileFnBody, uploadSchemas } from '../client.js';
import { OPFSStore } from './opfs-store.js';

/**
 * Durable, principal-scoped offline queue.
 *
 * Each queue instance is bound to one partition (a service and a principal or
 * guest namespace) for its whole life. Every journal write, replay claim and
 * cleanup runs under one exclusive lock per partition, shared by every tab of
 * the origin. Each entry is processed under its own exclusive lock, taken only
 * when free, so two tabs never drive one entry at once and a tab that closes
 * releases it to the next. See the FileFn offline documentation for the full
 * contract.
 */

const JOURNAL_VERSION = 1;
const JOURNAL_FILE = 'journal.json';
const PARTITION_META_FILE = 'partition.json';
const LAYOUT_DIR = 'v1';
const ID_MAX_LENGTH = 512;

export const DEFAULT_OFFLINE_QUEUE_LIMITS = {
  maxEntries: 500,
  maxBytes: 1024 * 1024 * 1024,
} as const;
export const DEFAULT_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_UPLOAD_ATTEMPTS = 5;
export const DEFAULT_OBSERVE_INTERVAL_MS = 1000;

export type OfflineQueuePrincipal =
  | { kind: 'user'; principalId: string; tenantId?: string }
  | { kind: 'guest'; namespace: string };

/** Trusted, caller-supplied identity of a queue partition. */
export interface OfflineQueuePartition {
  serviceId: string;
  principal: OfflineQueuePrincipal;
}

/** An exclusive lock manager with the shape of `navigator.locks`. */
export interface OfflineQueueLockCoordinator {
  request<T>(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>;
}

/** The subset of `FileSystemDirectoryHandle` the queue uses. */
export interface OfflineQueueDirectoryHandle {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OfflineQueueDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OfflineQueueFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterable<{ kind: 'file' | 'directory'; name: string }>;
}

export interface OfflineQueueFileHandle {
  getFile(): Promise<Blob>;
  createWritable(): Promise<{
    write(data: ArrayBuffer | string): Promise<void>;
    close(): Promise<void>;
    /** Discards the writable without changing the file (OPFS). */
    abort?(): Promise<void>;
  }>;
}

export interface OfflineQueueLimits {
  /** Entries (journals) the partition may hold. */
  maxEntries?: number;
  /** Bytes of staged data the partition may hold. */
  maxBytes?: number;
}

export interface OfflineQueueUploader {
  /**
   * The account scope every replay of a generation is bound to (the built-in
   * transport: `offline.replayAccount`'s scope). When present, the queue
   * resolves it before each upload step and, the first time, journals it with
   * the generation's replay identity in the same write that claims the step,
   * before any request. Every send then uses the journaled scope
   * (`replayScope`). A later result that differs from it sends nothing: the
   * generation stays provisional (`FILEFN_REPLAY_SCOPE_MISMATCH`) under the
   * same key. A rejection sends nothing either (a principal mismatch stops
   * the pass; anything else leaves the generation provisional).
   */
  replayScope?(principal: OfflineQueuePrincipal, signal: AbortSignal): Promise<string>;
  upload(input: {
    policy: string;
    file: File;
    fileName: string;
    metadata?: Record<string, unknown>;
    fileId: string;
    idempotencyKey: string;
    signal: AbortSignal;
    /**
     * Resolves when the credentials still act for the partition's principal,
     * else rejects with FILEFN_QUEUE_PRINCIPAL_MISMATCH. Call it immediately
     * before every request and retry (the built-in transport does), so no
     * request carries another account's credentials.
     */
    assertPrincipal(): Promise<void>;
    /**
     * The scope journaled with the generation's replay identity (see
     * `replayScope()` above), present whenever the uploader resolves one.
     * The built-in transport sends it on every `upload/init`, the first
     * included, so the server refuses a replay that resolves to no account
     * or another one, creating nothing.
     */
    replayScope?: string;
  }): Promise<UploadResult>;
}

export interface OfflineQueueOperationContext {
  partition: OfflineQueuePartition;
  entryId: string;
  generation: number;
  /** Stable identity of this generation's verification and publication. */
  operationId: string;
  fileId: string;
  versionId: string;
  /** The publication attempt a `publish.run` or `publish.reconcile` call belongs to. */
  publicationAttemptId?: string;
  signal: AbortSignal;
  /** See `OfflineQueueUploader`: call it right before a request that uses the principal's credentials. */
  assertPrincipal(): Promise<void>;
}

export type OfflineQueueVerification = { verified: true } | { verified: false; reason: string };
export type OfflineQueuePublicationCheck = { published: true; result?: unknown } | { published: false };
/**
 * A verified outcome of one publication attempt, for `OfflineQueue.reconcile`.
 * `attemptId` is the entry's `publicationAttemptId`: an outcome of an earlier
 * attempt is refused (FILEFN_QUEUE_STALE_ATTEMPT).
 */
export type OfflineQueuePublicationOutcome = OfflineQueuePublicationCheck & { attemptId: string };

export interface OfflineQueueHooks {
  /**
   * Confirms an uploaded generation. Only a plain `{ verified: true }` or
   * `{ verified: false, reason? }` (string reason) decides; a throw or any
   * other value leaves it provisional and it is verified again.
   */
  verify?(context: OfflineQueueOperationContext): Promise<OfflineQueueVerification>;
  publish?: {
    /**
     * Publishes a verified generation. Resolve with nothing, or with a plain
     * object whose only keys are `result` (exact JSON) and, optionally,
     * `published: true`: any other value (false, null, a primitive, a Date,
     * Map or class instance, `{ published: false }`, another key, a result
     * that does not survive a JSON round trip unchanged) confirms nothing and
     * leaves the publication unconfirmed, like a throw.
     */
    run(context: OfflineQueueOperationContext): Promise<{ result?: unknown } | void>;
    /**
     * Reports whether an earlier, unconfirmed `run` for this operation took
     * effect. Called before any retry of `run`, never while a `run` this
     * queue started is still running in a live tab. `published: false` must
     * mean the attempt cannot take effect later. A check that is not a plain
     * `{ published: true, result? }` or `{ published: false }` confirms nothing.
     */
    reconcile?(context: OfflineQueueOperationContext): Promise<OfflineQueuePublicationCheck>;
    /**
     * `run` has the same effect when called again with the same `operationId`.
     * Without this or `reconcile`, an unconfirmed publication is never retried
     * on its own: call `OfflineQueue.reconcile` with the outcome.
     */
    idempotent?: boolean;
  };
}

/**
 * Reports the principal the uploader's and hooks' credentials act for right
 * now (null when signed out). The queue calls it before every request of an
 * upload, before claiming a step, before recording any outcome and before
 * every local read or write of the partition. Work runs only while it matches
 * the partition's principal, so staged work never runs under, and is never
 * shown to, another account (for example after an account switch in another
 * tab that shares cookies). It must not call the queue.
 */
export type OfflineQueueCurrentPrincipal = (
  signal: AbortSignal,
) => OfflineQueuePrincipal | null | undefined | Promise<OfflineQueuePrincipal | null | undefined>;

export interface OfflineQueueOptions {
  partition: OfflineQueuePartition;
  uploader: OfflineQueueUploader;
  /** Required: see `OfflineQueueCurrentPrincipal`. */
  currentPrincipal: OfflineQueueCurrentPrincipal;
  /**
   * Verification and publication hooks. Which of them a generation needs is
   * recorded when it is staged; an instance without a recorded hook leaves the
   * generation provisional (`hook-unavailable`) instead of skipping the step.
   */
  hooks?: OfflineQueueHooks;
  /** Lock manager to use when `navigator.locks` is absent; it must exclude every cooperating tab. */
  coordinator?: OfflineQueueLockCoordinator;
  /** OPFS directory holding the queue. Defaults to `filefn-offline-queue`. */
  rootDir?: string;
  /** Directory of pre-0.5 unscoped uploads, read only by the explicit legacy calls. */
  legacyRootDir?: string;
  /** Storage root. Defaults to `navigator.storage.getDirectory()`. */
  getRoot?: () => Promise<OfflineQueueDirectoryHandle>;
  limits?: OfflineQueueLimits;
  terminalRetentionMs?: number;
  maxUploadAttempts?: number;
  /** How often entries with `whenSettled` waiters are re-read, to see other tabs' progress. */
  observeIntervalMs?: number;
  /**
   * Opens the channel on which the queues of every tab of the partition
   * announce runnable work (a staging, a released hold, a reconcile, a queue
   * disposed with work left), so a started `OfflineSync` in another tab runs
   * a pass at once. Defaults to `BroadcastChannel`; return undefined for none
   * (a sync then finds other tabs' work on its idle polls).
   */
  channel?: (name: string) => OfflineQueueChannel | undefined;
}

/** A cross-tab message channel: the part of `BroadcastChannel` the queue uses. */
export interface OfflineQueueChannel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data?: unknown }) => void): void;
  close(): void;
}

export interface OfflineQueueCapabilities {
  /** Whether durable queue operations can run. */
  durable: boolean;
  storage: 'opfs' | 'custom' | 'unavailable';
  locks: 'web-locks' | 'coordinator' | 'unavailable';
  reason?: 'storage-unavailable' | 'locks-unavailable';
}

export type OfflineQueuePhase =
  | 'staged'
  | 'uploading'
  | 'uploaded'
  | 'verifying'
  | 'verified'
  | 'publishing'
  | 'published'
  | 'rejected'
  | 'failed';

export interface OfflineQueuePending {
  stage: 'upload' | 'verification' | 'publication';
  /**
   * `scope-unconfirmed`: the replay account's scope could not be resolved, or
   * differs from the one journaled with the generation. Nothing was sent and
   * no attempt was used; a pass resumes it once the scope matches again.
   */
  reason: 'ambiguous' | 'needs-reconcile' | 'retry-limit' | 'scope-unconfirmed';
  message?: string;
}

export interface OfflineQueueEntry {
  entryId: string;
  generation: number;
  operationId: string;
  fileId: string;
  policy: string;
  fileName: string;
  mimeType: string;
  size: number;
  metadata?: Record<string, unknown>;
  phase: OfflineQueuePhase;
  /** `published` only once publication of this generation is confirmed. */
  state: 'provisional' | 'published';
  /** The publication attempt in progress or last made; `reconcile` outcomes name it. */
  publicationAttemptId?: string;
  holds: Array<{ holdId: string; generation: number }>;
  attempts: number;
  upload?: UploadResult;
  verification?: { verified: boolean; reason?: string };
  publication?: { result?: unknown };
  pending?: OfflineQueuePending;
  error?: { code?: string; message: string };
  createdAt: string;
  updatedAt: string;
}

export interface OfflineQueueStageInput {
  /** Stable entry key. Defaults to the file ID. */
  entryId?: string;
  /** Stage only if the entry is at this generation (0: does not exist yet). */
  expectedGeneration?: number;
  policy: string;
  file: Blob;
  fileName?: string;
  mimeType?: string;
  fileId?: string;
  metadata?: Record<string, unknown>;
  localSource?: PendingLocalSourceMetadata;
  /**
   * Prefix of the new generation's replay key: visible ASCII, at most 200
   * characters. The key sent is always unique to the generation (the prefix,
   * then its operation ID), so no other generation, entry or later staging
   * can replay this generation's session. Defaults to a random key.
   */
  idempotencyKey?: string;
  /** Hold the new generation in the same journal write. */
  hold?: boolean;
}

export interface OfflineQueueUsage {
  entries: number;
  bytes: number;
}

export type OfflineQueueStageResult =
  | { status: 'staged'; entry: OfflineQueueEntry; holdId?: string }
  | {
      status: 'refused';
      reason: 'capacity';
      limit: 'entries' | 'bytes' | 'quota';
      usage: OfflineQueueUsage;
      limits: Required<OfflineQueueLimits>;
    }
  | { status: 'refused'; reason: 'generation-conflict'; currentGeneration: number }
  | { status: 'refused'; reason: 'publication-pending'; currentGeneration: number }
  /** The legacy upload was migrated before and that entry is gone (published or cancelled). */
  | { status: 'refused'; reason: 'already-migrated' }
  /**
   * The current principal is not the partition's: nothing of the partition
   * is returned (a staging that committed before the switch stays, for its
   * principal).
   */
  | { status: 'refused'; reason: 'principal-mismatch' }
  | { status: 'refused'; reason: 'locks-unavailable' | 'storage-unavailable' };

export type OfflineQueueProcessResult =
  | { status: 'published'; entry: OfflineQueueEntry }
  | {
      status: 'provisional';
      entry: OfflineQueueEntry;
      reason:
        | 'held'
        | 'ambiguous'
        | 'needs-reconcile'
        | 'rejected'
        | 'failed'
        | 'retry-limit'
        | 'hook-unavailable'
        /** See `OfflineQueuePending.reason`: nothing sent, no attempt used, resumed by a later pass. */
        | 'scope-unconfirmed';
    }
  /**
   * The pass stopped before its next effect: the caller's signal aborted
   * (`aborted`), or the current principal is not the partition's
   * (`principal-mismatch`). Carries no entry data; the entry stays as it was
   * journaled, for a live pass of its principal to resume or reconcile.
   */
  | { status: 'stopped'; reason: 'aborted' | 'principal-mismatch' }
  | { status: 'superseded' }
  | { status: 'busy' }
  | { status: 'not-found' };

/** One entry of a `processAll` pass: its result, or the error that stopped only that entry. */
export type OfflineQueueProcessAllItem =
  | { entryId: string; result: OfflineQueueProcessResult }
  | { entryId: string; error: Error };

export type OfflineQueueEvent =
  | { type: 'published'; entry: OfflineQueueEntry }
  | { type: 'provisional'; entry: OfflineQueueEntry };

/** A hold is refused once publication of the generation has started or it is final. */
export type OfflineQueueHoldResult =
  | { status: 'held'; holdId: string }
  | { status: 'refused'; reason: 'publication-started' | 'final'; phase: OfflineQueuePhase };

export interface OfflineQueueReclaimResult {
  removedEntries: number;
  removedFiles: number;
  freedBytes: number;
}

export interface LegacyPendingUploadSummary {
  uploadSessionId: string;
  fileId?: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export type OfflineQueueErrorCode =
  | 'FILEFN_QUEUE_LOCKS_UNAVAILABLE'
  | 'FILEFN_QUEUE_STORAGE_UNAVAILABLE'
  | 'FILEFN_QUEUE_DISPOSED'
  | 'FILEFN_QUEUE_INVALID_INPUT'
  | 'FILEFN_QUEUE_NOT_FOUND'
  | 'FILEFN_QUEUE_STALE_GENERATION'
  /** A publication outcome names an attempt that is not the entry's current one. */
  | 'FILEFN_QUEUE_STALE_ATTEMPT'
  /** The current principal is not the partition's; see `OfflineQueueCurrentPrincipal`. */
  | 'FILEFN_QUEUE_PRINCIPAL_MISMATCH'
  | 'FILEFN_QUEUE_PUBLICATION_PENDING'
  /**
   * An `uploadFile` abort came after a tab claimed the generation's first
   * upload step: nothing was removed, and the generation stays provisional
   * and reconcilable under its recorded identity (`details`: entryId,
   * generation, phase).
   */
  | 'FILEFN_QUEUE_UPLOAD_STARTED'
  | 'FILEFN_QUEUE_SUPERSEDED'
  | 'FILEFN_QUEUE_REJECTED'
  | 'FILEFN_QUEUE_FAILED'
  | 'FILEFN_QUEUE_CANCELLED'
  | 'FILEFN_QUEUE_MIGRATION_UNVERIFIED'
  /** Another tab or call is processing the entry; try again once it finishes. */
  | 'FILEFN_QUEUE_BUSY'
  /** Uploads of the generation reached the attempt limit; `reconcile` retries it. */
  | 'FILEFN_QUEUE_RETRY_LIMIT'
  /** Given to an uploader by `assertPrincipal`: the generation is held, so no further request may go out. */
  | 'FILEFN_QUEUE_HELD'
  /** `uploadFile` could not stage offline; `details` is the refused stage result. */
  | 'FILEFN_QUEUE_REFUSED';

export class OfflineQueueError extends Error {
  constructor(
    readonly code: OfflineQueueErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OfflineQueueError';
  }
}

interface GenerationState {
  generation: number;
  operationId: string;
  dataFile: string;
  dataRemoved?: boolean;
  fileId: string;
  policy: string;
  fileName: string;
  mimeType: string;
  size: number;
  metadata?: Record<string, unknown>;
  localSource: PendingLocalSourceMetadata;
  /**
   * `scope`: the account scope of every replay of the generation, under any
   * key, journaled with the claim of its first upload step before any request
   * (see `OfflineQueueUploader.replayScope`). Never changed afterwards.
   */
  replay: { idempotencyKey: string; retiredKeys: string[]; scope?: string };
  /**
   * Hooks this generation needs: recorded when it is staged, and joined by
   * the writing instance's hooks with every write while it is not final (see
   * writeRecord), so no instance skips a step another one requires.
   */
  requires: { verify: boolean; publish: boolean };
  /** Set with each move to `publishing`; manual outcomes must name it. */
  publicationAttempt?: string;
  attempts: number;
  phase: OfflineQueuePhase;
  claim?: { instanceId: string; at: string };
  /**
   * Set in the write that claims the generation's first upload step, before
   * any request; never cleared. An `uploadFile` abort removes only a
   * generation without it (see `abortStaged`).
   */
  dispatched?: true;
  upload?: UploadResult;
  /**
   * `byHook`: a verify hook decided it. A generation verified without one
   * (none was required then) is verified again by the hook before publication
   * once an instance with a verifier joins its requirements.
   */
  verification?: { verified: boolean; reason?: string; byHook?: boolean };
  publication?: { result?: unknown };
  pending?: OfflineQueuePending;
  error?: { code?: string; message: string };
}

interface JournalRecord {
  journalVersion: typeof JOURNAL_VERSION;
  binding: OfflineQueuePartition & { partitionId: string };
  entryId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  current: GenerationState;
  /**
   * `admission`: the staging hold of an `uploadFile` call, owned by the Web
   * Lock that call holds (`admissionLockName`). Once that lock is free (the
   * call returned, its queue was disposed, its tab closed or crashed) the
   * hold no longer applies and the next plan removes it (`planStep`).
   */
  holds: Array<{ holdId: string; generation: number; operationId: string; admission?: true }>;
  /** The admission (see `LegacyClaim`) that wrote this migrated generation. */
  migrationAdmission?: string;
  /** The legacy upload this generation was migrated from (never inherited by a later generation). */
  migratedFrom?: string;
  /** The legacy replay key this generation took over, if any. */
  migratedKey?: string;
}

/** A published generation whose journal was removed, kept so waiters in other tabs still see it published. */
interface Tombstone {
  entryId: string;
  generation: number;
  removedAt: string;
  entry: OfflineQueueEntry;
}

/**
 * Partition-wide state: the last generation handed out (so a removed entry's
 * numbers are never reused), legacy uploads whose migrated entry was removed
 * (so they are never admitted again), and tombstones of removed published
 * generations.
 */
interface PartitionMeta {
  journalVersion: typeof JOURNAL_VERSION;
  partitionId: string;
  lastGeneration: number;
  migrated: string[];
  /**
   * Legacy replay keys that are never taken over again: those of migrated
   * generations that are gone since (each key is taken over once; keys of
   * present generations are in their journals), and keys several legacy
   * uploads shared.
   */
  migratedKeys: string[];
  tombstones: Tombstone[];
}

const MAX_TOMBSTONES = 64;

type JournalRead =
  | { state: 'ok'; record: JournalRecord }
  | { state: 'missing' | 'corrupt' | 'foreign' };

type StepKind = 'upload' | 'verify' | 'publish' | 'reconcile-publication';

type Plan =
  | { kind: 'done'; result: OfflineQueueProcessResult }
  | { kind: 'continue' }
  /** The upload step needs the uploader's current replay scope (resolved outside the lock): plan again with it. */
  | { kind: 'resolve-scope'; generation: number; operationId: string }
  /** A step started: `running` is its upload or hook, invoked right after its claim was journaled. */
  | { kind: StepKind; record: JournalRecord; controller: AbortController; release: () => void; running: Promise<unknown> };

/**
 * Checked right before every durable effect of a transaction (a journal,
 * meta or data file commit, or a removal) and before a read is returned:
 * throws FILEFN_QUEUE_DISPOSED, an AbortError when the pass's signal aborted,
 * or FILEFN_QUEUE_PRINCIPAL_MISMATCH.
 */
type Fence = () => Promise<void>;

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > ID_MAX_LENGTH) {
    throw new OfflineQueueError('FILEFN_QUEUE_INVALID_INPUT', `${field} must be a non-empty string of at most ${ID_MAX_LENGTH} characters`, { field });
  }
  return value;
}

/**
 * Validates and copies a partition into a frozen object, so neither later
 * changes to the caller's object nor changes to the copy (exposed as
 * `queue.partition` and to hooks) can redirect the queue's binding.
 */
export function normalizeOfflineQueuePartition(partition: OfflineQueuePartition): OfflineQueuePartition {
  if (!partition || typeof partition !== 'object' || !partition.principal || typeof partition.principal !== 'object') {
    throw new OfflineQueueError('FILEFN_QUEUE_INVALID_INPUT', 'partition needs a serviceId and a principal', { field: 'partition' });
  }
  const serviceId = requireId(partition.serviceId, 'serviceId');
  const principal = partition.principal;
  if (principal.kind === 'user') {
    return Object.freeze({
      serviceId,
      principal: Object.freeze({
        kind: 'user' as const,
        principalId: requireId(principal.principalId, 'principal.principalId'),
        ...(principal.tenantId !== undefined ? { tenantId: requireId(principal.tenantId, 'principal.tenantId') } : {}),
      }),
    });
  }
  if (principal.kind === 'guest') {
    return Object.freeze({
      serviceId,
      principal: Object.freeze({ kind: 'guest' as const, namespace: requireId(principal.namespace, 'principal.namespace') }),
    });
  }
  throw new OfflineQueueError('FILEFN_QUEUE_INVALID_INPUT', "principal.kind must be 'user' or 'guest'", { field: 'principal.kind' });
}

/** Unambiguous identity of a partition: each part is a separate JSON array item. */
function partitionIdentity(partition: OfflineQueuePartition): string {
  const p = partition.principal;
  return JSON.stringify([
    'filefn-offline-queue',
    partition.serviceId,
    p.kind,
    p.kind === 'user' ? p.principalId : p.namespace,
    p.kind === 'user' ? (p.tenantId ?? null) : null,
  ]);
}

async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new OfflineQueueError('FILEFN_QUEUE_STORAGE_UNAVAILABLE', 'crypto.subtle is required for the offline queue');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomId(prefix: string): string {
  const cryptoApi = globalThis.crypto;
  const raw = typeof cryptoApi?.randomUUID === 'function'
    ? cryptoApi.randomUUID().replace(/-/g, '')
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${raw}`;
}

function webLocksCoordinator(): OfflineQueueLockCoordinator | undefined {
  const locks = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { locks?: { request?: (...args: unknown[]) => Promise<unknown> } }).locks
    : undefined;
  if (!locks || typeof locks.request !== 'function') {
    return undefined;
  }
  return {
    request: <T>(name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (lock: unknown) => Promise<T>) => {
      // Web Locks refuse ifAvailable together with a signal.
      const lockOptions = options.ifAvailable
        ? { mode: 'exclusive', ifAvailable: true }
        : { mode: 'exclusive', ...(options.signal ? { signal: options.signal } : {}) };
      return locks.request!(name, lockOptions, callback) as Promise<T>;
    },
  };
}

function opfsRootProvider(): (() => Promise<OfflineQueueDirectoryHandle>) | undefined {
  if (!OPFSStore.isSupported()) {
    return undefined;
  }
  return async () => (await (navigator.storage as StorageManager).getDirectory()) as unknown as OfflineQueueDirectoryHandle;
}

function defaultChannel(name: string): OfflineQueueChannel | undefined {
  if (typeof BroadcastChannel !== 'function') return undefined;
  const channel = new BroadcastChannel(name);
  // Never keeps a Node process alive on its own.
  (channel as unknown as { unref?: () => void }).unref?.();
  return channel as unknown as OfflineQueueChannel;
}

const LEGACY_CLAIMS_DIR = 'filefn-offline-legacy-claims';

/**
 * Written (shared by every queue root, partition and tab of the legacy
 * directory) before a legacy upload's entry: the one destination that
 * admits it. A retry at that destination recovers this admission (its entry
 * ID); any other destination is refused as already-migrated.
 */
interface LegacyClaim {
  v: 2;
  partitionId: string;
  /** The queue's `rootDir`: the same partition under another root is another destination. */
  queueRoot: string;
  entryId: string;
  uploadSessionId: string;
  admissionId: string;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError');
}

function isQuotaError(error: unknown): boolean {
  return error instanceof Error && error.name === 'QuotaExceededError';
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError');
}

async function getDir(parent: OfflineQueueDirectoryHandle, name: string): Promise<OfflineQueueDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function getFile(dir: OfflineQueueDirectoryHandle, name: string): Promise<Blob | null> {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function writeFile(
  dir: OfflineQueueDirectoryHandle,
  name: string,
  data: ArrayBuffer | string,
  fence?: Fence,
): Promise<void> {
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  try {
    await writable.write(data);
    // Checked after every preparatory await: a stopped or switched pass never commits.
    await fence?.();
  } catch (error) {
    await writable.abort?.().catch(() => {});
    throw error;
  }
  // OPFS commits a writable atomically on close: readers see the old or the new content.
  await writable.close();
}

async function removeEntry(dir: OfflineQueueDirectoryHandle, name: string, recursive = false): Promise<void> {
  try {
    await dir.removeEntry(name, { recursive });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function listNames(dir: OfflineQueueDirectoryHandle, kind: 'file' | 'directory'): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of dir.values()) {
    if (entry.kind === kind) names.push(entry.name);
  }
  return names;
}

/**
 * Settles with `promise`, or rejects with AbortError once `signal` aborts, so a
 * disposed or cancelled entry stops waiting on an upload or hook that ignores
 * its signal. Whatever that work returns later is never written.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Runs app code that the queue awaits before any effect (no request sent, no
 * hook started), raced with every given signal: the first abort rejects with
 * AbortError at once, aborts the signal handed to `fn`, and discards whatever
 * `fn` settles with later. So a callback that ignores its signal and never
 * settles cannot keep the partition lock (another tab's work) or the entry
 * lock after a disposal or an abort.
 *
 * The one path for every such callback:
 * - `currentPrincipal`, in every principal check (`principalMatches`: the
 *   fences under the partition and entry locks, waiter and event delivery);
 * - `uploader.replayScope` (the client's `offline.replayAccount`), in
 *   `resolveReplayScope`;
 * - `offline.getAuthHeaders`, before each request of the built-in replay
 *   uploader (`replayUploader` in the client).
 * Uploads and hooks that may already have taken effect are not covered: their
 * step keeps the entry lock until they settle (raced only to stop waiting).
 */
export function raceCallerCallback<T>(
  fn: (signal: AbortSignal) => Promise<T> | T,
  signals: ReadonlyArray<AbortSignal | undefined>,
): Promise<T> {
  const controller = new AbortController();
  const live = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (live.some((signal) => signal.aborted)) {
    controller.abort();
    return Promise.reject(abortError());
  }
  const onAbort = () => controller.abort();
  for (const signal of live) signal.addEventListener('abort', onAbort, { once: true });
  return raceAbort(invoke(() => fn(controller.signal)), controller.signal).finally(() => {
    for (const signal of live) signal.removeEventListener('abort', onAbort);
  });
}

function toJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function errorInfo(error: unknown): { code?: string; message: string } {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return code ? { code, message } : { message };
}

type UploadFailure = { code?: unknown; status?: unknown; retryable?: unknown; details?: { retryable?: unknown } } | undefined;

/**
 * The session of the recorded key ended for good: an `upload/init` replay of
 * the key found it aborted or expired (the server reports a session with a
 * live completion as in progress). Nothing more can be sent under that key;
 * the generation starts again under a fresh one.
 */
function isSessionEnded(error: unknown): boolean {
  // Only a confirmation the upload manager (or a custom uploader through
  // createUploadSessionEndedError) made: a server refusal carrying the code
  // proves nothing.
  return isConfirmedSessionEnd(error);
}

/**
 * Outcomes a replay under the same key settles: another tab completed, or is
 * completing, the same session; the server lost track of it; or a request
 * other than `upload/init` saw it expired or aborted, which a live completion
 * or a completion by another request can still overtake. The replay's
 * `upload/init` reports the session as it is: completed (reconciled), or
 * ended (then a fresh key is journaled).
 */
const REPLAYABLE_CODES = new Set([
  // The replay's credentials resolve to another account than the scope its
  // first init pinned, or the server confirmed none: nothing was sent, and
  // the right account's replay under the same key settles it.
  'FILEFN_REPLAY_SCOPE_MISMATCH',
  'FILEFN_REPLAY_SCOPE_UNCONFIRMED',
  'FILEFN_UPLOAD_COMPLETION_IN_PROGRESS',
  'FILEFN_UPLOAD_ALREADY_COMPLETED',
  'FILEFN_UPLOAD_INCOMPLETE',
  'FILEFN_SESSION_NOT_FOUND',
  'FILEFN_UPLOAD_EXPIRED',
  'FILEFN_UPLOAD_ABORTED',
  // The client's own code: a response that names it confirmed nothing (only
  // the upload manager's own confirmation retires a key), and the replay
  // under the same key settles it.
  'FILEFN_UPLOAD_SESSION_ENDED',
]);

/**
 * Statuses that say nothing final about the upload: authentication and
 * authorization (the credentials may belong to another account for a moment),
 * timeouts, locks, early data and rate limits.
 */
const TRANSIENT_STATUSES = new Set([401, 403, 408, 423, 425, 429]);

/**
 * A failure that no replay with the same input can fix: a client-side input
 * error or FileFn's own 4xx refusal of the request (a FileFn error code).
 * Anything the server marks retryable, a replayable conflict, a transient
 * status, a 5xx, a network error, and a 4xx without a FileFn code (a signed
 * storage URL's 404 once FileFn completed or swept the session, a proxy's
 * answer) is not: it cannot settle the FileFn session, so the outcome stays
 * unknown until `upload/init` replays the same key.
 */
function isPermanentUploadError(error: unknown): boolean {
  const failure = error as UploadFailure;
  if (failure?.code === 'FILEFN_CLIENT_FILE_ID_MISMATCH' || failure?.code === 'FILEFN_INVALID_FILE_ID') return true;
  if (failure?.retryable === true || failure?.details?.retryable === true) return false;
  if (typeof failure?.code !== 'string' || !failure.code.startsWith('FILEFN_')) return false;
  if (REPLAYABLE_CODES.has(failure.code)) return false;
  const status = failure?.status;
  if (typeof status === 'number') {
    return status >= 400 && status < 500 && !TRANSIENT_STATUSES.has(status);
  }
  return false;
}

function isPrincipalMismatch(error: unknown): boolean {
  return error instanceof OfflineQueueError && error.code === 'FILEFN_QUEUE_PRINCIPAL_MISMATCH';
}

function isHeld(error: unknown): boolean {
  return error instanceof OfflineQueueError && error.code === 'FILEFN_QUEUE_HELD';
}


const NOT_JSON: unique symbol = Symbol('not-json');

/**
 * Whether `value` is JSON data that a JSON round trip keeps exactly: null,
 * booleans, strings, finite numbers, dense arrays and plain objects of such
 * values. Anything JSON.stringify would drop, convert or call (undefined
 * members, functions, symbols and symbol keys, NaN, Infinity and -0, a toJSON
 * method, class instances such as Date or Map, accessors, cycles) is not.
 */
function isExactJson(value: unknown, seen: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  // -0 would come back as 0.
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false;
      const keys = Reflect.ownKeys(value);
      // Dense, and nothing but its indexes and length.
      if (keys.length !== value.length + 1) return false;
      for (let i = 0; i < value.length; i += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, i);
        if (!descriptor || !('value' in descriptor) || !isExactJson(descriptor.value, seen)) return false;
      }
      return true;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) return false;
      if (key === 'toJSON' || !isExactJson(descriptor.value, seen)) return false;
    }
    return true;
  } finally {
    seen.delete(value);
  }
}

/**
 * `value` as stored in a journal, or NOT_JSON when a JSON round trip would
 * change it in any way (see `isExactJson`): such a value confirms nothing.
 */
function strictJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (!isExactJson(value, new Set())) return NOT_JSON;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Whether an outcome envelope (a publication hook's resolved value, a
 * reconcile hook's check, a manual publication outcome) is a plain object of
 * own, enumerable data properties with string keys. A Date, Map, array, class
 * instance or an object with accessors or symbol keys is not, so it confirms
 * nothing.
 */
function isPlainEnvelope(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) return false;
  }
  return true;
}

/**
 * What a verify hook's resolved value decides: only a plain `{ verified: true }`
 * or `{ verified: false, reason? }` (a string reason) envelope decides; any
 * other value or key (`{ verified: true, ok: false }`, a class instance with
 * `verified: true`, ...) decides nothing (null).
 */
function verificationOutcome(value: unknown): { verified: true } | { verified: false; reason: string } | null {
  if (!isPlainEnvelope(value)) return null;
  if (value.verified === true) return hasOnlyKeys(value, ['verified']) ? { verified: true } : null;
  if (value.verified !== false || !hasOnlyKeys(value, ['verified', 'reason'])) return null;
  if (value.reason !== undefined && typeof value.reason !== 'string') return null;
  return { verified: false, reason: value.reason ?? '' };
}

/** Whether a plain envelope has no own key outside `allowed`. */
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/**
 * What a publication hook's resolved value confirms: published with its
 * JSON result, or nothing (NOT_JSON) for any value outside the contract.
 * Only `undefined` or a plain `{ result? }` envelope confirms; an optional
 * `published` flag must be `true`. Any other key (`{ published: false }`,
 * `{ ok: false }`, ...) confirms nothing, so the attempt stays provisional.
 */
function publicationResult(value: unknown): { result?: unknown } | typeof NOT_JSON {
  if (value === undefined) return {};
  if (!isPlainEnvelope(value) || !hasOnlyKeys(value, ['result', 'published'])) return NOT_JSON;
  if ('published' in value && value.published !== true) return NOT_JSON;
  const result = strictJson(value.result);
  if (result === NOT_JSON) return NOT_JSON;
  return result === undefined ? {} : { result };
}

/**
 * Whether a plain envelope is a publication check: `{ published: true,
 * result? }` or `{ published: false }`, plus `extra` keys. Any other key, or
 * a `result` on an unpublished check, makes it no check at all.
 */
function isPublicationCheck(value: Record<string, unknown>, extra: readonly string[] = []): boolean {
  if (value.published === true) return hasOnlyKeys(value, ['published', 'result', ...extra]);
  if (value.published === false) return hasOnlyKeys(value, ['published', ...extra]);
  return false;
}

/** A caller's key prefix: it must reach the server unchanged in a header. */
function assertQueueKeyPrefix(key: string): void {
  if (!isValidIdempotencyKey(key, 200)) {
    throw new OfflineQueueError('FILEFN_QUEUE_INVALID_INPUT', 'idempotencyKey must be 1-200 visible ASCII characters', {
      field: 'idempotencyKey',
    });
  }
}

/**
 * The key a new generation sends: unique to it, so no other generation (of
 * this entry or another, before or after a cancel or reclaim) can replay its
 * session. A migrated legacy upload may take over its own key instead (see
 * `stageBytes`).
 */
function replayKey(prefix: string | undefined, operationId: string): string {
  return prefix ? `${prefix}:${operationId}` : randomId('idem');
}

/** Calls `fn` now, turning a synchronous throw into a rejection. */
function invoke<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error);
  }
}

function isTerminalPhase(phase: OfflineQueuePhase): boolean {
  return phase === 'published' || phase === 'rejected' || phase === 'failed';
}

function snapshot(record: JournalRecord): OfflineQueueEntry {
  const cur = record.current;
  return {
    entryId: record.entryId,
    generation: cur.generation,
    operationId: cur.operationId,
    fileId: cur.fileId,
    policy: cur.policy,
    fileName: cur.fileName,
    mimeType: cur.mimeType,
    size: cur.size,
    ...(cur.metadata !== undefined ? { metadata: cur.metadata } : {}),
    phase: cur.phase,
    state: cur.phase === 'published' ? 'published' : 'provisional',
    ...(cur.publicationAttempt ? { publicationAttemptId: cur.publicationAttempt } : {}),
    // An admission hold is the staging call's own, never one of the app's.
    holds: record.holds
      .filter((hold) => hold.operationId === cur.operationId && !hold.admission)
      .map(({ holdId, generation }) => ({ holdId, generation })),
    attempts: cur.attempts,
    ...(cur.upload ? { upload: { ...cur.upload } } : {}),
    ...(cur.verification
      ? { verification: { verified: cur.verification.verified, ...(cur.verification.reason !== undefined ? { reason: cur.verification.reason } : {}) } }
      : {}),
    ...(cur.publication ? { publication: { ...cur.publication } } : {}),
    ...(cur.pending ? { pending: { ...cur.pending } } : {}),
    ...(cur.error ? { error: { ...cur.error } } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

const MISMATCH_REFUSAL = (): { status: 'refused'; reason: 'principal-mismatch' } => ({ status: 'refused', reason: 'principal-mismatch' });
const STOPPED_MISMATCH = (): OfflineQueueProcessResult => ({ status: 'stopped', reason: 'principal-mismatch' });

/** Defers a waiter settlement until the public call returned (see `disclosing`). */
type AfterReturn = (settle: () => void) => void;

/** A preview read that a newer read overtook: read again, never applied. */
const STALE: unique symbol = Symbol('stale');

/** What a preview read found for a file ID, at its durable position. */
/**
 * A preview read: the eligible generation found (if any), the position of
 * every entry of the file present in the partition, and the position at
 * which every other entry was absent (`absent`, from the meta read).
 */
type PendingRead = {
  found: { record: JournalRecord; data: ArrayBuffer } | null;
  positions: Map<string, Position>;
  absent: Position;
};

/**
 * The uploader's replay scope, or why there is none, resolved for one
 * generation and operation (`for`): it applies to no other.
 */
type ScopeResolution = ({ scope: string } | { error: unknown }) & { for: { generation: number; operationId: string } };

/** Returned by `withEntryLock` when another tab or call holds the entry. */
const BUSY: unique symbol = Symbol('busy');
/** Returned by `finishStep` when the step's generation was replaced or removed meanwhile: plan the entry again. */
const REPLAN: unique symbol = Symbol('replan');

/** Thrown by an upload's guard when its generation is no longer the entry's current one. */
function generationGone(entryId: string, generation: number): OfflineQueueError {
  return new OfflineQueueError('FILEFN_QUEUE_SUPERSEDED', 'The generation was replaced or removed', { entryId, generation });
}

function isGenerationGone(error: unknown): boolean {
  return error instanceof OfflineQueueError && error.code === 'FILEFN_QUEUE_SUPERSEDED';
}

/**
 * A durable point in one entry's history, the only order of observations: its
 * generation (handed out once per partition, never reused), then its journal
 * revision (raised by every write). An entry found absent by a read made when
 * the partition's last generation was L is at (L, Infinity): after every
 * generation it ever had then, before any staged since.
 */
interface Position {
  generation: number;
  revision: number;
}

function positionOf(record: JournalRecord): Position {
  return { generation: record.current.generation, revision: record.revision };
}

function absentAt(lastGeneration: number): Position {
  return { generation: lastGeneration, revision: Number.POSITIVE_INFINITY };
}

/** Whether `a` is older than `b` (never, when there is no `b`). */
function isBefore(a: Position, b: Position | undefined): boolean {
  return b !== undefined && (a.generation < b.generation || (a.generation === b.generation && a.revision < b.revision));
}

interface Waiter {
  generation: number;
  /**
   * The entry's position read (under the partition lock) by the first read
   * after the waiter was registered. Until then no observation settles it;
   * after, only one at or after this position.
   */
  from?: Position;
  resolve: (entry: OfflineQueueEntry) => void;
  reject: (error: Error) => void;
}

export class OfflineQueue {
  readonly partition: OfflineQueuePartition;
  private readonly identity: string;
  private readonly instanceId = randomId('q');
  private readonly rootDirName: string;
  private readonly legacyRootDirName: string;
  private readonly coordinator: OfflineQueueLockCoordinator | undefined;
  private readonly lockSource: OfflineQueueCapabilities['locks'];
  private readonly getRoot: (() => Promise<OfflineQueueDirectoryHandle>) | undefined;
  private readonly storageSource: OfflineQueueCapabilities['storage'];
  private readonly limits: Required<OfflineQueueLimits>;
  private readonly terminalRetentionMs: number;
  private readonly maxUploadAttempts: number;
  private readonly observeIntervalMs: number;
  private observeTimer: ReturnType<typeof setInterval> | undefined;
  private readonly lifetime = new AbortController();
  /** The running step of each entry, with the operation (generation) it belongs to. */
  private readonly entryControllers = new Map<string, { operationId: string; controller: AbortController }>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly listeners = new Set<(event: OfflineQueueEvent) => void>();
  private readonly workListeners = new Set<() => void>();
  private readonly disposeListeners = new Set<() => void>();
  /** The fence of the transaction this instance is running (the partition lock serializes them). */
  private txFence: Fence | undefined;
  private readonly objectUrls = new Map<string, { operationId: string; url: string }>();
  /**
   * Per entry, the newest durable position (see `Position`) an observation
   * applied; per file, the newest position of each of its entries that any
   * observation or preview read applied (`fileView`). An observation or
   * preview read older than these is discarded whole: it settles no waiter,
   * revokes no preview and returns nothing. The check and what it delivers
   * run in one synchronous block, after the read's last await.
   */
  private readonly applied = new Map<string, Position>();
  /**
   * Per file: the newest position of each entry of the file that any
   * observation applied (a listing, a pass, a staging, a lookup, a removal,
   * a preview read; a removed entry at its absence position). Each entry
   * orders by its own durable journal position, so a preview read is ordered
   * against every entry of its file that anything observed, never just the
   * one it returned or earlier previews saw.
   */
  private readonly fileView = new Map<string, Map<string, Position>>();
  private partitionIdPromise: Promise<string> | undefined;
  private channelPromise: Promise<OfflineQueueChannel | undefined> | undefined;
  private posting: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: OfflineQueueOptions) {
    this.partition = normalizeOfflineQueuePartition(options.partition);
    if (typeof options.currentPrincipal !== 'function') {
      throw new OfflineQueueError('FILEFN_QUEUE_INVALID_INPUT', 'currentPrincipal is required', { field: 'currentPrincipal' });
    }
    this.identity = partitionIdentity(this.partition);
    this.rootDirName = options.rootDir ?? 'filefn-offline-queue';
    this.legacyRootDirName = options.legacyRootDir ?? 'filefn-pending-uploads';
    const webLocks = webLocksCoordinator();
    this.coordinator = webLocks ?? options.coordinator;
    this.lockSource = webLocks ? 'web-locks' : options.coordinator ? 'coordinator' : 'unavailable';
    this.getRoot = options.getRoot ?? opfsRootProvider();
    this.storageSource = options.getRoot ? 'custom' : this.getRoot ? 'opfs' : 'unavailable';
    this.limits = {
      maxEntries: options.limits?.maxEntries ?? DEFAULT_OFFLINE_QUEUE_LIMITS.maxEntries,
      maxBytes: options.limits?.maxBytes ?? DEFAULT_OFFLINE_QUEUE_LIMITS.maxBytes,
    };
    this.terminalRetentionMs = options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
    this.maxUploadAttempts = options.maxUploadAttempts ?? DEFAULT_MAX_UPLOAD_ATTEMPTS;
    this.observeIntervalMs = options.observeIntervalMs ?? DEFAULT_OBSERVE_INTERVAL_MS;
  }

  /** What this environment supports. Durable operations fail closed when `durable` is false. */
  capabilities(): OfflineQueueCapabilities {
    const base = { storage: this.storageSource, locks: this.lockSource };
    if (this.storageSource === 'unavailable') return { durable: false, ...base, reason: 'storage-unavailable' };
    if (this.lockSource === 'unavailable') return { durable: false, ...base, reason: 'locks-unavailable' };
    return { durable: true, ...base };
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Whether this queue may still act and report for its partition: it is not
   * disposed and `currentPrincipal` reports the partition's principal now.
   * `OfflineSync` checks it before each callback, so a callback that switches
   * the account receives nothing more about the old principal's entries.
   */
  async principalIsCurrent(): Promise<boolean> {
    if (this.disposed) return false;
    const matches = await this.principalMatches(this.lifetime.signal);
    return matches && !this.disposed;
  }

  /**
   * Invalidates this instance: new calls reject with FILEFN_QUEUE_DISPOSED,
   * in-flight uploads and hooks are aborted, and their late results are never
   * written. Staged data stays in storage for the next instance of the same
   * partition.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    if (this.observeTimer !== undefined) clearInterval(this.observeTimer);
    this.observeTimer = undefined;
    // Entries this instance was driving are left to the other tabs.
    if (this.entryControllers.size > 0) this.announceWork();
    for (const { controller } of this.entryControllers.values()) controller.abort();
    this.entryControllers.clear();
    void this.posting.then(async () => (await this.channelPromise)?.close()).catch(() => {});
    const error = new OfflineQueueError('FILEFN_QUEUE_DISPOSED', 'Offline queue was disposed');
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    this.waiters.clear();
    this.listeners.clear();
    this.workListeners.clear();
    const disposeListeners = [...this.disposeListeners];
    this.disposeListeners.clear();
    for (const listener of disposeListeners) {
      try {
        listener();
      } catch {
        // A listener error does not affect the disposal.
      }
    }
    for (const { url } of this.objectUrls.values()) {
      if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
    }
    this.objectUrls.clear();
  }

  /**
   * Reports confirmed publications and provisional outcomes. The principal is
   * checked before each delivery: once the account switched (even inside an
   * earlier listener), no further listener receives the event.
   */
  subscribe(listener: (event: OfflineQueueEvent) => void): () => void {
    this.assertUsable();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Called when work becomes runnable: a generation staged, a hold released
   * or an entry reconciled, by this instance or (through the partition's
   * work channel, see `OfflineQueueOptions.channel`) by a queue in another
   * tab, and when another tab's queue is disposed while driving entries.
   * `OfflineSync` uses it to start a pass at once.
   */
  /**
   * Called once when this queue is disposed (at once, synchronously, if it
   * already is). `OfflineSync` uses it to dispose itself together with the
   * queue it drives: its online listener and timers go at once.
   */
  onDispose(listener: () => void): () => void {
    if (this.disposed) {
      listener();
      return () => {};
    }
    this.disposeListeners.add(listener);
    return () => this.disposeListeners.delete(listener);
  }

  onWork(listener: () => void): () => void {
    this.assertUsable();
    this.workListeners.add(listener);
    void this.workChannel();
    return () => this.workListeners.delete(listener);
  }

  /**
   * Stages a new generation of an entry. Returns a refusal, never throws, for
   * missing locks or storage, a full partition, a generation conflict or a
   * current principal that is not the partition's.
   */
  async stage(input: OfflineQueueStageInput): Promise<OfflineQueueStageResult> {
    return this.stageWith(input, undefined);
  }

  /**
   * Stages a generation held by an admission that lasts only as long as this
   * call: the hold is owned by a Web Lock (or coordinator lock) the call
   * holds, so a generation whose call returned, was disposed, or whose tab
   * closed or crashed before it was let go is runnable again for its
   * principal (the hold is dropped by the next plan). The staging call
   * decides release or cancellation in the one partition-lock transaction
   * that ends the hold: `signal` is read there, and an abort removes the
   * generation (`cancelled`) without it ever being runnable; otherwise the
   * hold is released and only that committed release announces work. An
   * abort after that release (while this call is still returning) requests
   * `abortStaged` at once, until this call has returned (its outer fence
   * included): it is ordered against the first upload-step claim
   * by the partition lock, removes the generation only if that claim never
   * committed, and otherwise throws FILEFN_QUEUE_UPLOAD_STARTED with the
   * generation kept. A committed staging that a principal switch refused
   * (`principal-mismatch`) stays runnable for its principal. An abort that
   * comes after the queue was disposed or its principal changed cannot be
   * journaled. The result and errors pass the outer disclosing fence.
   */
  async stageAdmitted(
    input: Omit<OfflineQueueStageInput, 'hold'>,
    signal: AbortSignal,
  ): Promise<OfflineQueueStageResult | { status: 'cancelled'; entryId: string; generation: number }> {
    if (this.disposed) throw new OfflineQueueError('FILEFN_QUEUE_DISPOSED', 'Offline queue was disposed');
    const capability = this.capabilities();
    if (!capability.durable) return { status: 'refused', reason: capability.reason! };
    let abortRun: Promise<boolean> | undefined;
    let listener: (() => void) | undefined;
    // Waiter settlements of the abort's removal: flushed once this call is
    // over, behind a fresh principal check, whenever the abort came.
    const removals: Array<() => void> = [];
    type Admitted = OfflineQueueStageResult | { status: 'cancelled'; entryId: string; generation: number };
    try {
      const result = await this.disclosing<Admitted, Admitted>(async () => {
        const holdId = randomId('hold');
        const lockName = await this.admissionLockName(holdId);
        try {
          return await this.coordinator!.request(lockName, { signal: this.lifetime.signal }, async () => {
            const staged = await this.stageWith(input, holdId);
            if (staged.status !== 'staged') return staged;
            const { entryId, generation } = staged.entry;
            // From the committed staging until this call has returned (its
            // outer fence included), an abort is a lock-ordered request at
            // once. Before the release commits, the admission hold keeps any
            // claim out, so it always removes the generation (and the ending
            // transaction then finds it gone, or reads the abort itself).
            const request = () => {
              abortRun ??= this.abortStagedIn(entryId, generation, (settle) => removals.push(settle));
              void abortRun.catch(() => {});
            };
            listener = request;
            signal.addEventListener('abort', request, { once: true });
            const ended = await this.endAdmission(entryId, generation, holdId, () => signal.aborted);
            if (ended === 'cancelled') return { status: 'cancelled', entryId, generation } as const;
            return staged;
          });
        } catch (error) {
          if (this.disposed && isAbort(error)) throw new OfflineQueueError('FILEFN_QUEUE_DISPOSED', 'Offline queue was disposed');
          throw error;
        }
      }, MISMATCH_REFUSAL);
      if (abortRun && result.status === 'staged') {
        const { entryId, generation } = result.entry;
        const run = abortRun;
        // Its outcome (an error may name the phase) passes the fence too.
        return await this.disclosing<Admitted, Admitted>(async () => {
          await run;
          return { status: 'cancelled', entryId, generation } as const;
        }, MISMATCH_REFUSAL);
      }
      // The ending transaction cancelled it itself: the abort's request finds it gone.
      if (abortRun) await abortRun.catch(() => {});
      return result;
    } finally {
      if (listener) signal.removeEventListener('abort', listener);
      for (const settle of removals) this.settleAfterReturn(settle);
    }
  }

  /**
   * The abort of an `uploadFile` call whose generation was already let go:
   * in one partition-lock transaction, removes the generation if its first
   * upload step was never claimed (`true`; `false` when it is gone or was
   * replaced). Once that claim committed (here or in another tab), nothing
   * is removed: its journal, replay key and bytes stay, provisional and
   * reconcilable, and FILEFN_QUEUE_UPLOAD_STARTED is thrown.
   */
  async abortStaged(entryId: string, generation: number): Promise<boolean> {
    return this.disclosing((after) => this.abortStagedIn(entryId, generation, after));
  }

  private async abortStagedIn(entryId: string, generation: number, after: AfterReturn): Promise<boolean> {
    const removed = await this.transact(async (root) => {
      const found = await this.readEntry(root, entryId);
      if (!found || found.record.current.generation !== generation) return null;
      const { record } = found;
      const cur = record.current;
      if (cur.dispatched || cur.phase !== 'staged') {
        throw new OfflineQueueError(
          'FILEFN_QUEUE_UPLOAD_STARTED',
          'The upload of this generation already started: it is kept for reconciliation',
          { entryId, generation, phase: cur.phase },
        );
      }
      const partitionDir = await this.partitionDir(root);
      await this.noteRemoval(partitionDir, [record]);
      const { tombstones, lastGeneration } = await this.loadMeta(partitionDir);
      await this.removePath(partitionDir, await this.entryKey(entryId), true);
      return { tombstones, lastGeneration };
    }, { disclose: true });
    if (!removed) return false;
    after(() => this.settleAbsent(entryId, removed.tombstones, removed.lastGeneration));
    return true;
  }

  /**
   * Ends an admission hold in one partition-lock transaction: cancels the
   * generation when `aborted()` (read inside it), else releases the hold and
   * then announces work. `gone`: the generation was replaced or removed.
   */
  private async endAdmission(
    entryId: string,
    generation: number,
    holdId: string,
    aborted: () => boolean,
  ): Promise<'released' | 'cancelled' | 'gone'> {
    return this.disclosing(async (after) => {
      const outcome = await this.transact(async (root) => {
        const found = await this.readEntry(root, entryId);
        if (!found || found.record.current.generation !== generation) return { kind: 'gone' } as const;
        const { dir, record } = found;
        const index = record.holds.findIndex((hold) => hold.holdId === holdId && hold.generation === generation);
        if (index < 0) return { kind: 'gone' } as const;
        if (aborted()) {
          // Held since it was staged: nothing ran it, and nothing will.
          const partitionDir = await this.partitionDir(root);
          await this.noteRemoval(partitionDir, [record]);
          const { tombstones, lastGeneration } = await this.loadMeta(partitionDir);
          await this.removePath(partitionDir, await this.entryKey(entryId), true);
          return { kind: 'cancelled', tombstones, lastGeneration } as const;
        }
        record.holds.splice(index, 1);
        await this.writeRecord(dir, record);
        return { kind: 'released' } as const;
      }, { disclose: true });
      if (outcome.kind === 'cancelled') {
        after(() => this.settleAbsent(entryId, outcome.tombstones, outcome.lastGeneration));
      }
      if (outcome.kind === 'released') this.notifyWork();
      return outcome.kind;
    });
  }

  private async admissionLockName(holdId: string): Promise<string> {
    return `${await this.partitionLockName()}:admission:${holdId}`;
  }

  /** Whether the call that took an admission hold still holds its lock. */
  private async admissionLive(holdId: string): Promise<boolean> {
    return this.coordinator!.request(await this.admissionLockName(holdId), { ifAvailable: true }, async (lock) => lock === null);
  }

  private async stageWith(input: OfflineQueueStageInput, admissionHoldId: string | undefined): Promise<OfflineQueueStageResult> {
    if (this.disposed) throw new OfflineQueueError('FILEFN_QUEUE_DISPOSED', 'Offline queue was disposed');
    const capability = this.capabilities();
    if (!capability.durable) {
      return { status: 'refused', reason: capability.reason! };
    }
    requireId(input.policy, 'policy');
    if (typeof Blob === 'undefined' || !(input.file instanceof Blob)) {
      throw new OfflineQueueError('FILEFN_QUEUE_INVALID_INPUT', 'file must be a Blob', { field: 'file' });
    }
    assertValidExplicitFileId(input.fileId);
    const fileId = input.fileId ?? generateFileId();
    const entryId = requireId(input.entryId ?? fileId, 'entryId');
    if (input.idempotencyKey !== undefined) assertQueueKeyPrefix(input.idempotencyKey);
    if (input.file.size > this.limits.maxBytes) {
      // More than the partition may ever hold: refused before its bytes are read.
      return this.disclosing<OfflineQueueStageResult>(
        async () => ({
          status: 'refused',
          reason: 'capacity',
          limit: 'bytes',
          usage: await this.transact(async (root) => this.measure(await this.partitionDir(root)), { disclose: true }),
          limits: this.limits,
        }),
        MISMATCH_REFUSAL,
      );
    }
    const bytes = await input.file.arrayBuffer();
    const fileName = input.fileName ?? (typeof File !== 'undefined' && input.file instanceof File ? input.file.name : 'blob');
    const mimeType = input.mimeType || input.file.type || 'application/octet-stream';
    return this.disclosing<OfflineQueueStageResult>(
      (after) => this.stageBytes({ ...input, entryId, fileId, fileName, mimeType, admissionHoldId }, bytes, undefined, after),
      MISMATCH_REFUSAL,
    );
  }

  /**
   * Holds the given generation: it is not uploaded further, verified or
   * published until released. Refused once its publication has started or it
   * is final: a hold can no longer stop it then.
   */
  async hold(entryId: string, generation: number): Promise<OfflineQueueHoldResult> {
    return this.disclosing(() => this.transact(async (root) => {
      const { dir, record } = await this.requireRecord(root, entryId);
      const phase = record.current.phase;
      if (record.current.generation !== generation) {
        throw new OfflineQueueError('FILEFN_QUEUE_STALE_GENERATION', 'Generation is not current', {
          entryId,
          generation,
          currentGeneration: record.current.generation,
        });
      }
      if (phase === 'publishing') return { status: 'refused', reason: 'publication-started', phase } as const;
      if (isTerminalPhase(phase)) return { status: 'refused', reason: 'final', phase } as const;
      const holdId = randomId('hold');
      record.holds.push({ holdId, generation, operationId: record.current.operationId });
      await this.writeRecord(dir, record);
      return { status: 'held', holdId } as const;
    }));
  }

  /** Releases one hold. A hold of another generation, or an unknown hold, is left as it is. */
  async release(entryId: string, generation: number, holdId: string): Promise<boolean> {
    return this.disclosing(() => this.transact(async (root) => {
      const found = await this.readEntry(root, entryId);
      if (!found) return false;
      const { dir, record } = found;
      const index = record.holds.findIndex((hold) => hold.holdId === holdId && hold.generation === generation);
      if (index < 0) return false;
      record.holds.splice(index, 1);
      await this.writeRecord(dir, record);
      return true;
    }).then((released) => {
      if (released) this.notifyWork();
      return released;
    }));
  }

  /**
   * The partition's entries. Entries of other partitions and unscoped legacy
   * uploads are never listed. Throws FILEFN_QUEUE_PRINCIPAL_MISMATCH while the
   * current principal is not the partition's.
   */
  async list(): Promise<OfflineQueueEntry[]> {
    return this.disclosing((after) => this.listIn(after));
  }

  private async listIn(after: AfterReturn): Promise<OfflineQueueEntry[]> {
    const { records, meta } = await this.transact(async (root) => {
      const partitionDir = await this.partitionDir(root);
      return { records: await this.readAllIn(partitionDir), meta: await this.loadMeta(partitionDir) };
    }, { disclose: true });
    const entries = records
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.entryId.localeCompare(b.entryId))
      .map(snapshot);
    // Observed (waiters, previews) after the result is returned, at the
    // positions read: an older read than one applied since changes nothing.
    const present = new Set(records.map((record) => record.entryId));
    after(() => {
      for (const record of records) this.observe(record, meta.tombstones);
      this.forgetAbsent(present, meta.tombstones, meta.lastGeneration);
    });
    return entries;
  }

  async get(entryId: string): Promise<OfflineQueueEntry | null> {
    return this.disclosing(async (after) => {
      const found = await this.read(entryId);
      after(found.settle);
      return found.record ? snapshot(found.record) : null;
    });
  }

  /**
   * Settles when the generation is published (resolves), or is rejected,
   * fails, is superseded, cancelled or the queue is disposed (rejects). A
   * provisional generation keeps it pending. A published generation whose
   * entry was removed since still resolves.
   */
  whenSettled(entryId: string, generation: number): Promise<OfflineQueueEntry> {
    this.assertUsable();
    const promise = new Promise<OfflineQueueEntry>((resolve, reject) => {
      const list = this.waiters.get(entryId) ?? [];
      // Armed by the next read of the entry (`lookup` below, or the observer).
      list.push({ generation, resolve, reject });
      this.waiters.set(entryId, list);
    });
    this.startObserving();
    void this.lookup(entryId).catch(() => {});
    return promise;
  }

  /**
   * Removes the entry and its data, if it is still at `generation` (when given).
   * An unconfirmed publication must be reconciled first.
   */
  async cancel(entryId: string, generation?: number): Promise<boolean> {
    return this.disclosing((after) => this.cancelIn(entryId, generation, after));
  }

  private async cancelIn(entryId: string, generation: number | undefined, after: AfterReturn): Promise<boolean> {
    const removed = await this.transact(async (root) => {
      const found = await this.readEntry(root, entryId);
      if (!found) return null;
      const { record } = found;
      if (generation !== undefined && record.current.generation !== generation) return null;
      if (record.current.phase === 'publishing') {
        throw new OfflineQueueError('FILEFN_QUEUE_PUBLICATION_PENDING', 'Reconcile the publication before cancelling', {
          entryId,
          generation: record.current.generation,
        });
      }
      const partitionDir = await this.partitionDir(root);
      await this.noteRemoval(partitionDir, [record]);
      const { tombstones, lastGeneration } = await this.loadMeta(partitionDir);
      await this.removePath(partitionDir, await this.entryKey(entryId), true);
      // Fenced after the removal: no waiter is settled with the partition's
      // publication results once its principal is no longer current.
      return { tombstones, lastGeneration, operationId: record.current.operationId };
    }, { disclose: true });
    if (!removed) return false;
    // Only what belonged to the removed generation: a step of a generation
    // staged since (by another tab, say) is left alone, and so are its
    // preview and waiters (the removal's position is older than it).
    const running = this.entryControllers.get(entryId);
    if (running?.operationId === removed.operationId) running.controller.abort();
    // A waiter of a generation published before (and replaced since) still resolves.
    after(() => this.settleAbsent(entryId, removed.tombstones, removed.lastGeneration));
    return true;
  }

  /**
   * Resolves a provisional generation. With `publication`, records the
   * verified outcome of the publication attempt it names (`published: false`
   * makes it safe to publish again, under a new attempt). Without it, clears
   * the retry limit and ambiguity so the next `process` retries the current
   * step with the recorded identity. A final generation is returned as it is.
   * Throws FILEFN_QUEUE_BUSY while any tab is processing the entry, so it never
   * races a running publication hook.
   */
  async reconcile(
    entryId: string,
    generation: number,
    publication?: OfflineQueuePublicationOutcome,
  ): Promise<OfflineQueueEntry> {
    // A conflict error names the current generation or attempt: it passes the
    // same outer fence as the returned entry.
    return this.disclosing(() => this.reconcileIn(entryId, generation, publication));
  }

  private async reconcileIn(
    entryId: string,
    generation: number,
    publication?: OfflineQueuePublicationOutcome,
  ): Promise<OfflineQueueEntry> {
    if (
      publication !== undefined &&
      (!isPlainEnvelope(publication) ||
        !isPublicationCheck(publication, ['attemptId']) ||
        typeof publication.attemptId !== 'string')
    ) {
      throw new OfflineQueueError('FILEFN_QUEUE_INVALID_INPUT', 'publication must be a plain object of published (true or false), attemptId and, when published, result only', {
        field: 'publication',
      });
    }
    const confirmedResult = publication?.published ? strictJson(publication.result) : undefined;
    if (confirmedResult === NOT_JSON) {
      throw new OfflineQueueError('FILEFN_QUEUE_INVALID_INPUT', 'publication.result must be JSON', { field: 'publication.result' });
    }
    const outcome = await this.withEntryLock(entryId, () => this.transact(async (root) => {
      const { dir, record } = await this.requireRecord(root, entryId);
      const cur = record.current;
      if (cur.generation !== generation) {
        throw new OfflineQueueError('FILEFN_QUEUE_STALE_GENERATION', 'Generation is not current', {
          entryId,
          generation,
          currentGeneration: cur.generation,
        });
      }
      if (publication) {
        if (cur.phase !== 'publishing') {
          if (cur.phase === 'published' && publication.published && publication.attemptId === cur.publicationAttempt) {
            // Already confirmed: the first result stands and nothing is reported again.
            return { record, changed: false };
          }
          throw new OfflineQueueError('FILEFN_QUEUE_INVALID_INPUT', 'Generation has no unconfirmed publication', { entryId, phase: cur.phase });
        }
        if (publication.attemptId !== cur.publicationAttempt) {
          throw new OfflineQueueError('FILEFN_QUEUE_STALE_ATTEMPT', 'The outcome is for another publication attempt', {
            entryId,
            generation,
            attemptId: publication.attemptId,
            currentAttemptId: cur.publicationAttempt,
          });
        }
        if (publication.published) {
          cur.phase = 'published';
          cur.publication = confirmedResult === undefined ? {} : { result: confirmedResult };
        } else {
          cur.phase = 'verified';
        }
      } else if (isTerminalPhase(cur.phase)) {
        return { record, changed: false };
      }
      cur.pending = undefined;
      if (!isTerminalPhase(cur.phase)) cur.attempts = 0;
      await this.writeRecord(dir, record);
      return { record, changed: true };
    }, { disclose: true }));
    if (outcome === BUSY) {
      throw new OfflineQueueError('FILEFN_QUEUE_BUSY', 'The entry is being processed; reconcile it once that finishes', { entryId, generation });
    }
    if (outcome.changed && outcome.record.current.phase === 'published') await this.emitFor(outcome.record);
    else if (outcome.changed) this.notifyWork();
    await this.observeFenced(outcome.record);
    // A listener or work listener above may have switched the account: the
    // outer fence keeps the outcome in the journal for its owner, and the
    // caller gets no entry.
    return snapshot(outcome.record);
  }

  /**
   * Advances one entry as far as it can go: upload, verification, publication
   * and cleanup. Returns `busy` when another tab or instance is processing it.
   * With `signal` aborted (or the queue disposed), nothing more is journaled
   * and no new upload or hook starts. The entry stays claimed until an upload
   * or hook already started settles, even after the call has returned.
   */
  async process(entryId: string, options: { signal?: AbortSignal } = {}): Promise<OfflineQueueProcessResult> {
    return this.disclosing(() => this.processIn(entryId, options), STOPPED_MISMATCH);
  }

  private async processIn(entryId: string, options: { signal?: AbortSignal }): Promise<OfflineQueueProcessResult> {
    let deliver!: (result: OfflineQueueProcessResult) => void;
    let fail!: (error: unknown) => void;
    const result = new Promise<OfflineQueueProcessResult>((resolve, reject) => {
      deliver = resolve;
      fail = reject;
    });
    const started: Promise<unknown>[] = [];
    this.withEntryLock(entryId, async () => {
      try {
        deliver(await this.runPipeline(entryId, options.signal, started));
      } catch (error) {
        fail(error);
      }
      // A hook or upload that ignored its abort may still take effect: no other
      // call or tab may reconcile or rerun the step until it settles.
      await Promise.allSettled(started);
    }).then((value) => {
      if (value === BUSY) deliver({ status: 'busy' });
    }, fail);
    return result;
  }

  /**
   * Processes every entry of the partition that is not held or final, and
   * finishes the cleanup of published ones. An error in one entry (a storage
   * failure, say) is returned for that entry and the pass goes on. Disposal
   * and a principal mismatch (of the listing or of any entry) stop the pass
   * and throw (FILEFN_QUEUE_DISPOSED, FILEFN_QUEUE_PRINCIPAL_MISMATCH), so no
   * entry data of the pass is returned; an abort stops it after the results
   * so far. Held entries are returned as `held` without being processed.
   */
  async processAll(options: { signal?: AbortSignal } = {}): Promise<OfflineQueueProcessAllItem[]> {
    return this.disclosing(() => this.processAllIn(options));
  }

  private async processAllIn(options: { signal?: AbortSignal }): Promise<OfflineQueueProcessAllItem[]> {
    const entries = await this.list();
    const results: OfflineQueueProcessAllItem[] = [];
    const mismatch = () => new OfflineQueueError('FILEFN_QUEUE_PRINCIPAL_MISMATCH', "The current principal is not this queue's");
    for (const entry of entries) {
      this.assertUsable();
      if (options.signal?.aborted) break;
      if (isTerminalPhase(entry.phase) && entry.phase !== 'published') continue;
      if (entry.phase !== 'published' && entry.holds.length > 0) {
        results.push({ entryId: entry.entryId, result: { status: 'provisional', entry, reason: 'held' } });
        continue;
      }
      let result: OfflineQueueProcessResult;
      try {
        // An entry at its retry limit is reported (`retry-limit`) without another upload.
        result = await this.process(entry.entryId, options);
      } catch (error) {
        if (this.disposed || isPrincipalMismatch(error)) throw error;
        results.push({ entryId: entry.entryId, error: error instanceof Error ? error : new Error(String(error)) });
        continue;
      }
      if (result.status === 'stopped') {
        if (result.reason === 'principal-mismatch') throw mismatch();
        break;
      }
      // A published entry listed here was reported when it was published: only
      // a newer generation (or one another tab holds) is reported again.
      const sameCleanup =
        entry.phase === 'published' && result.status === 'published' && result.entry.generation === entry.generation;
      if (!sameCleanup) results.push({ entryId: entry.entryId, result });
    }
    // Each result passed a fence when it was made; the batch passes the outer
    // one, so an entry's error after a switch does not return the others.
    return results;
  }

  /**
   * Removes orphaned data, the data of published generations and published
   * entries past their retention. Failed and rejected generations may hold
   * the only copy of the user's file: they stay until `cancel`.
   */
  async reclaim(): Promise<OfflineQueueReclaimResult> {
    return this.disclosing((after) => this.reclaimNow(after));
  }

  private async reclaimNow(after: AfterReturn): Promise<OfflineQueueReclaimResult> {
    const { result, present, meta } = await this.transact(async (root) => {
      const partitionDir = await this.partitionDir(root);
      const reclaimed = await this.reclaimIn(partitionDir, false);
      return {
        result: reclaimed,
        present: new Set((await this.readAllIn(partitionDir)).map((record) => record.entryId)),
        meta: await this.loadMeta(partitionDir),
      };
    }, { disclose: true });
    after(() => this.forgetAbsent(present, meta.tombstones, meta.lastGeneration));
    return result;
  }

  async usage(): Promise<OfflineQueueUsage> {
    return this.disclosing(() => this.transact(async (root) => this.measure(await this.partitionDir(root)), { disclose: true }));
  }

  /**
   * A local preview of the newest unpublished generation staged for `fileId`
   * in this partition: among entries whose staged data is still present, the
   * highest generation, ties broken by entry ID. Journal writes that only
   * touch an entry (a hold, a failed attempt) never change the choice.
   */
  async getPendingLocalDescriptor(fileId: string): Promise<PendingLocalDescriptor | null> {
    // A read that a newer one overtook (its coordinator or fence returned
    // late) is read again, never returned and never applied.
    for (let attempt = 0; attempt < 3; attempt++) {
      const descriptor = await this.disclosing(
        () => this.readPendingDescriptor(fileId),
        undefined,
        (read) => this.deliverPendingDescriptor(fileId, read),
      );
      if (descriptor !== STALE) return descriptor;
    }
    throw new OfflineQueueError('FILEFN_QUEUE_BUSY', 'The local preview kept changing while it was read; try again', { fileId });
  }

  private async readPendingDescriptor(fileId: string): Promise<PendingRead> {
    return this.transact(async (root) => {
      const partitionDir = await this.partitionDir(root);
      const all = (await this.readAllIn(partitionDir)).filter((record) => record.current.fileId === fileId);
      const positions = new Map(all.map((record) => [record.entryId, positionOf(record)] as const));
      const absent = absentAt((await this.loadMeta(partitionDir)).lastGeneration);
      const records = all.filter((record) => record.current.phase !== 'published' && !record.current.dataRemoved);
      records.sort((a, b) => b.current.generation - a.current.generation || a.entryId.localeCompare(b.entryId));
      for (const record of records) {
        const dir = await getDir(partitionDir, await this.entryKey(record.entryId));
        const blob = dir ? await getFile(dir, record.current.dataFile) : null;
        if (blob) return { found: { record, data: await blob.arrayBuffer() }, positions, absent };
      }
      return { found: null, positions, absent };
    }, { disclose: true });
  }

  /**
   * The last step of a preview read, synchronous, after its outermost fence.
   * The read is STALE (read again) when it saw any entry of the file at an
   * older position than the newest preview read of the file, or than the
   * newest observation of that entry, did: an entry it found absent counts
   * at the read's absence position. Otherwise its entry's preview URL is
   * reused, or replaced when the generation changed. A newer entry that was
   * removed or published since does not hold back a fresh read: that read
   * saw the removal or publication, which is newer.
   */
  private deliverPendingDescriptor(fileId: string, read: PendingRead): PendingLocalDescriptor | null | typeof STALE {
    const seen = this.fileView.get(fileId) ?? new Map<string, Position>();
    const view = new Map<string, Position>();
    for (const entryId of new Set([...read.positions.keys(), ...seen.keys()])) {
      const position = read.positions.get(entryId) ?? read.absent;
      if (isBefore(position, seen.get(entryId)) || isBefore(position, this.applied.get(entryId))) return STALE;
      view.set(entryId, position);
    }
    if (read.found && (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function')) {
      const error = new Error('Local preview unavailable') as Error & { code?: string };
      error.code = 'FILEFN_OFFLINE_PREVIEW_UNSUPPORTED';
      throw error;
    }
    this.fileView.set(fileId, view);
    if (!read.found) return null;
    const { record, data } = read.found;
    this.applied.set(record.entryId, positionOf(record));
    const cur = record.current;
    let cached = this.objectUrls.get(record.entryId);
    if (!cached || cached.operationId !== cur.operationId) {
      this.revokeObjectUrl(record.entryId);
      cached = { operationId: cur.operationId, url: URL.createObjectURL(new Blob([data], { type: cur.mimeType })) };
      this.objectUrls.set(record.entryId, cached);
    }
    return {
      fileId: cur.fileId,
      uploadSessionId: cur.operationId,
      state: 'pending-local',
      source: { ...cur.localSource, url: cached.url },
    };
  }

  /**
   * Unscoped uploads staged by `@filefn/client` 0.4 and earlier. Never listed
   * or replayed automatically; read only through this call, and only while
   * the current principal is the partition's.
   */
  async listLegacyUploads(): Promise<LegacyPendingUploadSummary[]> {
    const store = this.legacyStore();
    return this.disclosing(() => this.transact(async () => {
      const summaries: LegacyPendingUploadSummary[] = [];
      for (const uploadSessionId of await store.listPendingUploads()) {
        const upload = await store.getPendingUpload(uploadSessionId);
        if (!upload) continue;
        summaries.push({
          uploadSessionId,
          ...(upload.fileId ? { fileId: upload.fileId } : {}),
          fileName: upload.fileName,
          mimeType: upload.mimeType,
          size: upload.size,
          createdAt: upload.createdAt,
        });
      }
      return summaries;
    }, { disclose: true }));
  }

  /**
   * Moves one legacy upload into this partition. The caller must have its own
   * evidence that the upload belongs to this partition's principal, and says
   * so with `ownershipVerified: true`. It becomes a new entry (`entryId`
   * defaults to its file ID; an existing entry is a `generation-conflict`).
   * A legacy upload is admitted once, whatever the entry ID and however many
   * tabs or partitions migrate it: the whole migration runs under one lock of
   * the legacy directory, and a claim naming the admitting partition is
   * written before the entry. A repeat in that partition returns the entry it
   * became, or `already-migrated` once that entry is gone or replaced; another
   * partition gets `already-migrated`. The legacy record is removed only
   * after the new entry is written. Its replay key is taken over (so a session
   * it completed is reconciled, not uploaded again) only when no other legacy
   * upload and no generation of the partition has used that key; otherwise
   * the entry gets a fresh key.
   */
  async migrateLegacyUpload(
    uploadSessionId: string,
    options: { ownershipVerified: true; entryId?: string },
  ): Promise<OfflineQueueStageResult> {
    this.assertUsable();
    if (options?.ownershipVerified !== true) {
      throw new OfflineQueueError('FILEFN_QUEUE_MIGRATION_UNVERIFIED', 'Migration needs independent ownership evidence', { uploadSessionId });
    }
    const store = this.legacyStore();
    const claimName = (await sha256Hex(JSON.stringify(['legacy', uploadSessionId]))).slice(0, 40);
    const claimsDirName = (await sha256Hex(this.legacyRootDirName)).slice(0, 40);
    const claimsDir = async (root: OfflineQueueDirectoryHandle) => {
      const claims = await root.getDirectoryHandle(LEGACY_CLAIMS_DIR, { create: true });
      return claims.getDirectoryHandle(claimsDirName, { create: true });
    };
    // Reading creates nothing: a missing claims directory means no claim.
    const readClaim = async (root: OfflineQueueDirectoryHandle): Promise<Blob | null> => {
      try {
        const claims = await root.getDirectoryHandle(LEGACY_CLAIMS_DIR);
        return await getFile(await claims.getDirectoryHandle(claimsDirName), claimName);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    };
    const partitionId = await this.partitionId();
    // Out of storage while preparing, reading or claiming: the typed capacity
    // refusal. Nothing is removed, so the legacy upload (and a claim already
    // written) stays and a retry completes the migration.
    const quotaRefusal = async (): Promise<OfflineQueueStageResult> => {
      let usage: OfflineQueueUsage = { entries: 0, bytes: 0 };
      try {
        usage = await this.usage();
      } catch (error) {
        if (!isQuotaError(error)) throw error;
      }
      return { status: 'refused', reason: 'capacity', limit: 'quota', usage, limits: this.limits };
    };
    // Fenced at the outermost boundary, after the legacy lock (whose
    // coordinator may return late) and every transaction inside it.
    return this.disclosing<OfflineQueueStageResult>((after) => this.withLegacyLock(async () => {
      // Read under the partition lock and the principal check, like every other read.
      let found;
      try {
        found = await this.readLegacyForMigration(readClaim, store, uploadSessionId);
      } catch (error) {
        if (isQuotaError(error)) return quotaRefusal();
        throw error;
      }
      const claim = found.claim;
      const claimedHere = claim !== null && claim !== 'unreadable' && claim.partitionId === partitionId && claim.queueRoot === this.rootDirName;
      if (claim !== null && !claimedHere) {
        // Another destination (partition or queue root) admitted it, or the
        // claim cannot be read: its own retry removes the record.
        return { status: 'refused', reason: 'already-migrated' } as const;
      }
      const legacy = found.legacy;
      if (!legacy) {
        if (claimedHere) {
          // Admitted here and removed since (by another tab's migration, say): the entry it became.
          let admitted;
          try {
            admitted = await this.transact(async (root) => {
              const partitionDir = await this.partitionDir(root);
              const record = (await this.readAllIn(partitionDir)).find((r) => r.migratedFrom === uploadSessionId);
              return { record, gone: (await this.loadMeta(partitionDir)).migrated.includes(uploadSessionId) };
            }, { disclose: true });
          } catch (error) {
            if (isQuotaError(error)) return quotaRefusal();
            throw error;
          }
          if (admitted.record) return { status: 'staged', entry: snapshot(admitted.record) } as const;
          if (admitted.gone) return { status: 'refused', reason: 'already-migrated' } as const;
        }
        throw new OfflineQueueError('FILEFN_QUEUE_NOT_FOUND', 'Legacy upload not found', { uploadSessionId });
      }
      assertValidExplicitFileId(legacy.fileId);
      const fileId = legacy.fileId ?? generateFileId();
      // A retry recovers the admission its claim names (entry ID included),
      // whatever entry ID it asks for.
      const entryId = claimedHere ? (claim as LegacyClaim).entryId : requireId(options.entryId ?? fileId, 'entryId');
      const admissionId = claimedHere ? (claim as LegacyClaim).admissionId : randomId('adm');
      if (!claimedHere) {
        // Written before the entry: no other destination (partition or
        // queue root) admits it from here on.
        const written: LegacyClaim = { v: 2, partitionId, queueRoot: this.rootDirName, entryId, uploadSessionId, admissionId };
        try {
          await this.transact(async (root) => {
            await writeFile(await claimsDir(root), claimName, JSON.stringify(written), this.txFence);
          });
        } catch (error) {
          if (isQuotaError(error)) return quotaRefusal();
          throw error;
        }
      }
      const result = await this.stageBytes(
        {
          entryId,
          // Never supersedes an existing entry: that is refused as a generation conflict.
          expectedGeneration: 0,
          policy: legacy.policy,
          file: new Blob([]),
          fileName: legacy.fileName,
          mimeType: legacy.mimeType,
          fileId,
          metadata: legacy.metadata,
          localSource: legacy.localSource,
        },
        legacy.fileData,
        { source: uploadSessionId, key: legacy.idempotencyKey, keyShared: found.keyShared, admissionId },
        after,
      );
      if (
        result.status === 'refused' &&
        (result.reason === 'generation-conflict' || result.reason === 'publication-pending' || result.reason === 'capacity')
      ) {
        // Refused in the transaction that found no admission of this upload
        // in the partition: nothing was admitted. The claim goes (still under
        // the legacy lock), so a retry may choose a free entry ID; one that
        // committed, or whose outcome is unknown (a principal switch), keeps
        // its claim and destination.
        await this.transact(async (root) => {
          let claims: OfflineQueueDirectoryHandle;
          try {
            claims = await (await root.getDirectoryHandle(LEGACY_CLAIMS_DIR)).getDirectoryHandle(claimsDirName);
          } catch (error) {
            if (isNotFound(error)) return;
            throw error;
          }
          if (await getFile(claims, claimName)) await this.removePath(claims, claimName);
        });
        return result;
      }
      if (result.status === 'staged' || (result.status === 'refused' && result.reason === 'already-migrated')) {
        // Removed under the partition lock, behind the principal check; the
        // claim stays. A switch during that cleanup keeps the entry and its
        // admission with their owner, and this caller gets no entry of it.
        try {
          await this.transact(() => store.deletePendingUpload(uploadSessionId));
        } catch (error) {
          if (isPrincipalMismatch(error)) return { status: 'refused', reason: 'principal-mismatch' } as const;
          throw error;
        }
      }
      return result;
    }), MISMATCH_REFUSAL);
  }

  // ---- internals ----

  /** The legacy upload, the partition that claimed it (if any) and whether its key is shared, read behind the principal check. */
  private async readLegacyForMigration(
    readClaim: (root: OfflineQueueDirectoryHandle) => Promise<Blob | null>,
    store: OPFSStore,
    uploadSessionId: string,
  ) {
    return this.transact(async (root) => {
      const blob = await readClaim(root);
      // A read error propagates (it says nothing about the claim). Content
      // that does not parse is a claim write that never committed (OPFS
      // commits on close): no claim. A committed claim that does not name a
      // whole destination is never taken for "no claim": that would admit
      // the upload twice.
      let claim: LegacyClaim | 'unreadable' | null = null;
      if (blob) {
        const text = await blob.text();
        let parsed: Partial<LegacyClaim> | null = null;
        try {
          parsed = JSON.parse(text) as Partial<LegacyClaim>;
        } catch {
          parsed = null;
        }
        if (parsed !== null) {
          claim =
            typeof parsed === 'object' &&
            typeof parsed.partitionId === 'string' &&
            typeof parsed.queueRoot === 'string' &&
            typeof parsed.entryId === 'string' &&
            typeof parsed.admissionId === 'string'
              ? (parsed as LegacyClaim)
              : 'unreadable';
        }
      }
      const legacy = await store.getPendingUpload(uploadSessionId);
      let keyShared = false;
      if (legacy?.idempotencyKey !== undefined) {
        for (const other of await store.listPendingUploads()) {
          if (other === uploadSessionId) continue;
          if ((await store.getPendingUploadMetadata(other))?.idempotencyKey === legacy.idempotencyKey) {
            keyShared = true;
            break;
          }
        }
      }
      return { claim, legacy, keyShared };
    }, { disclose: true });
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new OfflineQueueError('FILEFN_QUEUE_DISPOSED', 'Offline queue was disposed');
    }
    const capability = this.capabilities();
    if (!capability.durable) {
      throw capability.reason === 'locks-unavailable'
        ? new OfflineQueueError('FILEFN_QUEUE_LOCKS_UNAVAILABLE', 'Web Locks are unavailable and no coordinator was supplied')
        : new OfflineQueueError('FILEFN_QUEUE_STORAGE_UNAVAILABLE', 'OPFS is unavailable');
    }
  }

  /**
   * Whether the credentials in use act for this partition's principal right
   * now. Every principal check of the queue goes through here, so the first
   * one that fails (any fence, `principalIsCurrent`, an event or waiter
   * delivery) revokes every preview URL this instance issued: a switched tab
   * keeps no `blob:` URL that still serves the old principal's bytes.
   */
  private async principalMatches(signal: AbortSignal): Promise<boolean> {
    let matches: boolean;
    try {
      // Raced with the caller's signal and the queue's lifetime: a check that
      // never settles cannot keep the lock it runs under after a disposal.
      const principal = await raceCallerCallback(
        (raced) => this.options.currentPrincipal(raced),
        [signal, this.lifetime.signal],
      );
      matches =
        Boolean(principal) &&
        partitionIdentity(normalizeOfflineQueuePartition({ serviceId: this.partition.serviceId, principal: principal! })) === this.identity;
    } catch {
      // Stopped, not answered: no mismatch was observed, so nothing is revoked.
      if (signal.aborted || this.lifetime.signal.aborted) return false;
      matches = false;
    }
    if (!matches) this.revokeAllObjectUrls();
    return matches;
  }

  /**
   * The fence a public result carrying entry data passes after the last
   * callback (listener, work listener, waiter) its call ran: throws
   * FILEFN_QUEUE_DISPOSED, an AbortError once `signal` aborted, or
   * FILEFN_QUEUE_PRINCIPAL_MISMATCH, so a callback that switched the account
   * or stopped the call gets no entry of the old principal returned.
   */
  private async discloseFence(signal?: AbortSignal): Promise<void> {
    this.assertUsable();
    if (signal?.aborted) throw abortError();
    await this.assertPrincipal(signal ?? this.lifetime.signal);
    this.assertUsable();
    if (signal?.aborted) throw abortError();
  }

  /**
   * The outermost boundary of every public queue call that reads or writes
   * the journal: `run`'s result, or the error it threw (a conflict error may
   * name the current generation or attempt), reaches the caller only after
   * `discloseFence` passes, after every coordinator and transaction `run`
   * awaited (a lock coordinator may hand control back long after the work
   * inside it). On a principal mismatch the caller gets `onMismatch()` (or
   * FILEFN_QUEUE_PRINCIPAL_MISMATCH) and nothing `run` read; a disposal
   * throws FILEFN_QUEUE_DISPOSED. What `run` journaled stays with its owner.
   * Waiters `run` would settle (`after`) settle only once the fence passed,
   * after the call returned, behind a fresh principal check. `deliver`, when
   * given, turns `run`'s result into the returned one synchronously after the
   * fence, so nothing awaited comes between its checks and the return.
   *
   * Wrapped: `stage`, `stageAdmitted`, `abortStaged`, `hold`, `release`,
   * `list`, `get`, `cancel`,
   * `reconcile`, `process` (whose pipeline results also pass `disclosePass`),
   * `processAll`, `reclaim`, `usage`, `getPendingLocalDescriptor`,
   * `listLegacyUploads` and `migrateLegacyUpload`. `whenSettled` waiters
   * settle only behind a fresh principal check (`settleAfterReturn`,
   * `observeFenced`).
   */
  private async disclosing<T, R = T>(
    run: (after: AfterReturn) => Promise<T>,
    onMismatch?: () => R,
    deliver?: (value: T) => R,
  ): Promise<R> {
    const deferred: Array<() => void> = [];
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await run((settle) => deferred.push(settle)) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    try {
      if (!outcome.ok && isPrincipalMismatch(outcome.error)) throw outcome.error;
      await this.discloseFence();
    } catch (fenceError) {
      if (onMismatch && isPrincipalMismatch(fenceError)) return onMismatch();
      throw fenceError;
    }
    if (!outcome.ok) {
      for (const settle of deferred) this.settleAfterReturn(settle);
      throw outcome.error;
    }
    // `deliver` is the result's last step, synchronous, after every await.
    const value = deliver ? deliver(outcome.value) : (outcome.value as unknown as R);
    for (const settle of deferred) this.settleAfterReturn(settle);
    return value;
  }

  /** `discloseFence` for a pass result: one with entry data becomes `stopped` when the fence fails. */
  private async disclosePass(result: OfflineQueueProcessResult, signal: AbortSignal | undefined): Promise<OfflineQueueProcessResult> {
    if (!('entry' in result)) return result;
    try {
      await this.discloseFence(signal);
    } catch (error) {
      const stopped = this.stoppedResult(error);
      if (stopped) return stopped;
      throw error;
    }
    return result;
  }

  private async assertPrincipal(signal: AbortSignal): Promise<void> {
    if (!(await this.principalMatches(signal))) {
      // A check stopped by a disposal or an abort is that, not a mismatch.
      this.assertUsable();
      if (signal.aborted) throw abortError();
      throw new OfflineQueueError('FILEFN_QUEUE_PRINCIPAL_MISMATCH', "The current principal is not this queue's");
    }
  }

  /**
   * The `assertPrincipal` given to uploaders and hooks: also rejects once
   * their step ended (its controller is aborted on release) or was stopped,
   * or the queue is disposed, before or during the check.
   */
  private async guardPrincipal(signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.disposed) throw abortError();
    await this.assertPrincipal(signal);
    if (signal.aborted || this.disposed) throw abortError();
  }

  /**
   * The upload's guard before each request: the principal (`guardPrincipal`),
   * then, under the partition lock, that the generation is still current and
   * not held. A hold taken by any tab therefore admits no further request of
   * an upload already running (FILEFN_QUEUE_HELD); the upload resumes under
   * the same key once released.
   */
  private async guardUpload(entryId: string, planned: GenerationState, signal: AbortSignal): Promise<void> {
    await this.guardPrincipal(signal);
    const state = await this.transact(async (root) => {
      const found = await this.readEntry(root, entryId);
      const cur = found?.record.current;
      if (!found || cur!.generation !== planned.generation || cur!.operationId !== planned.operationId) return 'gone';
      return found.record.holds.some((hold) => hold.operationId === planned.operationId) ? 'held' : 'ok';
    }, { signal });
    if (state === 'gone') throw generationGone(entryId, planned.generation);
    if (state === 'held') {
      throw new OfflineQueueError('FILEFN_QUEUE_HELD', 'The generation is held: no further upload request is sent until released', {
        entryId,
        generation: planned.generation,
      });
    }
    if (signal.aborted || this.disposed) throw abortError();
  }

  /** Runs `fn` under the lock of the legacy directory, shared by every partition and tab. */
  private async withLegacyLock<T>(fn: () => Promise<T>): Promise<T> {
    this.assertUsable();
    try {
      return await this.coordinator!.request(`filefn-offline-legacy:${this.legacyRootDirName}`, { signal: this.lifetime.signal }, fn);
    } catch (error) {
      if (this.disposed && isAbort(error)) throw new OfflineQueueError('FILEFN_QUEUE_DISPOSED', 'Offline queue was disposed');
      throw error;
    }
  }

  /** The partition's work channel, opened on first use (to listen or to announce). */
  private workChannel(): Promise<OfflineQueueChannel | undefined> {
    this.channelPromise ??= this.partitionLockName()
      .then((name) => {
        const channel = (this.options.channel ?? defaultChannel)(`${name}:work`);
        channel?.addEventListener('message', (event) => {
          const data = event?.data as { type?: unknown; from?: unknown } | undefined;
          if (data?.type === 'work' && data.from !== this.instanceId) this.notifyLocal();
        });
        return channel;
      })
      .catch(() => undefined);
    return this.channelPromise;
  }

  /** Tells the other tabs' queues of the partition that work may be runnable. Carries no entry data. */
  private announceWork(): void {
    this.posting = this.posting.then(async () => {
      const channel = await this.workChannel();
      try {
        channel?.postMessage({ type: 'work', from: this.instanceId });
      } catch {
        // A closed channel: the other tabs' idle polls find the work.
      }
    });
  }

  private legacyStore(): OPFSStore {
    const getRoot = this.getRoot!;
    return new OPFSStore({ rootDir: this.legacyRootDirName, getRoot });
  }

  private partitionId(): Promise<string> {
    this.partitionIdPromise ??= sha256Hex(this.identity).then((hex) => `p_${hex}`);
    return this.partitionIdPromise;
  }

  private async partitionLockName(): Promise<string> {
    return `filefn-offline-queue:${this.rootDirName}:${await this.partitionId()}`;
  }

  private async entryKey(entryId: string): Promise<string> {
    return `e_${(await sha256Hex(JSON.stringify(['entry', entryId]))).slice(0, 40)}`;
  }

  /**
   * Runs `fn` under the partition lock, behind a fence (see `Fence`) checked
   * once the lock is held, right before every file commit or removal `fn`
   * makes, and, with `disclose`, again before what `fn` read is returned.
   * Throws FILEFN_QUEUE_DISPOSED once disposed, an AbortError once `signal`
   * aborts, and FILEFN_QUEUE_PRINCIPAL_MISMATCH when the current principal is
   * not the partition's.
   */
  private async transact<T>(
    fn: (root: OfflineQueueDirectoryHandle) => Promise<T>,
    options: { signal?: AbortSignal; disclose?: boolean } = {},
  ): Promise<T> {
    this.assertUsable();
    const name = await this.partitionLockName();
    const root = await this.getRoot!();
    const signal = options.signal;
    const fence: Fence = async () => {
      this.assertUsable();
      if (signal?.aborted) throw abortError();
      await this.assertPrincipal(signal ?? this.lifetime.signal);
      this.assertUsable();
      if (signal?.aborted) throw abortError();
    };
    try {
      return await this.coordinator!.request(name, { signal: this.lifetime.signal }, async () => {
        await fence();
        this.txFence = fence;
        try {
          const value = await fn(root);
          if (options.disclose) await fence();
          return value;
        } finally {
          this.txFence = undefined;
        }
      });
    } catch (error) {
      if (this.disposed && isAbort(error)) {
        throw new OfflineQueueError('FILEFN_QUEUE_DISPOSED', 'Offline queue was disposed');
      }
      throw error;
    }
  }

  private async partitionDir(root: OfflineQueueDirectoryHandle): Promise<OfflineQueueDirectoryHandle> {
    const queueRoot = await root.getDirectoryHandle(this.rootDirName, { create: true });
    const layout = await queueRoot.getDirectoryHandle(LAYOUT_DIR, { create: true });
    return layout.getDirectoryHandle(await this.partitionId(), { create: true });
  }

  /** Reads a journal, returning null for a missing, unreadable, newer-version or foreign one. */
  private async readJournal(dir: OfflineQueueDirectoryHandle): Promise<JournalRecord | null> {
    const read = await this.inspectJournal(dir);
    return read.state === 'ok' ? read.record : null;
  }

  /**
   * Classifies a journal. OPFS commits a write only when it closes, so a
   * journal that does not parse (empty, or cut short) never held a committed
   * state: it is the remains of a first staging that crashed (`corrupt`), and
   * safe to remove. A newer layout or another binding is `foreign` and never
   * touched. Only content that was read and fails to parse is `corrupt`: a
   * read that fails (a transient NotReadableError, say) says nothing about
   * what is committed, so the error propagates and nothing is removed,
   * rebuilt or reused on the strength of it.
   */
  private async inspectJournal(dir: OfflineQueueDirectoryHandle): Promise<JournalRead> {
    const blob = await getFile(dir, JOURNAL_FILE);
    if (!blob) return { state: 'missing' };
    const text = await blob.text();
    let parsed: JournalRecord;
    try {
      parsed = JSON.parse(text) as JournalRecord;
    } catch {
      return { state: 'corrupt' };
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.journalVersion !== 'number') return { state: 'corrupt' };
    if (parsed.journalVersion !== JOURNAL_VERSION || !parsed.binding) return { state: 'foreign' };
    // The binding is checked on every read, not only by directory.
    if (parsed.binding.partitionId !== (await this.partitionId()) || partitionIdentity(parsed.binding) !== this.identity) {
      return { state: 'foreign' };
    }
    if (!parsed.current || typeof parsed.current.generation !== 'number' || typeof parsed.entryId !== 'string') return { state: 'corrupt' };
    // A journal without recorded requirements needs every hook.
    parsed.current.requires ??= { verify: true, publish: true };
    return { state: 'ok', record: parsed };
  }

  /** Runs `fn` while holding the entry's own lock, or returns BUSY when another tab or call holds it. */
  private async withEntryLock<T>(entryId: string, fn: () => Promise<T>): Promise<T | typeof BUSY> {
    this.assertUsable();
    const lockName = `${await this.partitionLockName()}:entry:${await this.entryKey(entryId)}`;
    return this.coordinator!.request(lockName, { ifAvailable: true }, async (lock) => (lock ? fn() : BUSY));
  }

  /**
   * The partition's meta file. A missing one, or one whose content does not
   * parse (never committed), is rebuilt: its generation counter from the
   * journals, with no tombstones or migration marks. A read that fails
   * propagates: the committed meta may hold a higher counter, tombstones and
   * migration marks, so it is never rebuilt (or overwritten) from a failure.
   */
  private async loadMeta(partitionDir: OfflineQueueDirectoryHandle): Promise<PartitionMeta> {
    const partitionId = await this.partitionId();
    const blob = await getFile(partitionDir, PARTITION_META_FILE);
    if (blob) {
      const text = await blob.text();
      try {
        const meta = JSON.parse(text) as Partial<PartitionMeta>;
        if (meta.partitionId === partitionId && Number.isSafeInteger(meta.lastGeneration)) {
          return {
            journalVersion: JOURNAL_VERSION,
            partitionId,
            lastGeneration: meta.lastGeneration!,
            migrated: Array.isArray(meta.migrated) ? meta.migrated.filter((id) => typeof id === 'string') : [],
            migratedKeys: Array.isArray(meta.migratedKeys) ? meta.migratedKeys.filter((key) => typeof key === 'string') : [],
            tombstones: Array.isArray(meta.tombstones) ? meta.tombstones : [],
          };
        }
      } catch {
        // Cut short by a crash: rebuilt below.
      }
    }
    let lastGeneration = 0;
    for (const record of await this.readAllIn(partitionDir)) lastGeneration = Math.max(lastGeneration, record.current.generation);
    // Keys of migrations the lost meta recorded are found in the journals that took them over.
    return { journalVersion: JOURNAL_VERSION, partitionId, lastGeneration, migrated: [], migratedKeys: [], tombstones: [] };
  }

  private async writeMeta(partitionDir: OfflineQueueDirectoryHandle, meta: PartitionMeta): Promise<void> {
    await writeFile(partitionDir, PARTITION_META_FILE, JSON.stringify(meta), this.txFence);
  }

  /** Removes a file or directory once the transaction's fence passes. */
  private async removePath(dir: OfflineQueueDirectoryHandle, name: string, recursive = false): Promise<void> {
    await this.txFence?.();
    await removeEntry(dir, name, recursive);
  }

  private notifyWork(): void {
    if (this.disposed) return;
    this.notifyLocal();
    this.announceWork();
  }

  private notifyLocal(): void {
    if (this.disposed) return;
    for (const listener of [...this.workListeners]) {
      try {
        listener();
      } catch {
        // A listener error does not affect the queue.
      }
    }
  }

  /**
   * Written before journals are removed or replaced by a new generation: a
   * tombstone for each published generation (so waiters in other tabs still
   * see it published), and the legacy source and taken-over key of each
   * migrated generation (so neither is admitted or taken over again).
   */
  private async noteRemoval(partitionDir: OfflineQueueDirectoryHandle, records: JournalRecord[]): Promise<void> {
    const published = records.filter((record) => record.current.phase === 'published');
    const migrated = records.flatMap((record) => (record.migratedFrom ? [record.migratedFrom] : []));
    const migratedKeys = records.flatMap((record) => (record.migratedKey ? [record.migratedKey] : []));
    if (published.length === 0 && migrated.length === 0) return;
    const meta = await this.loadMeta(partitionDir);
    const now = Date.now();
    const removedAt = new Date(now).toISOString();
    meta.migrated = [...new Set([...meta.migrated, ...migrated])];
    meta.migratedKeys = [...new Set([...meta.migratedKeys, ...migratedKeys])];
    const kept = meta.tombstones.filter(
      (tombstone) =>
        now - Date.parse(tombstone.removedAt) < this.terminalRetentionMs &&
        !published.some((record) => record.entryId === tombstone.entryId && record.current.generation === tombstone.generation),
    );
    meta.tombstones = [
      ...kept,
      ...published.map((record) => ({ entryId: record.entryId, generation: record.current.generation, removedAt, entry: snapshot(record) })),
    ].slice(-MAX_TOMBSTONES);
    await this.writeMeta(partitionDir, meta);
  }

  private async readEntry(
    root: OfflineQueueDirectoryHandle,
    entryId: string,
  ): Promise<{ dir: OfflineQueueDirectoryHandle; record: JournalRecord } | null> {
    const dir = await getDir(await this.partitionDir(root), await this.entryKey(entryId));
    if (!dir) return null;
    const record = await this.readJournal(dir);
    return record && record.entryId === entryId ? { dir, record } : null;
  }

  private async requireRecord(root: OfflineQueueDirectoryHandle, entryId: string) {
    const found = await this.readEntry(root, entryId);
    if (!found) throw new OfflineQueueError('FILEFN_QUEUE_NOT_FOUND', 'Entry not found', { entryId });
    return found;
  }

  private async readAll(root: OfflineQueueDirectoryHandle): Promise<JournalRecord[]> {
    return this.readAllIn(await this.partitionDir(root));
  }

  private async readAllIn(partitionDir: OfflineQueueDirectoryHandle): Promise<JournalRecord[]> {
    const records: JournalRecord[] = [];
    for (const name of await listNames(partitionDir, 'directory')) {
      const dir = await getDir(partitionDir, name);
      const record = dir ? await this.readJournal(dir) : null;
      if (record && name === (await this.entryKey(record.entryId))) records.push(record);
    }
    return records;
  }

  private async writeRecord(dir: OfflineQueueDirectoryHandle, record: JournalRecord): Promise<void> {
    // Every write of a generation that is not final journals this instance's
    // hooks as requirements in the same write (steps, manual reconcile, holds,
    // cleanup alike), so no path that moves or reopens it lets a later
    // instance without one of those hooks skip its step.
    const hooks = this.options.hooks;
    if (!isTerminalPhase(record.current.phase)) {
      record.current.requires.verify ||= Boolean(hooks?.verify);
      record.current.requires.publish ||= Boolean(hooks?.publish);
    }
    record.revision += 1;
    record.updatedAt = new Date().toISOString();
    await writeFile(dir, JOURNAL_FILE, JSON.stringify(record), this.txFence);
  }

  /** Reads one entry (or its tombstone) and settles its waiters from what it finds. */
  /** Reads the entry and settles its waiters from it, behind a principal check. */
  private async lookup(entryId: string): Promise<void> {
    const found = await this.read(entryId);
    this.settleAfterReturn(found.settle);
  }

  /**
   * The entry as journaled, and how to settle its waiters from that read.
   * Arms (see `Waiter.from`) the entry's waiters registered before the read,
   * at the position it read, under the partition lock.
   */
  private async read(entryId: string): Promise<{ record: JournalRecord | null; settle: () => void }> {
    const { record, meta } = await this.transact(async (root) => {
      const found = await this.readEntry(root, entryId);
      const meta = await this.loadMeta(await this.partitionDir(root));
      const record = found?.record ?? null;
      const position = record ? positionOf(record) : absentAt(meta.lastGeneration);
      for (const waiter of this.waiters.get(entryId) ?? []) waiter.from ??= position;
      return { record, meta };
    }, { disclose: true });
    return {
      record,
      settle: () => (record ? this.observe(record, meta.tombstones) : this.settleAbsent(entryId, meta.tombstones, meta.lastGeneration)),
    };
  }

  /**
   * Settles waiters (`whenSettled`) from a read only after the public call
   * that read it has returned its result, and only behind a fresh principal
   * check. A waiter's callback runs user code that may switch the account:
   * run after the result was fenced and returned, it can never make that
   * call hand the old principal's entry to the new one, and a switch before
   * it leaves the waiters pending for a read under their own principal.
   */
  private settleAfterReturn(settle: () => void): void {
    queueMicrotask(() => {
      void (async () => {
        if (this.disposed) return;
        if (!(await this.principalMatches(this.lifetime.signal))) return;
        if (this.disposed) return;
        settle();
      })().catch(() => {});
    });
  }

  private async stageBytes(
    input: OfflineQueueStageInput & { entryId: string; fileId: string; fileName: string; mimeType: string; admissionHoldId?: string },
    bytes: ArrayBuffer,
    migration: { source: string; key?: string; keyShared?: boolean; admissionId?: string } | undefined,
    after: AfterReturn,
  ): Promise<OfflineQueueStageResult> {
    const localSource = input.localSource ?? derivePendingLocalSource(input.fileName, input.mimeType, bytes.byteLength);
    let outcome;
    try {
      outcome = await this.transact(async (root) => {
        let partitionDir: OfflineQueueDirectoryHandle | undefined;
        let result: Awaited<ReturnType<OfflineQueue['stageIn']>>;
        const quotaRefusal = async () => {
          const usage = partitionDir ? await this.measure(partitionDir) : { entries: 0, bytes: 0 };
          return { status: 'refused', reason: 'capacity', limit: 'quota', usage, limits: this.limits } as const;
        };
        try {
          partitionDir = await this.partitionDir(root);
          result = await this.stageIn(partitionDir, input, bytes, localSource, migration);
        } catch (error) {
          if (!isQuotaError(error)) throw error;
          // Out of storage: the same safe reclamation as for the configured
          // limits (published data and orphans of this partition, never
          // pending or provisional data, nor the entry being staged), then
          // one more admission. Refused (typed) only when that makes no room.
          let freed = false;
          if (partitionDir) {
            try {
              const reclaimed = await this.reclaimIn(partitionDir, true, await this.entryKey(input.entryId));
              freed = reclaimed.removedEntries + reclaimed.removedFiles > 0;
            } catch (reclaimError) {
              if (!isQuotaError(reclaimError)) throw reclaimError;
            }
          }
          if (!freed) {
            result = await quotaRefusal();
          } else {
            try {
              result = await this.stageIn(partitionDir!, input, bytes, localSource, migration);
            } catch (retryError) {
              if (!isQuotaError(retryError)) throw retryError;
              result = await quotaRefusal();
            }
          }
        }
        // Whatever is returned, observed or settled passes the fence after the
        // staging's last storage step (the old data's removal included): after
        // a switch a committed staging stays for its principal, undisclosed.
        return result;
      }, { disclose: true });
    } catch (error) {
      if (isPrincipalMismatch(error)) return { status: 'refused', reason: 'principal-mismatch' };
      if (isQuotaError(error)) {
        // Out of storage before the partition could even be opened.
        return { status: 'refused', reason: 'capacity', limit: 'quota', usage: { entries: 0, bytes: 0 }, limits: this.limits };
      }
      throw error;
    }
    if (outcome.status !== 'staged') return outcome;
    // A generation staged held is not runnable: its release announces it.
    if (!outcome.holdId) this.notifyWork();
    // A work listener above may have switched the account: the caller's outer
    // fence (`disclosing`) keeps the staging committed for its principal and
    // returns no entry of it. Waiters of the superseded generation settle,
    // and its preview goes, after the result returned.
    const staged = outcome;
    after(() => this.observe(staged.record, staged.tombstones));
    const appHold = outcome.holdId && !outcome.record.holds.some((hold) => hold.holdId === outcome.holdId && hold.admission);
    return { status: 'staged', entry: snapshot(outcome.record), ...(appHold ? { holdId: outcome.holdId } : {}) };
  }

  private async stageIn(
    partitionDir: OfflineQueueDirectoryHandle,
    input: OfflineQueueStageInput & { entryId: string; fileId: string; fileName: string; mimeType: string },
    bytes: ArrayBuffer,
    localSource: PendingLocalSourceMetadata,
    migration: { source: string; key?: string; keyShared?: boolean; admissionId?: string } | undefined,
  ): Promise<
    | Exclude<OfflineQueueStageResult, { status: 'staged' }>
    | { status: 'staged'; record: JournalRecord; holdId: string | undefined; tombstones: Tombstone[] | undefined }
  > {
    const key = await this.entryKey(input.entryId);
    if (migration) {
      // Checked in the same transaction as the staging: one admission per legacy upload.
      const migrated = (await this.readAllIn(partitionDir)).find((record) => record.migratedFrom === migration.source);
      if (migrated) return { status: 'staged', record: migrated, holdId: undefined, tombstones: undefined };
      if ((await this.loadMeta(partitionDir)).migrated.includes(migration.source)) {
        return { status: 'refused', reason: 'already-migrated' };
      }
    }
    let existingDir = await getDir(partitionDir, key);
    const read = existingDir ? await this.inspectJournal(existingDir) : ({ state: 'missing' } as const);
    if (read.state === 'foreign' || (read.state === 'ok' && read.record.entryId !== input.entryId)) {
      // A journal this instance cannot own (newer layout or another binding) is never overwritten.
      throw new OfflineQueueError('FILEFN_QUEUE_INVALID_INPUT', 'Entry is owned by another journal', { entryId: input.entryId });
    }
    if (existingDir && read.state === 'corrupt') {
      // The remains of a first staging that crashed before its journal committed.
      await this.removePath(partitionDir, key, true);
      existingDir = null;
    }
    const previous = read.state === 'ok' ? read.record : null;
    const currentGeneration = previous?.current.generation ?? 0;
    if (input.expectedGeneration !== undefined && input.expectedGeneration !== currentGeneration) {
      return { status: 'refused', reason: 'generation-conflict', currentGeneration };
    }
    if (previous?.current.phase === 'publishing') {
      return { status: 'refused', reason: 'publication-pending', currentGeneration };
    }
    // A new generation replaces the previous one's data: only bytes actually present are credited.
    const replacedBytes = previous && existingDir ? ((await getFile(existingDir, previous.current.dataFile))?.size ?? 0) : 0;
    const refusal = await this.ensureCapacity(partitionDir, existingDir ? 0 : 1, bytes.byteLength - replacedBytes, key);
    if (refusal) return refusal;

    // A replaced published generation keeps reporting published to its
    // waiters, here and in other tabs; a replaced migrated one keeps its
    // legacy source and key from being admitted or taken over again.
    if (previous && (previous.current.phase === 'published' || previous.migratedFrom)) {
      await this.noteRemoval(partitionDir, [previous]);
    }
    const meta = await this.loadMeta(partitionDir);
    const generation = Math.max(meta.lastGeneration, currentGeneration) + 1;
    meta.lastGeneration = generation;
    const operationId = randomId('op');
    let idempotencyKey = replayKey(input.idempotencyKey, operationId);
    let migratedKey: string | undefined;
    if (migration?.key !== undefined && isValidIdempotencyKey(migration.key)) {
      // A legacy upload takes over its own key (no other legacy upload uses
      // it, see migrateLegacyUpload), so a session it completed is reconciled
      // rather than uploaded again, unless a generation of the partition used
      // it: then it gets a fresh key, so it can never be confirmed with
      // another upload's stored version. Recorded only in the journal written
      // below, so a staging that fails takes nothing over.
      const legacyKey = migration.key;
      if (migration.keyShared && !meta.migratedKeys.includes(legacyKey)) {
        // Shared by several legacy uploads: never taken over by any of them,
        // even once the others are gone.
        meta.migratedKeys = [...meta.migratedKeys, legacyKey];
      }
      const taken =
        meta.migratedKeys.includes(legacyKey) ||
        (await this.readAllIn(partitionDir)).some(
          (record) =>
            record.migratedKey === legacyKey ||
            record.current.replay.idempotencyKey === legacyKey ||
            record.current.replay.retiredKeys.includes(legacyKey),
        );
      if (!taken) {
        idempotencyKey = legacyKey;
        migratedKey = legacyKey;
      }
    }
    // Written before the journal that uses it, so a generation number is never handed out twice.
    await this.writeMeta(partitionDir, meta);
    const dataFile = `g${generation}.bin`;
    const dir = existingDir ?? (await partitionDir.getDirectoryHandle(key, { create: true }));
    const hooks = this.options.hooks;
    const now = new Date().toISOString();
    const current: GenerationState = {
      generation,
      operationId,
      dataFile,
      fileId: input.fileId,
      policy: input.policy,
      fileName: input.fileName,
      mimeType: input.mimeType,
      size: bytes.byteLength,
      ...(input.metadata !== undefined ? { metadata: toJson(input.metadata) as Record<string, unknown> } : {}),
      localSource: { ...localSource, opfsDataFile: dataFile },
      replay: { idempotencyKey, retiredKeys: [] },
      requires: { verify: Boolean(hooks?.verify), publish: Boolean(hooks?.publish) },
      attempts: 0,
      phase: 'staged',
    };
    const admissionHoldId = (input as { admissionHoldId?: string }).admissionHoldId;
    const holdId = admissionHoldId ?? (input.hold ? randomId('hold') : undefined);
    const record: JournalRecord = {
      journalVersion: JOURNAL_VERSION,
      binding: { ...this.partition, partitionId: await this.partitionId() },
      entryId: input.entryId,
      revision: previous?.revision ?? 0,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      current,
      // Holds of earlier generations no longer apply.
      holds: holdId ? [{ holdId, generation, operationId, ...(admissionHoldId ? { admission: true as const } : {}) }] : [],
      ...(migration ? { migratedFrom: migration.source } : {}),
      ...(migration?.admissionId ? { migrationAdmission: migration.admissionId } : {}),
      ...(migratedKey !== undefined ? { migratedKey } : {}),
    };
    try {
      // Data first: a crash before the journal write leaves an orphan file, never a journal without data.
      await writeFile(dir, dataFile, bytes, this.txFence);
      await this.writeRecord(dir, record);
    } catch (error) {
      // Best effort: what is left is an orphan the next reclaim removes.
      await this.removePath(dir, dataFile).catch(() => {});
      if (!existingDir) await this.removePath(partitionDir, key, true).catch(() => {});
      throw error;
    }
    if (previous && previous.current.dataFile !== dataFile) {
      // Best effort: a leftover file is an orphan the next reclaim removes.
      await this.removePath(dir, previous.current.dataFile).catch(() => {});
    }
    return { status: 'staged', record, holdId, tombstones: meta.tombstones };
  }

  /** `target` is the entry being staged: reclamation never removes it, so the new generation keeps its directory. */
  private async ensureCapacity(
    partitionDir: OfflineQueueDirectoryHandle,
    addEntries: number,
    addBytes: number,
    target: string,
  ): Promise<Extract<OfflineQueueStageResult, { reason: 'capacity' }> | null> {
    const fits = (usage: OfflineQueueUsage) =>
      usage.entries + addEntries <= this.limits.maxEntries && usage.bytes + addBytes <= this.limits.maxBytes;
    let usage = await this.measure(partitionDir);
    if (fits(usage)) return null;
    await this.reclaimIn(partitionDir, true, target);
    usage = await this.measure(partitionDir);
    if (fits(usage)) return null;
    const limit = usage.entries + addEntries > this.limits.maxEntries ? 'entries' : 'bytes';
    return { status: 'refused', reason: 'capacity', limit, usage, limits: this.limits };
  }

  /** Entries are directories; bytes are every data file present, orphans included. */
  private async measure(partitionDir: OfflineQueueDirectoryHandle): Promise<OfflineQueueUsage> {
    let entries = 0;
    let bytes = 0;
    for (const name of await listNames(partitionDir, 'directory')) {
      const dir = await getDir(partitionDir, name);
      if (!dir) continue;
      entries += 1;
      for (const file of await listNames(dir, 'file')) {
        if (file === JOURNAL_FILE) continue;
        bytes += (await getFile(dir, file))?.size ?? 0;
      }
    }
    return { entries, bytes };
  }

  /**
   * Removes, under the partition lock: entry directories without a journal
   * (a staging that never committed), data files the journal does not name,
   * the data of a published generation, and published entries past their
   * retention (any age under `pressure`; a tombstone keeps reporting them
   * published). A journal that never committed (`corrupt`) counts as no
   * journal. Provisional entries and journals of another binding or layout
   * are never removed. Of `protect` (the entry being staged), only data
   * files its journal does not name are removed (all of them when it has no
   * committed journal): its journal and current data stay. A published
   * entry's data is removed before its tombstone is written, so the
   * tombstone write fits in the room the data frees.
   */
  private async reclaimIn(
    partitionDir: OfflineQueueDirectoryHandle,
    pressure: boolean,
    protect?: string,
  ): Promise<OfflineQueueReclaimResult> {
    const result: OfflineQueueReclaimResult = { removedEntries: 0, removedFiles: 0, freedBytes: 0 };
    const now = Date.now();
    for (const name of await listNames(partitionDir, 'directory')) {
      const dir = await getDir(partitionDir, name);
      if (!dir) continue;
      const files = await listNames(dir, 'file');
      const dataBytes = async (file: string) => (await getFile(dir, file))?.size ?? 0;
      const read = await this.inspectJournal(dir);
      if (name === protect) {
        if (read.state === 'foreign') continue;
        // Without a committed journal (a first staging that crashed before
        // it), no file of the entry is named by anything: all its data goes,
        // so the restage that follows is not refused for its own remains.
        const named = read.state === 'ok' ? read.record.current.dataFile : undefined;
        for (const file of files) {
          if (file === JOURNAL_FILE || file === named) continue;
          result.freedBytes += await dataBytes(file);
          await this.removePath(dir, file);
          result.removedFiles += 1;
        }
        continue;
      }
      if (read.state === 'missing' || read.state === 'corrupt') {
        for (const file of files) if (file !== JOURNAL_FILE) result.freedBytes += await dataBytes(file);
        await this.removePath(partitionDir, name, true);
        result.removedEntries += 1;
        continue;
      }
      if (read.state !== 'ok') continue;
      const record = read.record;
      const cur = record.current;
      if (cur.phase === 'published' && (pressure || now - Date.parse(record.updatedAt) >= this.terminalRetentionMs)) {
        // Its data goes first: out of storage, the tombstone write below
        // needs the room the data frees. A crash in between leaves a
        // published journal without data, which nothing reads and the next
        // reclamation removes the same way.
        for (const file of files) {
          if (file === JOURNAL_FILE) continue;
          result.freedBytes += await dataBytes(file);
          await this.removePath(dir, file);
        }
        await this.noteRemoval(partitionDir, [record]);
        await this.removePath(partitionDir, name, true);
        result.removedEntries += 1;
        continue;
      }
      let changed = false;
      for (const file of files) {
        if (file === JOURNAL_FILE) continue;
        const keep = file === cur.dataFile && cur.phase !== 'published';
        if (keep) continue;
        result.freedBytes += await dataBytes(file);
        await this.removePath(dir, file);
        result.removedFiles += 1;
        if (file === cur.dataFile) {
          cur.dataRemoved = true;
          changed = true;
        }
      }
      if (changed) await this.writeRecord(dir, record);
    }
    return result;
  }

  private async runPipeline(
    entryId: string,
    signal: AbortSignal | undefined,
    started: Promise<unknown>[],
  ): Promise<OfflineQueueProcessResult> {
    // The uploader's current replay scope, resolved outside the partition
    // lock (it may run app code) when an upload step needs it, for that
    // step's generation and operation only: a replacement or re-plan
    // resolves it again.
    let bound: ScopeResolution | undefined;
    for (;;) {
      let plan: Plan;
      try {
        plan = await this.transact((root) => this.planStep(root, entryId, signal, started, bound), { signal });
        if (plan.kind === 'resolve-scope') {
          const resolved = await this.resolveReplayScope(signal);
          bound = { ...resolved, for: { generation: plan.generation, operationId: plan.operationId } };
          continue;
        }
      } catch (error) {
        const stopped = this.stoppedResult(error);
        if (stopped) return stopped;
        throw error;
      }
      // A result returns entry data only after the fence that follows the
      // last listener or waiter its pass ran (see disclosePass).
      if (plan.kind === 'done') return this.disclosePass(plan.result, signal);
      if (plan.kind === 'continue') continue;
      const outcome = await this.finishStep(entryId, plan, signal);
      // Replaced or removed by another tab or call: entry-local, so the entry
      // is planned again (its new generation, or not-found) and the pass goes on.
      if (outcome === REPLAN) {
        bound = undefined;
        continue;
      }
      if (outcome) return this.disclosePass(outcome, signal);
    }
  }

  /**
   * Resolves the uploader's replay scope for the partition's principal,
   * behind a principal fence before and after. A principal mismatch, an
   * abort or a disposal stops the pass (thrown); any other rejection, or a
   * value that is not a scope, is returned as the step's error: nothing is
   * sent and the generation stays provisional.
   */
  private async resolveReplayScope(signal: AbortSignal | undefined): Promise<{ scope: string } | { error: unknown }> {
    const uploader = this.options.uploader;
    await this.discloseFence(signal);
    let scope: unknown;
    try {
      // Raced with the pass and the queue's lifetime (`raceCallerCallback`):
      // a resolver that never settles (or ignores its signal) cannot keep the
      // entry lock after an abort or disposal; its late result is discarded.
      scope = await raceCallerCallback(
        (raced) => uploader.replayScope!.call(uploader, this.partition.principal, raced),
        [signal, this.lifetime.signal],
      );
    } catch (error) {
      if (isPrincipalMismatch(error) || this.disposed || signal?.aborted) throw error;
      return { error };
    }
    await this.discloseFence(signal);
    if (!isReplayScope(scope)) {
      return { error: Object.assign(new Error('The uploader resolved no replay scope'), { code: 'FILEFN_REPLAY_SCOPE_UNCONFIRMED' }) };
    }
    return { scope };
  }

  /**
   * The entry-free result of a pass stopped by its signal or by a principal
   * mismatch; null for any other error. Throws FILEFN_QUEUE_DISPOSED once
   * disposed.
   */
  private stoppedResult(error: unknown): OfflineQueueProcessResult | null {
    this.assertUsable();
    if (isPrincipalMismatch(error)) return { status: 'stopped', reason: 'principal-mismatch' };
    if (isAbort(error)) return { status: 'stopped', reason: 'aborted' };
    return null;
  }

  /** Aborts when the queue is disposed, the caller's signal aborts or the entry is cancelled; `release` detaches it. */
  private stepController(
    entryId: string,
    operationId: string,
    signal: AbortSignal | undefined,
  ): { controller: AbortController; release: () => void } {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (this.lifetime.signal.aborted || signal?.aborted) controller.abort();
    this.lifetime.signal.addEventListener('abort', onAbort, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    const running = { operationId, controller };
    this.entryControllers.set(entryId, running);
    return {
      controller,
      release: () => {
        this.lifetime.signal.removeEventListener('abort', onAbort);
        signal?.removeEventListener('abort', onAbort);
        if (this.entryControllers.get(entryId) === running) this.entryControllers.delete(entryId);
        // The step is over: a helper or signal a hook kept from it is dead.
        controller.abort();
      },
    };
  }

  private operationContext(entryId: string, cur: GenerationState, signal: AbortSignal): OfflineQueueOperationContext {
    return {
      partition: this.partition,
      entryId,
      generation: cur.generation,
      operationId: cur.operationId,
      fileId: cur.upload?.fileId ?? cur.fileId,
      versionId: cur.upload?.versionId ?? '',
      ...(cur.publicationAttempt ? { publicationAttemptId: cur.publicationAttempt } : {}),
      signal,
      assertPrincipal: () => this.guardPrincipal(signal),
    };
  }

  /**
   * Decides the next step under the partition lock, which the transaction
   * entered only after checking the principal. Every write passes the
   * transaction's fence right before it commits, and an upload or hook starts
   * only after the claim it needs is journaled and the fence passed again,
   * in the same turn as that last check: nothing is written or started once
   * the caller's signal aborts, the queue is disposed or the principal
   * changes.
   */
  private async planStep(
    root: OfflineQueueDirectoryHandle,
    entryId: string,
    signal: AbortSignal | undefined,
    started: Promise<unknown>[],
    bound: ScopeResolution | undefined,
  ): Promise<Plan> {
    const found = await this.readEntry(root, entryId);
    if (!found) {
      const meta = await this.loadMeta(await this.partitionDir(root));
      await this.txFence!();
      // Its absence is an observation like any other (`settleAbsent`).
      if (!this.disposed && (await this.principalMatches(this.lifetime.signal))) {
        this.settleAbsent(entryId, meta.tombstones, meta.lastGeneration);
      }
      return { kind: 'done', result: { status: 'not-found' } };
    }
    const { dir, record } = found;
    const cur = record.current;
    // Whatever a pass returns, reports or settles passes the fence first, so
    // nothing read is disclosed once the principal changed or the pass stopped.
    const finish = async (result: OfflineQueueProcessResult, emit = false): Promise<Plan> => {
      await this.txFence!();
      if (emit) await this.emitFor(record, signal);
      await this.observeFenced(record);
      return { kind: 'done', result };
    };
    const provisional = (reason: Extract<OfflineQueueProcessResult, { status: 'provisional' }>['reason'], emit = false) =>
      finish({ status: 'provisional', entry: snapshot(record), reason }, emit);
    // An admission hold whose staging call is gone (returned, disposed, its
    // tab closed) no longer applies: dropped here, durably, before planning.
    const dead: string[] = [];
    for (const hold of record.holds) {
      if (hold.admission && !(await this.admissionLive(hold.holdId))) dead.push(hold.holdId);
    }
    if (dead.length > 0) {
      record.holds = record.holds.filter((hold) => !dead.includes(hold.holdId));
      await this.writeRecord(dir, record);
    }
    if (record.holds.some((hold) => hold.operationId === cur.operationId) && cur.phase !== 'published') {
      return provisional('held');
    }
    const hooks = this.options.hooks;
    const write = (): Promise<void> => this.writeRecord(dir, record);
    // This instance's hooks join the generation's requirements, journaled at
    // once (before any step, reconciliation included, can move the generation
    // on), so an instance without one of them never skips that step later.
    const adopt = { verify: !cur.requires.verify && Boolean(hooks?.verify), publish: !cur.requires.publish && Boolean(hooks?.publish) };
    if ((adopt.verify || adopt.publish) && !isTerminalPhase(cur.phase)) {
      cur.requires.verify ||= adopt.verify;
      cur.requires.publish ||= adopt.publish;
      await write();
    }
    // A required verifier that no hook has satisfied yet (the generation was
    // verified, or its publication started, while none was required).
    const verifyOwed = cur.requires.verify && cur.verification?.byHook !== true;
    const start = async (kind: StepKind, run: (controller: AbortController) => Promise<unknown>): Promise<Plan> => {
      await this.txFence!();
      // Same turn as the check: the work starts only for the partition's principal.
      const { controller, release } = this.stepController(entryId, cur.operationId, signal);
      const running = invoke(() => run(controller));
      started.push(running.catch(() => {}));
      return { kind, record: structuredClone(record), controller, release, running };
    };
    // Verified without a hook while none was required: a verifier that is
    // required now runs before publication.
    const reverify = cur.phase === 'verified' && verifyOwed;
    switch (reverify ? 'uploaded' : cur.phase) {
      case 'staged':
      case 'uploading': {
        if (cur.attempts >= this.maxUploadAttempts) {
          if (cur.pending?.reason !== 'retry-limit') {
            // Durable and reported once, so listeners, waiters and other tabs see it.
            cur.pending = { stage: 'upload', reason: 'retry-limit', ...(cur.error ? { message: cur.error.message } : {}) };
            await write();
            return provisional('retry-limit', true);
          }
          return provisional('retry-limit');
        }
        // The replay identity's account scope: journaled once, below, in the
        // write that claims the first upload step, and only compared after.
        // A resolution made for another generation or operation never applies.
        const scoped =
          bound && bound.for.generation === cur.generation && bound.for.operationId === cur.operationId ? bound : undefined;
        if (this.options.uploader.replayScope && !scoped) {
          return { kind: 'resolve-scope', generation: cur.generation, operationId: cur.operationId };
        }
        if (scoped) {
          const differs = 'scope' in scoped && cur.replay.scope !== undefined && cur.replay.scope !== scoped.scope;
          if ('error' in scoped || differs) {
            // Nothing is sent, and no attempt is used: provisional under the
            // same key and scope until the resolver returns the journaled
            // scope (a later pass resumes it by itself).
            const info = errorInfo(
              'error' in scoped
                ? scoped.error
                : Object.assign(new Error("The replay account's scope differs from the one journaled with the generation"), {
                    code: REPLAY_SCOPE_MISMATCH_ERROR,
                  }),
            );
            const changed = cur.pending?.reason !== 'scope-unconfirmed' || cur.error?.code !== info.code || cur.error?.message !== info.message;
            if (changed) {
              cur.error = info;
              cur.pending = { stage: 'upload', reason: 'scope-unconfirmed', message: info.message };
              await write();
            }
            return provisional('scope-unconfirmed', changed);
          }
        }
        const blob = await getFile(dir, cur.dataFile);
        if (!blob) {
          cur.phase = 'failed';
          cur.error = { code: 'FILEFN_QUEUE_DATA_MISSING', message: 'Staged data is missing' };
          await write();
          return provisional('failed', true);
        }
        const file = new File([await blob.arrayBuffer()], cur.fileName, { type: cur.mimeType });
        cur.phase = 'uploading';
        cur.claim = { instanceId: this.instanceId, at: new Date().toISOString() };
        // Ordered against an uploadFile abort by the partition lock: whichever
        // commits first wins (see abortStaged).
        cur.dispatched = true;
        if (scoped && 'scope' in scoped && cur.replay.scope === undefined) cur.replay.scope = scoped.scope;
        if (cur.pending?.reason === 'scope-unconfirmed') cur.pending = undefined;
        await write();
        return start('upload', (controller) =>
          this.options.uploader.upload({
            policy: cur.policy,
            file,
            fileName: cur.fileName,
            metadata: cur.metadata,
            fileId: cur.fileId,
            idempotencyKey: cur.replay.idempotencyKey,
            signal: controller.signal,
            assertPrincipal: () => this.guardUpload(entryId, cur, controller.signal),
            ...(cur.replay.scope !== undefined ? { replayScope: cur.replay.scope } : {}),
          }),
        );
      }
      case 'uploaded':
      case 'verifying': {
        // A verification that started (here or in another instance) is always required.
        const needsVerify = cur.requires.verify || cur.phase === 'verifying';
        if (needsVerify && !hooks?.verify) return provisional('hook-unavailable');
        if (!needsVerify) {
          cur.phase = 'verified';
          cur.verification = { verified: true, byHook: false };
          await write();
          return { kind: 'continue' };
        }
        cur.phase = 'verifying';
        cur.requires.verify = true;
        await write();
        const verify = hooks!.verify!;
        return start('verify', (controller) => verify(this.operationContext(entryId, cur, controller.signal)));
      }
      case 'verified': {
        if (cur.requires.publish && !hooks?.publish) return provisional('hook-unavailable');
        if (!cur.requires.publish) {
          cur.phase = 'published';
          cur.publication = {};
          await write();
          await this.txFence!();
          await this.emitFor(record, signal);
          return { kind: 'continue' };
        }
        // Recorded before the hook runs, so a crash leaves it unconfirmed rather than unpublished.
        cur.phase = 'publishing';
        cur.publicationAttempt = randomId('pub');
        cur.pending = undefined;
        await write();
        const publish = hooks!.publish!;
        return start('publish', (controller) => publish.run(this.operationContext(entryId, cur, controller.signal)));
      }
      case 'publishing': {
        const publish = hooks?.publish;
        if (publish?.reconcile) {
          // Settles the earlier attempt without a new one; `published: false`
          // reopens it at verified, where an owed verifier runs first.
          return start('reconcile-publication', (controller) => publish.reconcile!(this.operationContext(entryId, cur, controller.signal)));
        }
        if (publish?.idempotent && !verifyOwed) {
          // Each run is an attempt of its own (the operation ID stays): an
          // outcome established for an earlier run never settles this one.
          cur.publicationAttempt = randomId('pub');
          cur.pending = undefined;
          await write();
          return start('publish', (controller) => publish.run(this.operationContext(entryId, cur, controller.signal)));
        }
        // Not run again: either the hook is not idempotent, or a verifier is
        // now required that never ran, and another attempt would publish
        // unverified. The earlier attempt is settled by `reconcile` first.
        if (cur.pending?.reason !== 'needs-reconcile') {
          cur.pending = { stage: 'publication', reason: 'needs-reconcile' };
          await write();
        }
        return provisional('needs-reconcile');
      }
      case 'published':
        if (!cur.dataRemoved) {
          await this.removePath(dir, cur.dataFile);
          cur.dataRemoved = true;
          await write();
        }
        return finish({ status: 'published', entry: snapshot(record) });
      case 'rejected':
        return provisional('rejected');
      default:
        return provisional('failed');
    }
  }

  /** Waits for a started step and journals its outcome. Returns null to continue the pipeline. */
  private async finishStep(
    entryId: string,
    plan: Extract<Plan, { record: JournalRecord }>,
    signal: AbortSignal | undefined,
  ): Promise<OfflineQueueProcessResult | null | typeof REPLAN> {
    const { record, controller } = plan;
    let value: unknown;
    try {
      value = await raceAbort(plan.running, controller.signal);
    } catch (error) {
      // The step's own generation was replaced (a guard found it gone) or
      // cancelled (its controller aborted while neither the queue nor the
      // caller's pass stopped): nothing is recorded for it, no attempt is
      // used, and the pass goes on.
      if (
        !this.disposed &&
        !signal?.aborted &&
        !isPrincipalMismatch(error) &&
        (isGenerationGone(error) || controller.signal.aborted)
      ) {
        return REPLAN;
      }
      // Stopped, or the principal changed: nothing is recorded or returned.
      const stopped = this.stoppedResult(controller.signal.aborted && !isPrincipalMismatch(error) ? abortError() : error);
      if (stopped) return stopped;
      // A hold stopped the upload between requests: no attempt is used, and
      // the next step reports it held.
      if (plan.kind === 'upload' && isHeld(error)) return null;
      return this.recordFailure(entryId, plan, error, signal);
    } finally {
      plan.release();
    }
    switch (plan.kind) {
      case 'upload': {
        // The transport's decoder and schema (see `FileFnResult`): only a
        // success naming a stored file and version confirms anything.
        const decoded = decodeFileFnBody(value, uploadSchemas.stored);
        if (decoded.kind !== 'ok') return this.recordFailure(entryId, plan, decoded.error, signal);
        const result: UploadResult = { fileId: decoded.data.fileId, versionId: decoded.data.versionId };
        if (result.fileId !== record.current.fileId) {
          return this.commit(entryId, record, signal, (state) => {
            state.phase = 'failed';
            state.error = { code: 'FILEFN_CLIENT_FILE_ID_MISMATCH', message: 'Server stored a different fileId' };
            state.claim = undefined;
          }, 'failed');
        }
        return this.commit(entryId, record, signal, (state) => {
          state.phase = 'uploaded';
          state.upload = { fileId: result.fileId, versionId: result.versionId };
          state.pending = undefined;
          state.error = undefined;
          state.claim = undefined;
        });
      }
      case 'verify': {
        const outcome = verificationOutcome(value);
        if (outcome === null) {
          // Outside the hook's contract (extra keys, a class instance, a
          // non-string reason, ...): it decides nothing, so the generation
          // stays provisional and is verified again.
          return this.recordFailure(entryId, plan, new Error('verify resolved with a value that decides nothing'), signal);
        }
        if (outcome.verified === true) {
          return this.commit(entryId, record, signal, (state) => {
            state.phase = 'verified';
            state.verification = { verified: true, byHook: true };
            state.pending = undefined;
          });
        }
        if (outcome?.verified === false) {
          return this.commit(entryId, record, signal, (state) => {
            state.phase = 'rejected';
            state.verification = { verified: false, reason: outcome.reason, byHook: true };
            state.pending = undefined;
          }, 'rejected');
        }
        return this.recordFailure(entryId, plan, new Error('verify returned no outcome'), signal);
      }
      case 'publish': {
        const publication = publicationResult(value);
        if (publication === NOT_JSON) {
          // Outside the hook's contract: it confirms nothing.
          return this.recordFailure(entryId, plan, new Error('publish resolved with a value that confirms nothing'), signal);
        }
        return this.commit(entryId, record, signal, (state) => {
          state.phase = 'published';
          state.publication = publication;
          state.pending = undefined;
        });
      }
      case 'reconcile-publication': {
        // Only a plain check object of the documented keys counts (see isPublicationCheck).
        const check = isPlainEnvelope(value) && isPublicationCheck(value) ? (value as unknown as OfflineQueuePublicationCheck) : undefined;
        const checked = check?.published === true ? strictJson(check.result) : undefined;
        if (check?.published === true && checked !== NOT_JSON) {
          return this.commit(entryId, record, signal, (state) => {
            state.phase = 'published';
            state.publication = checked === undefined ? {} : { result: checked };
            state.pending = undefined;
          });
        }
        if (check?.published === false) {
          return this.commit(entryId, record, signal, (state) => {
            state.phase = 'verified';
            state.pending = undefined;
          });
        }
        return this.recordFailure(entryId, plan, new Error('reconcile returned no outcome'), signal);
      }
    }
  }

  /**
   * Journals a failed step. An upload's confirmed session end retires its key
   * for a fresh one; a permanent refusal fails the generation; anything else
   * leaves it provisional (`ambiguous`) under the same identity. Failed and
   * ambiguous uploads count towards the attempt limit.
   */
  private async recordFailure(
    entryId: string,
    plan: Extract<Plan, { record: JournalRecord }>,
    error: unknown,
    signal: AbortSignal | undefined,
  ): Promise<OfflineQueueProcessResult | null> {
    const info = errorInfo(error);
    if (plan.kind === 'upload') {
      if (isSessionEnded(error)) {
        // Confirmed final: a fresh key is journaled before the next request uses it.
        return this.commit(entryId, plan.record, signal, (state) => {
          state.replay.retiredKeys.push(state.replay.idempotencyKey);
          state.replay.idempotencyKey = randomId('idem');
          state.phase = 'staged';
          state.attempts += 1;
          state.error = info;
          state.pending = undefined;
          state.claim = undefined;
        });
      }
      if (isPermanentUploadError(error)) {
        return this.commit(entryId, plan.record, signal, (state) => {
          state.phase = 'failed';
          state.attempts += 1;
          state.error = info;
          state.claim = undefined;
        }, 'failed');
      }
    }
    const stage: OfflineQueuePending['stage'] =
      plan.kind === 'upload' ? 'upload' : plan.kind === 'verify' ? 'verification' : 'publication';
    const result = await this.commit(entryId, plan.record, signal, (state) => {
      state.pending = { stage, reason: 'ambiguous', message: info.message };
      if (plan.kind === 'upload') {
        state.attempts += 1;
        state.error = info;
      }
    }, 'ambiguous');
    return result ?? { status: 'superseded' };
  }

  /**
   * Applies `mutate` only if the entry is still at the planned generation,
   * operation, phase and publication attempt, behind the transaction's fence
   * (the current principal is the partition's, and neither the queue nor the
   * caller's pass has stopped, right before the write commits). A newer
   * generation is never touched by an older one's result; a stopped or
   * switched pass records nothing and returns no entry, leaving the outcome
   * for the next live pass to replay or reconcile. Returns null to continue
   * the pipeline, or the result.
   */
  private async commit(
    entryId: string,
    planned: JournalRecord,
    signal: AbortSignal | undefined,
    mutate: (state: GenerationState) => void,
    stopReason?: 'rejected' | 'failed' | 'ambiguous',
  ): Promise<OfflineQueueProcessResult | null> {
    let written: JournalRecord | null;
    try {
      written = await this.transact(async (root) => {
        const found = await this.readEntry(root, entryId);
        if (!found) return null;
        const cur = found.record.current;
        if (
          cur.generation !== planned.current.generation ||
          cur.operationId !== planned.current.operationId ||
          // The step's claim: an outcome recorded meanwhile (an explicit reconcile) is never overwritten.
          cur.phase !== planned.current.phase ||
          cur.publicationAttempt !== planned.current.publicationAttempt
        ) {
          return null;
        }
        mutate(cur);
        await this.writeRecord(found.dir, found.record);
        return found.record;
      }, { signal, disclose: true });
    } catch (error) {
      const stopped = this.stoppedResult(error);
      if (stopped) return stopped;
      throw error;
    }
    if (!written) return { status: 'superseded' };
    await this.emitFor(written, signal);
    await this.observeFenced(written);
    return stopReason ? { status: 'provisional', entry: snapshot(written), reason: stopReason } : null;
  }

  /**
   * Reports a journaled state to listeners, unless the queue or the pass that
   * wrote it has stopped. The principal is checked before each delivery, so
   * a listener that switches the account (or stops the pass, or disposes the
   * queue) ends the fan-out: no later listener sees the old principal's entry.
   */
  private async emitFor(record: JournalRecord, signal?: AbortSignal): Promise<void> {
    if (this.disposed || signal?.aborted) return;
    const entry = snapshot(record);
    const event: OfflineQueueEvent = entry.state === 'published' ? { type: 'published', entry } : { type: 'provisional', entry };
    if (event.type === 'provisional' && !entry.pending && !isTerminalPhase(entry.phase)) return;
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue;
      if (this.disposed || signal?.aborted || !(await this.principalMatches(signal ?? this.lifetime.signal))) return;
      if (this.disposed || signal?.aborted) return;
      try {
        listener(event);
      } catch {
        // A listener error does not affect the queue.
      }
    }
  }

  /**
   * `observe` after a fresh principal check: a listener (or anything else)
   * that switched the account since the state was read leaves the waiters
   * unsettled, for a read under their own principal, so no waiter receives
   * the old principal's entry under the new one (and the failed check
   * revoked every preview).
   */
  private async observeFenced(record: JournalRecord, tombstones?: Tombstone[]): Promise<void> {
    if (this.disposed) return;
    if (await this.principalMatches(this.lifetime.signal)) this.observe(record, tombstones);
  }

  /**
   * Admits an observation of `entryId` at `position`: false (discard it
   * whole) when an observation of a newer position was applied, else records
   * it as the newest. Its caller delivers in the same synchronous block.
   */
  private admit(entryId: string, position: Position): boolean {
    if (this.disposed || isBefore(position, this.applied.get(entryId))) return false;
    this.applied.set(entryId, position);
    return true;
  }

  /**
   * Records an applied observation of an entry in its file's view (see
   * `fileView`), and moves it out of the view of a file it no longer
   * stages (its absence there is at least as new).
   */
  private viewFile(fileId: string, entryId: string, position: Position): void {
    for (const [other, view] of this.fileView) {
      if (other !== fileId && view.has(entryId)) view.set(entryId, { generation: position.generation, revision: Number.POSITIVE_INFINITY });
    }
    const view = this.fileView.get(fileId) ?? new Map<string, Position>();
    if (!isBefore(position, view.get(entryId))) view.set(entryId, position);
    this.fileView.set(fileId, view);
  }

  /** The waiters armed at or before `position`: only those may be settled from it. */
  private takeWaiters(entryId: string, position: Position, settles: (waiter: Waiter) => boolean): Waiter[] {
    const list = this.waiters.get(entryId);
    if (!list) return [];
    const taken: Waiter[] = [];
    const remaining: Waiter[] = [];
    for (const waiter of list) {
      if (waiter.from && !isBefore(position, waiter.from) && settles(waiter)) taken.push(waiter);
      else remaining.push(waiter);
    }
    if (remaining.length > 0) this.waiters.set(entryId, remaining);
    else this.waiters.delete(entryId);
    return taken;
  }

  /**
   * Applies a journal state (see `admit`): drops a preview the entry no
   * longer needs (published, data removed, or of another generation), and
   * settles waiters armed at or before it. A waiter of a newer generation
   * than the one read stays pending. A waiter of an older generation is
   * settled only with the partition's `tombstones` at hand: it resolves if
   * its generation was published (and since replaced or removed), else it
   * was superseded. Without them it stays for a read that has them.
   */
  private observe(record: JournalRecord, tombstones?: Tombstone[]): void {
    const position = positionOf(record);
    if (!this.admit(record.entryId, position)) return;
    this.viewFile(record.current.fileId, record.entryId, position);
    const cur = record.current;
    const cached = this.objectUrls.get(record.entryId);
    if (cached && (cur.phase === 'published' || cur.dataRemoved || cached.operationId !== cur.operationId)) {
      this.revokeObjectUrl(record.entryId);
    }
    const settles = (waiter: Waiter): boolean =>
      waiter.generation === cur.generation
        ? isTerminalPhase(cur.phase) || cur.pending?.reason === 'retry-limit'
        : waiter.generation < cur.generation && tombstones !== undefined;
    for (const waiter of this.takeWaiters(record.entryId, position, settles)) {
      if (waiter.generation < cur.generation) {
        const tombstone = tombstones!.find((t) => t.entryId === record.entryId && t.generation === waiter.generation);
        if (tombstone) {
          waiter.resolve({ ...tombstone.entry });
          continue;
        }
        waiter.reject(new OfflineQueueError('FILEFN_QUEUE_SUPERSEDED', 'A newer generation replaced this one', {
          entryId: record.entryId,
          generation: waiter.generation,
          currentGeneration: cur.generation,
        }));
      } else if (cur.phase === 'published') {
        waiter.resolve(snapshot(record));
      } else if (cur.phase === 'rejected' || cur.phase === 'failed') {
        const error = new OfflineQueueError(
          cur.phase === 'rejected' ? 'FILEFN_QUEUE_REJECTED' : 'FILEFN_QUEUE_FAILED',
          cur.phase === 'rejected' ? 'Verification rejected the generation' : cur.error?.message ?? 'Upload failed',
          { entryId: record.entryId, generation: cur.generation, ...(cur.error?.code ? { cause: cur.error.code } : {}) },
        );
        waiter.reject(error);
      } else {
        waiter.reject(new OfflineQueueError('FILEFN_QUEUE_RETRY_LIMIT', cur.pending?.message ?? 'Upload attempts reached the limit', {
          entryId: record.entryId,
          generation: cur.generation,
        }));
      }
    }
  }

  /**
   * Applies an entry found absent when the partition's last generation was
   * `lastGeneration` (see `admit`): its preview goes, and each waiter armed
   * at or before then resolves if its generation's tombstone shows it
   * published, else is cancelled.
   */
  private settleAbsent(entryId: string, tombstones: Tombstone[], lastGeneration: number): void {
    const position = absentAt(lastGeneration);
    if (!this.admit(entryId, position)) return;
    for (const view of this.fileView.values()) {
      if (view.has(entryId)) view.set(entryId, position);
    }
    this.revokeObjectUrl(entryId);
    for (const waiter of this.takeWaiters(entryId, position, () => true)) {
      const tombstone = tombstones.find((t) => t.entryId === entryId && t.generation === waiter.generation);
      if (tombstone) waiter.resolve({ ...tombstone.entry });
      else waiter.reject(new OfflineQueueError('FILEFN_QUEUE_CANCELLED', 'Entry was removed', { entryId }));
    }
  }

  /**
   * Applies, through `settleAbsent`, the absence of every entry this instance
   * knows (waiters, previews, an applied observation, any file's view) that a
   * partition-wide read did not find, so a preview read that saw it present
   * earlier is ordered behind that absence.
   */
  private forgetAbsent(present: Set<string>, tombstones: Tombstone[], lastGeneration: number): void {
    const known = new Set([...this.waiters.keys(), ...this.objectUrls.keys(), ...this.applied.keys()]);
    for (const view of this.fileView.values()) for (const entryId of view.keys()) known.add(entryId);
    for (const entryId of known) if (!present.has(entryId)) this.settleAbsent(entryId, tombstones, lastGeneration);
  }

  /**
   * Re-reads entries with waiters on an interval while any exist, so a
   * generation another tab publishes, rejects or removes settles them too.
   */
  private startObserving(): void {
    if (this.observeTimer !== undefined || this.disposed || !(this.observeIntervalMs > 0)) return;
    let running = false;
    this.observeTimer = setInterval(() => {
      if (this.disposed || this.waiters.size === 0) {
        clearInterval(this.observeTimer);
        this.observeTimer = undefined;
        return;
      }
      if (running) return;
      running = true;
      const entryIds = [...this.waiters.keys()];
      void Promise.all(entryIds.map((entryId) => this.lookup(entryId).catch(() => {})))
        .finally(() => {
          running = false;
        });
    }, this.observeIntervalMs);
    (this.observeTimer as { unref?: () => void }).unref?.();
  }

  private revokeAllObjectUrls(): void {
    for (const entryId of [...this.objectUrls.keys()]) this.revokeObjectUrl(entryId);
  }

  private revokeObjectUrl(entryId: string): void {
    const cached = this.objectUrls.get(entryId);
    if (!cached) return;
    this.objectUrls.delete(entryId);
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(cached.url);
  }
}

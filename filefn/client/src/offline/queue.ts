import type { PendingLocalDescriptor, UploadResult } from '../types.js';
import type { PendingLocalSourceMetadata } from '../preprocessing/types.js';
import {
  UPLOAD_SESSION_ENDED_ERROR,
  assertValidExplicitFileId,
  isValidIdempotencyKey,
  derivePendingLocalSource,
  generateFileId,
} from '../upload-manager.js';
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
  createWritable(): Promise<{ write(data: ArrayBuffer | string): Promise<void>; close(): Promise<void> }>;
}

export interface OfflineQueueLimits {
  /** Entries (journals) the partition may hold. */
  maxEntries?: number;
  /** Bytes of staged data the partition may hold. */
  maxBytes?: number;
}

export interface OfflineQueueUploader {
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
  /** Confirms an uploaded generation. A throw leaves it provisional and is retried. */
  verify?(context: OfflineQueueOperationContext): Promise<OfflineQueueVerification>;
  publish?: {
    /** Publishes a verified generation. The returned `result` must be JSON. */
    run(context: OfflineQueueOperationContext): Promise<{ result?: unknown } | void>;
    /**
     * Reports whether an earlier, unconfirmed `run` for this operation took
     * effect. Called before any retry of `run`, never while a `run` this
     * queue started is still running in a live tab. `published: false` must
     * mean the attempt cannot take effect later.
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
  reason: 'ambiguous' | 'needs-reconcile' | 'retry-limit';
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
  /** The current principal is not the partition's: nothing was read or written. */
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
        | 'aborted'
        | 'principal-mismatch'
        | 'hook-unavailable';
    }
  | { status: 'superseded' }
  | { status: 'busy' }
  | { status: 'not-found' };

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
  | 'FILEFN_QUEUE_SUPERSEDED'
  | 'FILEFN_QUEUE_REJECTED'
  | 'FILEFN_QUEUE_FAILED'
  | 'FILEFN_QUEUE_CANCELLED'
  | 'FILEFN_QUEUE_MIGRATION_UNVERIFIED'
  /** Another tab or call is processing the entry; try again once it finishes. */
  | 'FILEFN_QUEUE_BUSY'
  /** Uploads of the generation reached the attempt limit; `reconcile` retries it. */
  | 'FILEFN_QUEUE_RETRY_LIMIT'
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
  replay: { idempotencyKey: string; retiredKeys: string[] };
  /**
   * Hooks this generation needs: recorded when it is staged, and set before a
   * verification or publication starts, so no instance skips a step another
   * one began.
   */
  requires: { verify: boolean; publish: boolean };
  /** Set with each move to `publishing`; manual outcomes must name it. */
  publicationAttempt?: string;
  attempts: number;
  phase: OfflineQueuePhase;
  claim?: { instanceId: string; at: string };
  upload?: UploadResult;
  verification?: { verified: boolean; reason?: string };
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
  holds: Array<{ holdId: string; generation: number; operationId: string }>;
  migratedFrom?: string;
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
  /** A step started: `running` is its upload or hook, invoked right after its claim was journaled. */
  | { kind: StepKind; record: JournalRecord; controller: AbortController; release: () => void; running: Promise<unknown> };

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > ID_MAX_LENGTH) {
    throw new OfflineQueueError('FILEFN_QUEUE_INVALID_INPUT', `${field} must be a non-empty string of at most ${ID_MAX_LENGTH} characters`, { field });
  }
  return value;
}

/** Validates and copies a partition, so later changes to the caller's object have no effect. */
export function normalizeOfflineQueuePartition(partition: OfflineQueuePartition): OfflineQueuePartition {
  if (!partition || typeof partition !== 'object' || !partition.principal || typeof partition.principal !== 'object') {
    throw new OfflineQueueError('FILEFN_QUEUE_INVALID_INPUT', 'partition needs a serviceId and a principal', { field: 'partition' });
  }
  const serviceId = requireId(partition.serviceId, 'serviceId');
  const principal = partition.principal;
  if (principal.kind === 'user') {
    return {
      serviceId,
      principal: {
        kind: 'user',
        principalId: requireId(principal.principalId, 'principal.principalId'),
        ...(principal.tenantId !== undefined ? { tenantId: requireId(principal.tenantId, 'principal.tenantId') } : {}),
      },
    };
  }
  if (principal.kind === 'guest') {
    return { serviceId, principal: { kind: 'guest', namespace: requireId(principal.namespace, 'principal.namespace') } };
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

function isNotFound(error: unknown): boolean {
  return error instanceof Error && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError');
}

function isQuotaError(error: unknown): boolean {
  return error instanceof Error && error.name === 'QuotaExceededError';
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
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

async function writeFile(dir: OfflineQueueDirectoryHandle, name: string, data: ArrayBuffer | string): Promise<void> {
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(data);
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
 * The session of the recorded key ended for good (expired or aborted), at any
 * phase: init replay, sign, part, part completion or completion. Nothing more
 * can be sent under that key; the generation starts again under a fresh one.
 */
const SESSION_ENDED_CODES = new Set([UPLOAD_SESSION_ENDED_ERROR, 'FILEFN_UPLOAD_EXPIRED', 'FILEFN_UPLOAD_ABORTED']);

function isSessionEnded(error: unknown): boolean {
  const code = (error as UploadFailure)?.code;
  return typeof code === 'string' && SESSION_ENDED_CODES.has(code);
}

/** Another tab completed, or is completing, the same session, or the server lost track of it: a replay under the same key settles it. */
const REPLAYABLE_CODES = new Set([
  'FILEFN_UPLOAD_COMPLETION_IN_PROGRESS',
  'FILEFN_UPLOAD_ALREADY_COMPLETED',
  'FILEFN_UPLOAD_INCOMPLETE',
  'FILEFN_SESSION_NOT_FOUND',
]);

/**
 * Statuses that say nothing final about the upload: authentication and
 * authorization (the credentials may belong to another account for a moment),
 * timeouts, locks, early data and rate limits.
 */
const TRANSIENT_STATUSES = new Set([401, 403, 408, 423, 425, 429]);

/**
 * A failure that no replay with the same input can fix: a client-side input
 * error or a 4xx refusal of the request itself. Anything the server marks
 * retryable, a replayable conflict, a transient status, a 5xx or a network
 * error is not: the outcome stays unknown until replayed under the same key.
 */
function isPermanentUploadError(error: unknown): boolean {
  const failure = error as UploadFailure;
  if (failure?.code === 'FILEFN_CLIENT_FILE_ID_MISMATCH' || failure?.code === 'FILEFN_INVALID_FILE_ID') return true;
  if (failure?.retryable === true || failure?.details?.retryable === true) return false;
  if (typeof failure?.code === 'string' && REPLAYABLE_CODES.has(failure.code)) return false;
  const status = failure?.status;
  if (typeof status === 'number') {
    return status >= 400 && status < 500 && !TRANSIENT_STATUSES.has(status);
  }
  return false;
}

function isPrincipalMismatch(error: unknown): boolean {
  return error instanceof OfflineQueueError && error.code === 'FILEFN_QUEUE_PRINCIPAL_MISMATCH';
}

function hasVersion(result: unknown): result is UploadResult {
  const value = result as { fileId?: unknown; versionId?: unknown } | null | undefined;
  return typeof value?.fileId === 'string' && typeof value.versionId === 'string' && value.versionId.length > 0;
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
 * session. A migrated legacy upload keeps its own key, so a session it already
 * completed is reconciled; it is admitted once per partition.
 */
function replayKey(prefix: string | undefined, operationId: string, legacyKey?: string): string {
  if (legacyKey !== undefined && isValidIdempotencyKey(legacyKey)) return legacyKey;
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
    holds: record.holds
      .filter((hold) => hold.operationId === cur.operationId)
      .map(({ holdId, generation }) => ({ holdId, generation })),
    attempts: cur.attempts,
    ...(cur.upload ? { upload: { ...cur.upload } } : {}),
    ...(cur.verification ? { verification: { ...cur.verification } } : {}),
    ...(cur.publication ? { publication: { ...cur.publication } } : {}),
    ...(cur.pending ? { pending: { ...cur.pending } } : {}),
    ...(cur.error ? { error: { ...cur.error } } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Returned by `withEntryLock` when another tab or call holds the entry. */
const BUSY: unique symbol = Symbol('busy');

interface Waiter {
  generation: number;
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
  private readonly entryControllers = new Map<string, AbortController>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly listeners = new Set<(event: OfflineQueueEvent) => void>();
  private readonly objectUrls = new Map<string, { operationId: string; url: string }>();
  private partitionIdPromise: Promise<string> | undefined;
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
    for (const controller of this.entryControllers.values()) controller.abort();
    this.entryControllers.clear();
    const error = new OfflineQueueError('FILEFN_QUEUE_DISPOSED', 'Offline queue was disposed');
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    this.waiters.clear();
    this.listeners.clear();
    for (const { url } of this.objectUrls.values()) {
      if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
    }
    this.objectUrls.clear();
  }

  subscribe(listener: (event: OfflineQueueEvent) => void): () => void {
    this.assertUsable();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Stages a new generation of an entry. Returns a refusal, never throws, for
   * missing locks or storage, a full partition, a generation conflict or a
   * current principal that is not the partition's.
   */
  async stage(input: OfflineQueueStageInput): Promise<OfflineQueueStageResult> {
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
    const bytes = await input.file.arrayBuffer();
    const fileName = input.fileName ?? (typeof File !== 'undefined' && input.file instanceof File ? input.file.name : 'blob');
    const mimeType = input.mimeType || input.file.type || 'application/octet-stream';
    return this.stageBytes({ ...input, entryId, fileId, fileName, mimeType }, bytes);
  }

  /**
   * Holds the given generation: it is not uploaded further, verified or
   * published until released. Refused once its publication has started or it
   * is final: a hold can no longer stop it then.
   */
  async hold(entryId: string, generation: number): Promise<OfflineQueueHoldResult> {
    return this.transact(async (root) => {
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
    });
  }

  /** Releases one hold. A hold of another generation, or an unknown hold, is left as it is. */
  async release(entryId: string, generation: number, holdId: string): Promise<boolean> {
    return this.transact(async (root) => {
      const found = await this.readEntry(root, entryId);
      if (!found) return false;
      const { dir, record } = found;
      const index = record.holds.findIndex((hold) => hold.holdId === holdId && hold.generation === generation);
      if (index < 0) return false;
      record.holds.splice(index, 1);
      await this.writeRecord(dir, record);
      return true;
    });
  }

  /**
   * The partition's entries. Entries of other partitions and unscoped legacy
   * uploads are never listed. Throws FILEFN_QUEUE_PRINCIPAL_MISMATCH while the
   * current principal is not the partition's.
   */
  async list(): Promise<OfflineQueueEntry[]> {
    const { records, tombstones } = await this.transact(async (root) => {
      const partitionDir = await this.partitionDir(root);
      return { records: await this.readAllIn(partitionDir), tombstones: (await this.loadMeta(partitionDir)).tombstones };
    });
    for (const record of records) this.observe(record);
    this.forgetAbsent(new Set(records.map((record) => record.entryId)), tombstones);
    return records
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.entryId.localeCompare(b.entryId))
      .map(snapshot);
  }

  async get(entryId: string): Promise<OfflineQueueEntry | null> {
    const { record } = await this.lookup(entryId);
    return record ? snapshot(record) : null;
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
    const removed = await this.transact(async (root) => {
      const found = await this.readEntry(root, entryId);
      if (!found) return false;
      const { record } = found;
      if (generation !== undefined && record.current.generation !== generation) return false;
      if (record.current.phase === 'publishing') {
        throw new OfflineQueueError('FILEFN_QUEUE_PUBLICATION_PENDING', 'Reconcile the publication before cancelling', {
          entryId,
          generation: record.current.generation,
        });
      }
      const partitionDir = await this.partitionDir(root);
      await this.noteRemoval(partitionDir, [record]);
      await removeEntry(partitionDir, await this.entryKey(entryId), true);
      return true;
    });
    if (removed) {
      this.entryControllers.get(entryId)?.abort();
      this.revokeObjectUrl(entryId);
      this.rejectWaiters(entryId, 'FILEFN_QUEUE_CANCELLED', 'Entry was cancelled');
    }
    return removed;
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
    if (
      publication !== undefined &&
      (publication === null ||
        typeof publication !== 'object' ||
        typeof publication.published !== 'boolean' ||
        typeof publication.attemptId !== 'string')
    ) {
      throw new OfflineQueueError('FILEFN_QUEUE_INVALID_INPUT', 'publication needs published (true or false) and attemptId', {
        field: 'publication',
      });
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
          cur.publication = { result: toJson(publication.result) };
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
    }));
    if (outcome === BUSY) {
      throw new OfflineQueueError('FILEFN_QUEUE_BUSY', 'The entry is being processed; reconcile it once that finishes', { entryId, generation });
    }
    if (outcome.changed && outcome.record.current.phase === 'published') this.emitFor(outcome.record);
    this.observe(outcome.record);
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

  /** Processes every entry of the partition that is not held or final. */
  async processAll(options: { signal?: AbortSignal } = {}): Promise<Array<{ entryId: string; result: OfflineQueueProcessResult }>> {
    const entries = await this.list();
    const results: Array<{ entryId: string; result: OfflineQueueProcessResult }> = [];
    for (const entry of entries) {
      if (this.disposed || options.signal?.aborted) break;
      if (entry.phase === 'published') {
        // Finishes an interrupted cleanup of its data; already reported when it was published.
        await this.process(entry.entryId, options);
        continue;
      }
      if (isTerminalPhase(entry.phase) || entry.holds.length > 0) continue;
      // An entry at its retry limit is reported (`retry-limit`) without another upload.
      results.push({ entryId: entry.entryId, result: await this.process(entry.entryId, options) });
    }
    return results;
  }

  /** Removes orphaned data and final entries past their retention. */
  async reclaim(): Promise<OfflineQueueReclaimResult> {
    const { result, present, tombstones } = await this.transact(async (root) => {
      const partitionDir = await this.partitionDir(root);
      const reclaimed = await this.reclaimIn(partitionDir, false);
      return {
        result: reclaimed,
        present: new Set((await this.readAllIn(partitionDir)).map((record) => record.entryId)),
        tombstones: (await this.loadMeta(partitionDir)).tombstones,
      };
    });
    this.forgetAbsent(present, tombstones);
    return result;
  }

  async usage(): Promise<OfflineQueueUsage> {
    return this.transact(async (root) => this.measure(await this.partitionDir(root)));
  }

  /** A local preview of the newest provisional generation staged for `fileId` in this partition. */
  async getPendingLocalDescriptor(fileId: string): Promise<PendingLocalDescriptor | null> {
    const found = await this.transact(async (root) => {
      const records = (await this.readAll(root)).filter(
        (record) => record.current.fileId === fileId && record.current.phase !== 'published' && !record.current.dataRemoved,
      );
      records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const record = records[0];
      if (!record) return null;
      const dir = await getDir(await this.partitionDir(root), await this.entryKey(record.entryId));
      const blob = dir ? await getFile(dir, record.current.dataFile) : null;
      return blob ? { record, data: await blob.arrayBuffer() } : null;
    });
    if (!found) return null;
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      const error = new Error('Local preview unavailable') as Error & { code?: string };
      error.code = 'FILEFN_OFFLINE_PREVIEW_UNSUPPORTED';
      throw error;
    }
    this.assertUsable();
    const cur = found.record.current;
    let cached = this.objectUrls.get(found.record.entryId);
    if (!cached || cached.operationId !== cur.operationId) {
      this.revokeObjectUrl(found.record.entryId);
      cached = { operationId: cur.operationId, url: URL.createObjectURL(new Blob([found.data], { type: cur.mimeType })) };
      this.objectUrls.set(found.record.entryId, cached);
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
    this.assertUsable();
    await this.assertPrincipal(this.lifetime.signal);
    const store = this.legacyStore();
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
  }

  /**
   * Moves one legacy upload into this partition. The caller must have its own
   * evidence that the upload belongs to this partition's principal, and says
   * so with `ownershipVerified: true`. It becomes a new entry (`entryId`
   * defaults to its file ID; an existing entry is a `generation-conflict`).
   * A legacy upload is admitted once per partition, whatever the entry ID and
   * however many tabs migrate it: a repeat returns the entry it became, or
   * `already-migrated` once that entry is gone. The legacy record is removed
   * only after the new entry is written.
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
    const legacy = await store.getPendingUpload(uploadSessionId);
    if (!legacy) {
      throw new OfflineQueueError('FILEFN_QUEUE_NOT_FOUND', 'Legacy upload not found', { uploadSessionId });
    }
    assertValidExplicitFileId(legacy.fileId);
    const fileId = legacy.fileId ?? generateFileId();
    const result = await this.stageBytes(
      {
        entryId: requireId(options.entryId ?? fileId, 'entryId'),
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
      // Its own key, so a session it completed before is reconciled, not uploaded again.
      { source: uploadSessionId, key: legacy.idempotencyKey },
    );
    if (result.status === 'staged' || (result.status === 'refused' && result.reason === 'already-migrated')) {
      await store.deletePendingUpload(uploadSessionId);
    }
    return result;
  }

  // ---- internals ----

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

  /** Whether the credentials in use act for this partition's principal right now. */
  private async principalMatches(signal: AbortSignal): Promise<boolean> {
    try {
      const principal = await this.options.currentPrincipal(signal);
      if (!principal) return false;
      return partitionIdentity(normalizeOfflineQueuePartition({ serviceId: this.partition.serviceId, principal })) === this.identity;
    } catch {
      return false;
    }
  }

  private async assertPrincipal(signal: AbortSignal): Promise<void> {
    if (!(await this.principalMatches(signal))) {
      throw new OfflineQueueError('FILEFN_QUEUE_PRINCIPAL_MISMATCH', "The current principal is not this queue's");
    }
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
   * Runs `fn` under the partition lock. Throws FILEFN_QUEUE_DISPOSED once
   * disposed, before or after waiting, and (unless `checkPrincipal` is false)
   * FILEFN_QUEUE_PRINCIPAL_MISMATCH when the current principal, checked once
   * the lock is held, is not the partition's.
   */
  private async transact<T>(
    fn: (root: OfflineQueueDirectoryHandle) => Promise<T>,
    options: { checkPrincipal?: boolean } = {},
  ): Promise<T> {
    this.assertUsable();
    const name = await this.partitionLockName();
    const root = await this.getRoot!();
    try {
      return await this.coordinator!.request(name, { signal: this.lifetime.signal }, async () => {
        this.assertUsable();
        if (options.checkPrincipal !== false) {
          await this.assertPrincipal(this.lifetime.signal);
          this.assertUsable();
        }
        return fn(root);
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
   * touched.
   */
  private async inspectJournal(dir: OfflineQueueDirectoryHandle): Promise<JournalRead> {
    const blob = await getFile(dir, JOURNAL_FILE);
    if (!blob) return { state: 'missing' };
    let parsed: JournalRecord;
    try {
      parsed = JSON.parse(await blob.text()) as JournalRecord;
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
   * The partition's meta file. A missing or unreadable one (never committed)
   * is rebuilt: its generation counter from the journals, with no tombstones
   * or migration marks.
   */
  private async loadMeta(partitionDir: OfflineQueueDirectoryHandle): Promise<PartitionMeta> {
    const partitionId = await this.partitionId();
    const blob = await getFile(partitionDir, PARTITION_META_FILE);
    if (blob) {
      try {
        const meta = JSON.parse(await blob.text()) as Partial<PartitionMeta>;
        if (meta.partitionId === partitionId && Number.isSafeInteger(meta.lastGeneration)) {
          return {
            journalVersion: JOURNAL_VERSION,
            partitionId,
            lastGeneration: meta.lastGeneration!,
            migrated: Array.isArray(meta.migrated) ? meta.migrated.filter((id) => typeof id === 'string') : [],
            tombstones: Array.isArray(meta.tombstones) ? meta.tombstones : [],
          };
        }
      } catch {
        // Cut short by a crash: rebuilt below.
      }
    }
    let lastGeneration = 0;
    for (const record of await this.readAllIn(partitionDir)) lastGeneration = Math.max(lastGeneration, record.current.generation);
    return { journalVersion: JOURNAL_VERSION, partitionId, lastGeneration, migrated: [], tombstones: [] };
  }

  private async writeMeta(partitionDir: OfflineQueueDirectoryHandle, meta: PartitionMeta): Promise<void> {
    await writeFile(partitionDir, PARTITION_META_FILE, JSON.stringify(meta));
  }

  /**
   * Written before journals are removed: a tombstone for each published
   * generation (so waiters in other tabs still see it published) and the
   * legacy source of each migrated entry (so it is never admitted again).
   */
  private async noteRemoval(partitionDir: OfflineQueueDirectoryHandle, records: JournalRecord[]): Promise<void> {
    const published = records.filter((record) => record.current.phase === 'published');
    const migrated = records.flatMap((record) => (record.migratedFrom ? [record.migratedFrom] : []));
    if (published.length === 0 && migrated.length === 0) return;
    const meta = await this.loadMeta(partitionDir);
    const now = Date.now();
    const removedAt = new Date(now).toISOString();
    meta.migrated = [...new Set([...meta.migrated, ...migrated])];
    const kept = meta.tombstones.filter(
      (tombstone) =>
        now - Date.parse(tombstone.removedAt) < this.terminalRetentionMs &&
        !published.some((record) => record.entryId === tombstone.entryId),
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
    record.revision += 1;
    record.updatedAt = new Date().toISOString();
    await writeFile(dir, JOURNAL_FILE, JSON.stringify(record));
  }

  /** Reads one entry (or its tombstone) and settles its waiters from what it finds. */
  private async lookup(entryId: string): Promise<{ record: JournalRecord | null }> {
    const { record, tombstones } = await this.transact(async (root) => {
      const found = await this.readEntry(root, entryId);
      return { record: found?.record ?? null, tombstones: found ? [] : (await this.loadMeta(await this.partitionDir(root))).tombstones };
    });
    if (record) this.observe(record);
    else this.settleAbsent(entryId, tombstones);
    return { record };
  }

  private async stageBytes(
    input: OfflineQueueStageInput & { entryId: string; fileId: string; fileName: string; mimeType: string },
    bytes: ArrayBuffer,
    migration?: { source: string; key?: string },
  ): Promise<OfflineQueueStageResult> {
    const localSource = input.localSource ?? derivePendingLocalSource(input.fileName, input.mimeType, bytes.byteLength);
    let outcome;
    try {
      outcome = await this.transact(async (root) => {
        const partitionDir = await this.partitionDir(root);
        const key = await this.entryKey(input.entryId);
        if (migration) {
          // Checked in the same transaction as the staging: one admission per legacy upload.
          const migrated = (await this.readAllIn(partitionDir)).find((record) => record.migratedFrom === migration.source);
          if (migrated) return { status: 'staged', record: migrated, holdId: undefined } as const;
          if ((await this.loadMeta(partitionDir)).migrated.includes(migration.source)) {
            return { status: 'refused', reason: 'already-migrated' } as const;
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
          await removeEntry(partitionDir, key, true);
          existingDir = null;
        }
        const previous = read.state === 'ok' ? read.record : null;
        const currentGeneration = previous?.current.generation ?? 0;
        if (input.expectedGeneration !== undefined && input.expectedGeneration !== currentGeneration) {
          return { status: 'refused', reason: 'generation-conflict', currentGeneration } as const;
        }
        if (previous?.current.phase === 'publishing') {
          return { status: 'refused', reason: 'publication-pending', currentGeneration } as const;
        }
        // A new generation replaces the previous one's data: only bytes actually present are credited.
        const replacedBytes = previous && existingDir ? ((await getFile(existingDir, previous.current.dataFile))?.size ?? 0) : 0;
        const refusal = await this.ensureCapacity(partitionDir, existingDir ? 0 : 1, bytes.byteLength - replacedBytes, key);
        if (refusal) return refusal;

        const quotaRefusal = async () =>
          ({ status: 'refused', reason: 'capacity', limit: 'quota', usage: await this.measure(partitionDir), limits: this.limits }) as const;
        const meta = await this.loadMeta(partitionDir);
        const generation = Math.max(meta.lastGeneration, currentGeneration) + 1;
        meta.lastGeneration = generation;
        try {
          // Written before the journal that uses it, so a number is never handed out twice.
          await this.writeMeta(partitionDir, meta);
        } catch (error) {
          if (!isQuotaError(error)) throw error;
          return quotaRefusal();
        }
        const dataFile = `g${generation}.bin`;
        const dir = existingDir ?? (await partitionDir.getDirectoryHandle(key, { create: true }));
        const hooks = this.options.hooks;
        const now = new Date().toISOString();
        const operationId = randomId('op');
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
          replay: { idempotencyKey: replayKey(input.idempotencyKey, operationId, migration?.key), retiredKeys: [] },
          requires: { verify: Boolean(hooks?.verify), publish: Boolean(hooks?.publish) },
          attempts: 0,
          phase: 'staged',
        };
        const holdId = input.hold ? randomId('hold') : undefined;
        const record: JournalRecord = {
          journalVersion: JOURNAL_VERSION,
          binding: { ...this.partition, partitionId: await this.partitionId() },
          entryId: input.entryId,
          revision: previous?.revision ?? 0,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          current,
          // Holds of earlier generations no longer apply.
          holds: holdId ? [{ holdId, generation, operationId }] : [],
          ...(migration?.source ?? previous?.migratedFrom ? { migratedFrom: migration?.source ?? previous?.migratedFrom } : {}),
        };
        try {
          // Data first: a crash before the journal write leaves an orphan file, never a journal without data.
          await writeFile(dir, dataFile, bytes);
          await this.writeRecord(dir, record);
        } catch (error) {
          await removeEntry(dir, dataFile).catch(() => {});
          if (!existingDir) await removeEntry(partitionDir, key, true).catch(() => {});
          if (isQuotaError(error)) return quotaRefusal();
          throw error;
        }
        if (previous && previous.current.dataFile !== dataFile) {
          // Best effort: a leftover file is an orphan the next reclaim removes.
          await removeEntry(dir, previous.current.dataFile).catch(() => {});
        }
        return { status: 'staged', record, holdId } as const;
      });
    } catch (error) {
      if (isPrincipalMismatch(error)) return { status: 'refused', reason: 'principal-mismatch' };
      throw error;
    }
    if (outcome.status !== 'staged') return outcome;
    this.revokeObjectUrl(input.entryId);
    this.observe(outcome.record);
    return { status: 'staged', entry: snapshot(outcome.record), ...(outcome.holdId ? { holdId: outcome.holdId } : {}) };
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
   * journal. Provisional entries, journals of another binding or layout, and
   * `protect` are never removed.
   */
  private async reclaimIn(
    partitionDir: OfflineQueueDirectoryHandle,
    pressure: boolean,
    protect?: string,
  ): Promise<OfflineQueueReclaimResult> {
    const result: OfflineQueueReclaimResult = { removedEntries: 0, removedFiles: 0, freedBytes: 0 };
    const now = Date.now();
    for (const name of await listNames(partitionDir, 'directory')) {
      if (name === protect) continue;
      const dir = await getDir(partitionDir, name);
      if (!dir) continue;
      const files = await listNames(dir, 'file');
      const dataBytes = async (file: string) => (await getFile(dir, file))?.size ?? 0;
      const read = await this.inspectJournal(dir);
      if (read.state === 'missing' || read.state === 'corrupt') {
        for (const file of files) if (file !== JOURNAL_FILE) result.freedBytes += await dataBytes(file);
        await removeEntry(partitionDir, name, true);
        result.removedEntries += 1;
        continue;
      }
      if (read.state !== 'ok') continue;
      const record = read.record;
      const cur = record.current;
      if (cur.phase === 'published' && (pressure || now - Date.parse(record.updatedAt) >= this.terminalRetentionMs)) {
        for (const file of files) if (file !== JOURNAL_FILE) result.freedBytes += await dataBytes(file);
        await this.noteRemoval(partitionDir, [record]);
        await removeEntry(partitionDir, name, true);
        result.removedEntries += 1;
        continue;
      }
      let changed = false;
      for (const file of files) {
        if (file === JOURNAL_FILE) continue;
        const keep = file === cur.dataFile && cur.phase !== 'published';
        if (keep) continue;
        result.freedBytes += await dataBytes(file);
        await removeEntry(dir, file);
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
    for (;;) {
      const plan = await this.transact((root) => this.planStep(root, entryId, signal, started), { checkPrincipal: false });
      if (plan.kind === 'done') return plan.result;
      if (plan.kind === 'continue') continue;
      const outcome = await this.finishStep(entryId, plan, signal);
      if (outcome) return outcome;
    }
  }

  /** Aborts when the queue is disposed, the caller's signal aborts or the entry is cancelled; `release` detaches it. */
  private stepController(entryId: string, signal: AbortSignal | undefined): { controller: AbortController; release: () => void } {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (this.lifetime.signal.aborted || signal?.aborted) controller.abort();
    this.lifetime.signal.addEventListener('abort', onAbort, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    this.entryControllers.set(entryId, controller);
    return {
      controller,
      release: () => {
        this.lifetime.signal.removeEventListener('abort', onAbort);
        signal?.removeEventListener('abort', onAbort);
        if (this.entryControllers.get(entryId) === controller) this.entryControllers.delete(entryId);
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
      assertPrincipal: () => this.assertPrincipal(signal),
    };
  }

  /**
   * Decides the next step under the partition lock and, for an upload or
   * hook, journals its claim and starts it in the same turn: nothing is
   * written once the caller's signal aborts or the queue is disposed, and no
   * step starts after either. Every claim is written before its request.
   */
  private async planStep(
    root: OfflineQueueDirectoryHandle,
    entryId: string,
    signal: AbortSignal | undefined,
    started: Promise<unknown>[],
  ): Promise<Plan> {
    const found = await this.readEntry(root, entryId);
    if (!found) return { kind: 'done', result: { status: 'not-found' } };
    const { dir, record } = found;
    const cur = record.current;
    const provisional = (reason: Extract<OfflineQueueProcessResult, { status: 'provisional' }>['reason']): Plan => ({
      kind: 'done',
      result: { status: 'provisional', entry: snapshot(record), reason },
    });
    this.observe(record);
    if (signal?.aborted) return provisional('aborted');
    if (record.holds.some((hold) => hold.operationId === cur.operationId) && cur.phase !== 'published') {
      return provisional('held');
    }
    const principalOk = await this.principalMatches(signal ?? this.lifetime.signal);
    if (!principalOk) {
      // Nothing is written, sent or cleaned up for another principal.
      return cur.phase === 'published' ? { kind: 'done', result: { status: 'published', entry: snapshot(record) } } : provisional('principal-mismatch');
    }
    // Checked synchronously right before each write, and again before a step starts.
    const fenced = (): boolean => {
      this.assertUsable();
      return Boolean(signal?.aborted);
    };
    const write = async (): Promise<boolean> => {
      if (fenced()) return false;
      await this.writeRecord(dir, record);
      return true;
    };
    const start = (kind: StepKind, run: (controller: AbortController) => Promise<unknown>): Plan => {
      const { controller, release } = this.stepController(entryId, signal);
      const running = invoke(() => run(controller));
      started.push(running.catch(() => {}));
      return { kind, record: structuredClone(record), controller, release, running };
    };
    const hooks = this.options.hooks;
    switch (cur.phase) {
      case 'staged':
      case 'uploading': {
        if (cur.attempts >= this.maxUploadAttempts) {
          if (cur.pending?.reason !== 'retry-limit') {
            // Durable and reported once, so listeners, waiters and other tabs see it.
            cur.pending = { stage: 'upload', reason: 'retry-limit', ...(cur.error ? { message: cur.error.message } : {}) };
            if (!(await write())) return provisional('aborted');
            this.emitFor(record);
            this.observe(record);
          }
          return provisional('retry-limit');
        }
        const blob = await getFile(dir, cur.dataFile);
        if (!blob) {
          cur.phase = 'failed';
          cur.error = { code: 'FILEFN_QUEUE_DATA_MISSING', message: 'Staged data is missing' };
          if (!(await write())) return provisional('aborted');
          this.emitFor(record);
          return provisional('failed');
        }
        const file = new File([await blob.arrayBuffer()], cur.fileName, { type: cur.mimeType });
        cur.phase = 'uploading';
        cur.claim = { instanceId: this.instanceId, at: new Date().toISOString() };
        if (!(await write()) || fenced()) return provisional('aborted');
        return start('upload', (controller) =>
          this.options.uploader.upload({
            policy: cur.policy,
            file,
            fileName: cur.fileName,
            metadata: cur.metadata,
            fileId: cur.fileId,
            idempotencyKey: cur.replay.idempotencyKey,
            signal: controller.signal,
            assertPrincipal: async () => {
              await this.assertPrincipal(controller.signal);
              if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
            },
          }),
        );
      }
      case 'uploaded':
      case 'verifying': {
        // A verification that started (here or in another instance) is always required.
        const needsVerify = cur.requires.verify || Boolean(hooks?.verify) || cur.phase === 'verifying';
        if (needsVerify && !hooks?.verify) return provisional('hook-unavailable');
        if (!needsVerify) {
          cur.phase = 'verified';
          cur.verification = { verified: true };
          if (!(await write())) return provisional('aborted');
          return { kind: 'continue' };
        }
        cur.phase = 'verifying';
        cur.requires.verify = true;
        if (!(await write()) || fenced()) return provisional('aborted');
        const verify = hooks!.verify!;
        return start('verify', (controller) => verify(this.operationContext(entryId, cur, controller.signal)));
      }
      case 'verified': {
        const needsPublish = cur.requires.publish || Boolean(hooks?.publish);
        if (needsPublish && !hooks?.publish) return provisional('hook-unavailable');
        if (!needsPublish) {
          cur.phase = 'published';
          cur.publication = {};
          if (!(await write())) return provisional('aborted');
          this.emitFor(record);
          return { kind: 'continue' };
        }
        // Recorded before the hook runs, so a crash leaves it unconfirmed rather than unpublished.
        cur.phase = 'publishing';
        cur.requires.publish = true;
        cur.publicationAttempt = randomId('pub');
        cur.pending = undefined;
        if (!(await write())) return provisional('aborted');
        if (this.disposed || signal?.aborted) {
          // Stopped during the write: the hook never ran, so the claim is withdrawn.
          cur.phase = 'verified';
          cur.publicationAttempt = undefined;
          await this.writeRecord(dir, record);
          this.assertUsable();
          return provisional('aborted');
        }
        const publish = hooks!.publish!;
        return start('publish', (controller) => publish.run(this.operationContext(entryId, cur, controller.signal)));
      }
      case 'publishing': {
        const publish = hooks?.publish;
        if (publish?.reconcile || publish?.idempotent) {
          if (fenced()) return provisional('aborted');
          return publish.reconcile
            ? start('reconcile-publication', (controller) => publish.reconcile!(this.operationContext(entryId, cur, controller.signal)))
            : start('publish', (controller) => publish.run(this.operationContext(entryId, cur, controller.signal)));
        }
        if (cur.pending?.reason !== 'needs-reconcile') {
          cur.pending = { stage: 'publication', reason: 'needs-reconcile' };
          if (!(await write())) return provisional('aborted');
        }
        return provisional('needs-reconcile');
      }
      case 'published':
        if (!cur.dataRemoved && !fenced()) {
          await removeEntry(dir, cur.dataFile);
          cur.dataRemoved = true;
          await write();
        }
        return { kind: 'done', result: { status: 'published', entry: snapshot(record) } };
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
  ): Promise<OfflineQueueProcessResult | null> {
    const { record, controller } = plan;
    const stoppedEarly = (error: unknown): OfflineQueueProcessResult | null => {
      this.assertUsable();
      if (isPrincipalMismatch(error)) return { status: 'provisional', entry: snapshot(record), reason: 'principal-mismatch' };
      if (controller.signal.aborted || isAbort(error)) return { status: 'provisional', entry: snapshot(record), reason: 'aborted' };
      return null;
    };
    let value: unknown;
    try {
      value = await raceAbort(plan.running, controller.signal);
    } catch (error) {
      const stopped = stoppedEarly(error);
      if (stopped) return stopped;
      return this.recordFailure(entryId, plan, error, signal);
    } finally {
      plan.release();
    }
    switch (plan.kind) {
      case 'upload': {
        const result = value as UploadResult;
        if (result?.fileId !== undefined && result.fileId !== record.current.fileId) {
          return this.commit(entryId, record, signal, (state) => {
            state.phase = 'failed';
            state.error = { code: 'FILEFN_CLIENT_FILE_ID_MISMATCH', message: 'Server stored a different fileId' };
            state.claim = undefined;
          }, 'failed');
        }
        if (!hasVersion(result)) {
          // A success that does not name its stored version confirms nothing.
          return this.recordFailure(entryId, plan, new Error('Upload result has no versionId'), signal);
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
        const outcome = value as OfflineQueueVerification;
        if (outcome?.verified === true) {
          return this.commit(entryId, record, signal, (state) => {
            state.phase = 'verified';
            state.verification = { verified: true };
            state.pending = undefined;
          });
        }
        if (outcome?.verified === false) {
          return this.commit(entryId, record, signal, (state) => {
            state.phase = 'rejected';
            state.verification = { verified: false, reason: String(outcome.reason ?? '') };
            state.pending = undefined;
          }, 'rejected');
        }
        return this.recordFailure(entryId, plan, new Error('verify returned no outcome'), signal);
      }
      case 'publish': {
        const published = value as { result?: unknown } | void;
        return this.commit(entryId, record, signal, (state) => {
          state.phase = 'published';
          state.publication = { result: toJson(published ? published.result : undefined) };
          state.pending = undefined;
        });
      }
      case 'reconcile-publication': {
        const check = value as OfflineQueuePublicationCheck;
        if (check?.published === true) {
          return this.commit(entryId, record, signal, (state) => {
            state.phase = 'published';
            state.publication = { result: toJson(check.result) };
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
   * operation, phase and publication attempt, the current principal is the
   * partition's, and neither the queue nor the caller's pass has stopped. A
   * newer generation is never touched by an older one's result; a stopped or
   * switched pass leaves the outcome unrecorded for the next live one to
   * replay or reconcile. Returns null to continue the pipeline, or the result.
   */
  private async commit(
    entryId: string,
    planned: JournalRecord,
    signal: AbortSignal | undefined,
    mutate: (state: GenerationState) => void,
    stopReason?: 'rejected' | 'failed' | 'ambiguous',
  ): Promise<OfflineQueueProcessResult | null> {
    const outcome = await this.transact(async (root) => {
      const found = await this.readEntry(root, entryId);
      if (!found) return { kind: 'superseded' } as const;
      const cur = found.record.current;
      if (
        cur.generation !== planned.current.generation ||
        cur.operationId !== planned.current.operationId ||
        // The step's claim: an outcome recorded meanwhile (an explicit reconcile) is never overwritten.
        cur.phase !== planned.current.phase ||
        cur.publicationAttempt !== planned.current.publicationAttempt
      ) {
        return { kind: 'superseded' } as const;
      }
      if (!(await this.principalMatches(signal ?? this.lifetime.signal))) {
        return { kind: 'stopped', reason: 'principal-mismatch', record: found.record } as const;
      }
      // Checked after every await, right before the write.
      this.assertUsable();
      if (signal?.aborted) return { kind: 'stopped', reason: 'aborted', record: found.record } as const;
      mutate(cur);
      await this.writeRecord(found.dir, found.record);
      return { kind: 'written', record: found.record } as const;
    }, { checkPrincipal: false });
    if (outcome.kind === 'superseded') return { status: 'superseded' };
    if (outcome.kind === 'stopped') return { status: 'provisional', entry: snapshot(outcome.record), reason: outcome.reason };
    this.emitFor(outcome.record);
    this.observe(outcome.record);
    return stopReason ? { status: 'provisional', entry: snapshot(outcome.record), reason: stopReason } : null;
  }

  private emitFor(record: JournalRecord): void {
    if (this.disposed) return;
    const entry = snapshot(record);
    const event: OfflineQueueEvent = entry.state === 'published' ? { type: 'published', entry } : { type: 'provisional', entry };
    if (event.type === 'provisional' && !entry.pending && !isTerminalPhase(entry.phase)) return;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener error does not affect the queue.
      }
    }
  }

  /** Settles waiters from an observed journal state, and drops a preview the entry no longer needs. */
  private observe(record: JournalRecord): void {
    const cur = record.current;
    if (cur.phase === 'published' || cur.dataRemoved) this.revokeObjectUrl(record.entryId);
    const list = this.waiters.get(record.entryId);
    if (!list || this.disposed) return;
    const remaining: Waiter[] = [];
    for (const waiter of list) {
      if (waiter.generation !== cur.generation) {
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
      } else if (cur.pending?.reason === 'retry-limit') {
        waiter.reject(new OfflineQueueError('FILEFN_QUEUE_RETRY_LIMIT', cur.pending.message ?? 'Upload attempts reached the limit', {
          entryId: record.entryId,
          generation: cur.generation,
        }));
      } else {
        remaining.push(waiter);
      }
    }
    if (remaining.length > 0) this.waiters.set(record.entryId, remaining);
    else this.waiters.delete(record.entryId);
  }

  /**
   * Settles the waiters of an entry that is gone: a waiter of a generation
   * whose tombstone shows it published resolves; any other is cancelled.
   */
  private settleAbsent(entryId: string, tombstones: Tombstone[]): void {
    this.revokeObjectUrl(entryId);
    const list = this.waiters.get(entryId);
    if (!list) return;
    this.waiters.delete(entryId);
    for (const waiter of list) {
      const tombstone = tombstones.find((t) => t.entryId === entryId && t.generation === waiter.generation);
      if (tombstone) waiter.resolve({ ...tombstone.entry });
      else waiter.reject(new OfflineQueueError('FILEFN_QUEUE_CANCELLED', 'Entry was removed', { entryId }));
    }
  }

  /** Settles waiters and drops previews of entries that are gone (cancelled or reclaimed, here or in another tab). */
  private forgetAbsent(present: Set<string>, tombstones: Tombstone[]): void {
    for (const entryId of [...this.waiters.keys()]) {
      if (!present.has(entryId)) this.settleAbsent(entryId, tombstones);
    }
    for (const entryId of [...this.objectUrls.keys()]) {
      if (!present.has(entryId)) this.revokeObjectUrl(entryId);
    }
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

  private rejectWaiters(entryId: string, code: OfflineQueueErrorCode, message: string): void {
    const list = this.waiters.get(entryId);
    if (!list) return;
    this.waiters.delete(entryId);
    for (const waiter of list) waiter.reject(new OfflineQueueError(code, message, { entryId }));
  }

  private revokeObjectUrl(entryId: string): void {
    const cached = this.objectUrls.get(entryId);
    if (!cached) return;
    this.objectUrls.delete(entryId);
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(cached.url);
  }
}

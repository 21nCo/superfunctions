import type { PendingLocalDescriptor, UploadResult } from '../types.js';
import type { PendingLocalSourceMetadata } from '../preprocessing/types.js';
import {
  UPLOAD_SESSION_ENDED_ERROR,
  assertValidExplicitFileId,
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
  signal: AbortSignal;
}

export type OfflineQueueVerification = { verified: true } | { verified: false; reason: string };
export type OfflineQueuePublicationCheck = { published: true; result?: unknown } | { published: false };

export interface OfflineQueueHooks {
  /** Confirms an uploaded generation. A throw leaves it provisional and is retried. */
  verify?(context: OfflineQueueOperationContext): Promise<OfflineQueueVerification>;
  publish?: {
    /** Publishes a verified generation. The returned `result` must be JSON. */
    run(context: OfflineQueueOperationContext): Promise<{ result?: unknown } | void>;
    /**
     * Reports whether an earlier, unconfirmed `run` for this operation took
     * effect. Called before any retry of `run`.
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
 * now (null when signed out). The queue calls it before every upload and hook
 * and runs the step only when it matches the partition's principal, so staged
 * work never runs under another account's credentials (for example after an
 * account switch in another tab that shares cookies).
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
   * Replay key of the new generation. Defaults to a fresh random key. A key an
   * earlier generation of the entry used is refused (`idempotency-key-reused`).
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
  | { status: 'refused'; reason: 'publication-pending' | 'idempotency-key-reused'; currentGeneration: number }
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
  /** Hooks this generation needs, recorded when it was staged. */
  requires: { verify: boolean; publish: boolean };
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
  /** Replay keys of every generation of this entry, so no later one reuses them. */
  usedKeys: string[];
  migratedFrom?: string;
}

/** Partition-wide state: the last generation handed out, so a removed entry's numbers are never reused. */
interface PartitionMeta {
  journalVersion: typeof JOURNAL_VERSION;
  partitionId: string;
  lastGeneration: number;
}

type JournalRead =
  | { state: 'ok'; record: JournalRecord }
  | { state: 'missing' | 'corrupt' | 'foreign' };

type Plan =
  | { kind: 'done'; result: OfflineQueueProcessResult }
  | { kind: 'continue' }
  | { kind: 'upload'; record: JournalRecord; file: File }
  | { kind: 'verify' | 'publish' | 'reconcile-publication'; record: JournalRecord };

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

/**
 * A failure that no replay with the same input can fix. A conflict the server
 * marks retryable (a completion of the same session still running in another
 * tab, a concurrent write) is not: the outcome is unknown until replayed.
 */
function isPermanentUploadError(error: unknown): boolean {
  const failure = error as { code?: unknown; status?: unknown; retryable?: unknown; details?: { retryable?: unknown } } | undefined;
  if (failure?.code === 'FILEFN_CLIENT_FILE_ID_MISMATCH' || failure?.code === 'FILEFN_INVALID_FILE_ID') return true;
  if (failure?.retryable === true || failure?.details?.retryable === true) return false;
  // Another tab completed, or is completing, the same session: a replay reconciles it.
  if (typeof failure?.code === 'string' && REPLAYABLE_CONFLICTS.has(failure.code)) return false;
  const status = failure?.status;
  if (typeof status === 'number') {
    return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
  }
  return false;
}

const REPLAYABLE_CONFLICTS = new Set([
  'FILEFN_UPLOAD_COMPLETION_IN_PROGRESS',
  'FILEFN_UPLOAD_ALREADY_COMPLETED',
  'FILEFN_UPLOAD_INCOMPLETE',
]);

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
   * missing locks or storage, a full partition or a generation conflict.
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
    if (input.idempotencyKey !== undefined) requireId(input.idempotencyKey, 'idempotencyKey');
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

  /** The partition's entries. Entries of other partitions and unscoped legacy uploads are never listed. */
  async list(): Promise<OfflineQueueEntry[]> {
    const records = await this.transact(async (root) => this.readAll(root));
    const present = new Set(records.map((record) => record.entryId));
    for (const record of records) this.observe(record);
    this.forgetAbsent(present);
    return records
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.entryId.localeCompare(b.entryId))
      .map(snapshot);
  }

  async get(entryId: string): Promise<OfflineQueueEntry | null> {
    const record = await this.transact(async (root) => (await this.readEntry(root, entryId))?.record ?? null);
    if (record) this.observe(record);
    return record ? snapshot(record) : null;
  }

  /**
   * Settles when the generation is published (resolves), or is rejected,
   * fails, is superseded, cancelled or the queue is disposed (rejects). A
   * provisional generation keeps it pending.
   */
  whenSettled(entryId: string, generation: number): Promise<OfflineQueueEntry> {
    this.assertUsable();
    const promise = new Promise<OfflineQueueEntry>((resolve, reject) => {
      const list = this.waiters.get(entryId) ?? [];
      list.push({ generation, resolve, reject });
      this.waiters.set(entryId, list);
    });
    this.startObserving();
    void this.get(entryId).then(
      (entry) => {
        if (!entry) this.rejectWaiters(entryId, 'FILEFN_QUEUE_CANCELLED', 'Entry was removed');
      },
      () => {},
    );
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
      await removeEntry(await this.partitionDir(root), await this.entryKey(entryId), true);
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
   * Resolves a provisional generation. With `publication`, records a verified
   * outcome of an unconfirmed publication (`published: false` makes it safe to
   * publish again). Without it, clears the retry limit and ambiguity so the
   * next `process` retries the current step with the recorded identity.
   * Throws FILEFN_QUEUE_BUSY while any tab is processing the entry, so it never
   * races a running publication hook.
   */
  async reconcile(
    entryId: string,
    generation: number,
    publication?: OfflineQueuePublicationCheck,
  ): Promise<OfflineQueueEntry> {
    if (publication !== undefined && (publication === null || typeof publication !== 'object' || typeof publication.published !== 'boolean')) {
      throw new OfflineQueueError('FILEFN_QUEUE_INVALID_INPUT', 'publication.published must be true or false', { field: 'publication' });
    }
    const record = await this.withEntryLock(entryId, () => this.transact(async (root) => {
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
          throw new OfflineQueueError('FILEFN_QUEUE_INVALID_INPUT', 'Generation has no unconfirmed publication', { entryId, phase: cur.phase });
        }
        if (publication.published === true) {
          cur.phase = 'published';
          cur.publication = { result: toJson(publication.result) };
        } else {
          cur.phase = 'verified';
        }
      }
      cur.pending = undefined;
      if (!isTerminalPhase(cur.phase)) cur.attempts = 0;
      await this.writeRecord(dir, record);
      return record;
    }));
    if (record === BUSY) {
      throw new OfflineQueueError('FILEFN_QUEUE_BUSY', 'The entry is being processed; reconcile it once that finishes', { entryId, generation });
    }
    this.emitFor(record);
    this.observe(record);
    return snapshot(record);
  }

  /**
   * Advances one entry as far as it can go: upload, verification, publication
   * and cleanup. Returns `busy` when another tab or instance is processing it.
   */
  async process(entryId: string, options: { signal?: AbortSignal } = {}): Promise<OfflineQueueProcessResult> {
    const result = await this.withEntryLock(entryId, () => this.runPipeline(entryId, options.signal));
    return result === BUSY ? { status: 'busy' } : result;
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
    const { result, present } = await this.transact(async (root) => {
      const reclaimed = await this.reclaimIn(await this.partitionDir(root), false);
      return { result: reclaimed, present: new Set((await this.readAll(root)).map((record) => record.entryId)) };
    });
    this.forgetAbsent(present);
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
   * or replayed automatically; read only through this call.
   */
  async listLegacyUploads(): Promise<LegacyPendingUploadSummary[]> {
    this.assertUsable();
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
   * The legacy record is removed only after the new entry is written.
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
    const already = (await this.transact(async (root) => this.readAll(root))).find((record) => record.migratedFrom === uploadSessionId);
    if (already) {
      await store.deletePendingUpload(uploadSessionId);
      return { status: 'staged', entry: snapshot(already) };
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
        ...(legacy.idempotencyKey ? { idempotencyKey: legacy.idempotencyKey } : {}),
      },
      legacy.fileData,
      uploadSessionId,
    );
    if (result.status === 'staged') await store.deletePendingUpload(uploadSessionId);
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

  /** Runs `fn` under the partition lock. Throws FILEFN_QUEUE_DISPOSED once disposed, before or after waiting. */
  private async transact<T>(fn: (root: OfflineQueueDirectoryHandle) => Promise<T>): Promise<T> {
    this.assertUsable();
    const name = await this.partitionLockName();
    const root = await this.getRoot!();
    try {
      return await this.coordinator!.request(name, { signal: this.lifetime.signal }, async () => {
        this.assertUsable();
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
    parsed.usedKeys ??= [];
    return { state: 'ok', record: parsed };
  }

  /** Runs `fn` while holding the entry's own lock, or returns BUSY when another tab or call holds it. */
  private async withEntryLock<T>(entryId: string, fn: () => Promise<T>): Promise<T | typeof BUSY> {
    this.assertUsable();
    const lockName = `${await this.partitionLockName()}:entry:${await this.entryKey(entryId)}`;
    return this.coordinator!.request(lockName, { ifAvailable: true }, async (lock) => (lock ? fn() : BUSY));
  }

  /** The last generation handed out in this partition, from its meta file and its journals. */
  private async nextGeneration(partitionDir: OfflineQueueDirectoryHandle, previous: number): Promise<number> {
    let last = previous;
    const blob = await getFile(partitionDir, PARTITION_META_FILE);
    if (blob) {
      try {
        const meta = JSON.parse(await blob.text()) as PartitionMeta;
        if (meta.partitionId === (await this.partitionId()) && Number.isSafeInteger(meta.lastGeneration)) {
          last = Math.max(last, meta.lastGeneration);
        }
      } catch {
        // A meta file cut short by a crash: fall back to the journals.
      }
    }
    if (last === previous) {
      for (const record of await this.readAllIn(partitionDir)) last = Math.max(last, record.current.generation);
    }
    const next = last + 1;
    const meta: PartitionMeta = { journalVersion: JOURNAL_VERSION, partitionId: await this.partitionId(), lastGeneration: next };
    // Written before the journal that uses it, so a number is never handed out twice.
    await writeFile(partitionDir, PARTITION_META_FILE, JSON.stringify(meta));
    return next;
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

  private async stageBytes(
    input: OfflineQueueStageInput & { entryId: string; fileId: string; fileName: string; mimeType: string },
    bytes: ArrayBuffer,
    migratedFrom?: string,
  ): Promise<OfflineQueueStageResult> {
    const localSource = input.localSource ?? derivePendingLocalSource(input.fileName, input.mimeType, bytes.byteLength);
    const outcome = await this.transact(async (root) => {
      const partitionDir = await this.partitionDir(root);
      const key = await this.entryKey(input.entryId);
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
      const usedKeys = previous
        ? [...new Set([...previous.usedKeys, previous.current.replay.idempotencyKey, ...previous.current.replay.retiredKeys])]
        : [];
      if (input.idempotencyKey !== undefined && usedKeys.includes(input.idempotencyKey)) {
        // The server would replay the earlier generation's session and never receive these bytes.
        return { status: 'refused', reason: 'idempotency-key-reused', currentGeneration } as const;
      }
      // A new generation replaces the previous one's data.
      const replacedBytes = previous && !previous.current.dataRemoved ? previous.current.size : 0;
      const refusal = await this.ensureCapacity(partitionDir, existingDir ? 0 : 1, bytes.byteLength - replacedBytes, key);
      if (refusal) return refusal;

      let generation: number;
      try {
        generation = await this.nextGeneration(partitionDir, currentGeneration);
      } catch (error) {
        if (!isQuotaError(error)) throw error;
        return { status: 'refused', reason: 'capacity', limit: 'quota', usage: await this.measure(partitionDir), limits: this.limits } as const;
      }
      const dataFile = `g${generation}.bin`;
      const dir = existingDir ?? (await partitionDir.getDirectoryHandle(key, { create: true }));
      const hooks = this.options.hooks;
      const now = new Date().toISOString();
      const current: GenerationState = {
        generation,
        operationId: randomId('op'),
        dataFile,
        fileId: input.fileId,
        policy: input.policy,
        fileName: input.fileName,
        mimeType: input.mimeType,
        size: bytes.byteLength,
        ...(input.metadata !== undefined ? { metadata: toJson(input.metadata) as Record<string, unknown> } : {}),
        localSource: { ...localSource, opfsDataFile: dataFile },
        replay: { idempotencyKey: input.idempotencyKey ?? randomId('idem'), retiredKeys: [] },
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
        holds: holdId ? [{ holdId, generation, operationId: current.operationId }] : [],
        usedKeys,
        ...(migratedFrom ?? previous?.migratedFrom ? { migratedFrom: migratedFrom ?? previous?.migratedFrom } : {}),
      };
      try {
        // Data first: a crash before the journal write leaves an orphan file, never a journal without data.
        await writeFile(dir, dataFile, bytes);
        await this.writeRecord(dir, record);
      } catch (error) {
        await removeEntry(dir, dataFile).catch(() => {});
        if (!existingDir) await removeEntry(partitionDir, key, true).catch(() => {});
        if (isQuotaError(error)) {
          return { status: 'refused', reason: 'capacity', limit: 'quota', usage: await this.measure(partitionDir), limits: this.limits } as const;
        }
        throw error;
      }
      if (previous && previous.current.dataFile !== dataFile) {
        // Best effort: a leftover file is an orphan the next reclaim removes.
        await removeEntry(dir, previous.current.dataFile).catch(() => {});
      }
      return { status: 'staged', record, holdId } as const;
    });
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
   * retention (any age under `pressure`). A journal that never committed
   * (`corrupt`) counts as no journal. Provisional entries, journals of another
   * binding or layout, and `protect` are never removed.
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

  private async runPipeline(entryId: string, signal: AbortSignal | undefined): Promise<OfflineQueueProcessResult> {
    for (;;) {
      // Checked before planning too, so a signed-out or switched account never uses up an attempt.
      const principalOk = await this.principalMatches(signal ?? this.lifetime.signal);
      const plan = await this.transact(async (root) => this.planStep(root, entryId, principalOk));
      if (plan.kind === 'done') return plan.result;
      if (plan.kind === 'continue') continue;
      const outcome = await this.execute(entryId, plan, signal);
      if (outcome) return outcome;
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

  /** Decides and journals the next step. Every claim is written before the step's request is sent. */
  private async planStep(root: OfflineQueueDirectoryHandle, entryId: string, principalOk: boolean): Promise<Plan> {
    const found = await this.readEntry(root, entryId);
    if (!found) return { kind: 'done', result: { status: 'not-found' } };
    const { dir, record } = found;
    const cur = record.current;
    const provisional = (reason: Extract<OfflineQueueProcessResult, { status: 'provisional' }>['reason']): Plan => ({
      kind: 'done',
      result: { status: 'provisional', entry: snapshot(record), reason },
    });
    this.observe(record);
    if (record.holds.some((hold) => hold.operationId === cur.operationId) && cur.phase !== 'published') {
      return provisional('held');
    }
    if (!principalOk && !isTerminalPhase(cur.phase)) return provisional('principal-mismatch');
    const hooks = this.options.hooks;
    // A hook recorded at staging, or present on this instance, is required.
    const needsVerify = (cur.requires?.verify ?? true) || Boolean(hooks?.verify);
    const needsPublish = (cur.requires?.publish ?? true) || Boolean(hooks?.publish);
    switch (cur.phase) {
      case 'staged':
      case 'uploading': {
        if (cur.attempts >= this.maxUploadAttempts) {
          if (cur.pending?.reason !== 'retry-limit') {
            // Durable and reported once, so listeners, waiters and other tabs see it.
            cur.pending = { stage: 'upload', reason: 'retry-limit', ...(cur.error ? { message: cur.error.message } : {}) };
            await this.writeRecord(dir, record);
            this.emitFor(record);
            this.observe(record);
          }
          return provisional('retry-limit');
        }
        const blob = await getFile(dir, cur.dataFile);
        if (!blob) {
          cur.phase = 'failed';
          cur.error = { code: 'FILEFN_QUEUE_DATA_MISSING', message: 'Staged data is missing' };
          await this.writeRecord(dir, record);
          this.emitFor(record);
          return provisional('failed');
        }
        const file = new File([await blob.arrayBuffer()], cur.fileName, { type: cur.mimeType });
        cur.phase = 'uploading';
        cur.attempts += 1;
        if (cur.pending?.reason === 'retry-limit') cur.pending = undefined;
        cur.claim = { instanceId: this.instanceId, at: new Date().toISOString() };
        await this.writeRecord(dir, record);
        return { kind: 'upload', record: structuredClone(record), file };
      }
      case 'uploaded':
      case 'verifying':
        if (needsVerify && !hooks?.verify) return provisional('hook-unavailable');
        if (!needsVerify) {
          cur.phase = 'verified';
          cur.verification = { verified: true };
          await this.writeRecord(dir, record);
          return { kind: 'continue' };
        }
        if (cur.phase !== 'verifying') {
          cur.phase = 'verifying';
          await this.writeRecord(dir, record);
        }
        return { kind: 'verify', record: structuredClone(record) };
      case 'verified':
        if (needsPublish && !hooks?.publish) return provisional('hook-unavailable');
        if (!needsPublish) {
          cur.phase = 'published';
          cur.publication = {};
          await this.writeRecord(dir, record);
          this.emitFor(record);
          return { kind: 'continue' };
        }
        // Recorded before the hook runs, so a crash leaves it unconfirmed rather than unpublished.
        cur.phase = 'publishing';
        cur.pending = undefined;
        await this.writeRecord(dir, record);
        return { kind: 'publish', record: structuredClone(record) };
      case 'publishing':
        if (hooks?.publish?.reconcile) return { kind: 'reconcile-publication', record: structuredClone(record) };
        if (hooks?.publish?.idempotent) return { kind: 'publish', record: structuredClone(record) };
        if (cur.pending?.reason !== 'needs-reconcile') {
          cur.pending = { stage: 'publication', reason: 'needs-reconcile' };
          await this.writeRecord(dir, record);
        }
        return provisional('needs-reconcile');
      case 'published':
        if (!cur.dataRemoved) {
          await removeEntry(dir, cur.dataFile);
          cur.dataRemoved = true;
          await this.writeRecord(dir, record);
        }
        return { kind: 'done', result: { status: 'published', entry: snapshot(record) } };
      case 'rejected':
        return provisional('rejected');
      default:
        return provisional('failed');
    }
  }

  private async execute(
    entryId: string,
    plan: Extract<Plan, { record: JournalRecord }>,
    signal: AbortSignal | undefined,
  ): Promise<OfflineQueueProcessResult | null> {
    const cur = plan.record.current;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    // Already aborted when disposal or the caller's abort came first: no event would fire.
    if (this.lifetime.signal.aborted || signal?.aborted) controller.abort();
    this.lifetime.signal.addEventListener('abort', onAbort, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    this.entryControllers.set(entryId, controller);
    const stopped = async (): Promise<OfflineQueueProcessResult | null> => {
      this.assertUsable();
      if (controller.signal.aborted) return { status: 'provisional', entry: snapshot(plan.record), reason: 'aborted' };
      if (!(await this.principalMatches(controller.signal))) {
        return { status: 'provisional', entry: snapshot(plan.record), reason: 'principal-mismatch' };
      }
      this.assertUsable();
      return controller.signal.aborted ? { status: 'provisional', entry: snapshot(plan.record), reason: 'aborted' } : null;
    };
    const context = (): OfflineQueueOperationContext => ({
      partition: this.partition,
      entryId,
      generation: cur.generation,
      operationId: cur.operationId,
      fileId: cur.upload?.fileId ?? cur.fileId,
      versionId: cur.upload?.versionId ?? '',
      signal: controller.signal,
    });
    try {
      // Re-checked right before every upload and hook: disposal, abort and the current principal.
      const stop = await stopped();
      if (stop) return stop;
      switch (plan.kind) {
        case 'upload':
          return await this.executeUpload(entryId, plan.record, plan.file, controller.signal);
        case 'verify': {
          let outcome: OfflineQueueVerification;
          try {
            outcome = await raceAbort(this.options.hooks!.verify!(context()), controller.signal);
          } catch (error) {
            return this.markAmbiguous(entryId, plan.record, 'verification', error);
          }
          if (outcome?.verified === true) {
            return this.commit(entryId, plan.record, (state) => {
              state.phase = 'verified';
              state.verification = { verified: true };
              state.pending = undefined;
            });
          }
          if (outcome?.verified === false) {
            return this.commit(entryId, plan.record, (state) => {
              state.phase = 'rejected';
              state.verification = { verified: false, reason: String(outcome.reason ?? '') };
              state.pending = undefined;
            }, 'rejected');
          }
          return this.markAmbiguous(entryId, plan.record, 'verification', new Error('verify returned no outcome'));
        }
        case 'publish': {
          let published: { result?: unknown } | void;
          try {
            published = await raceAbort(this.options.hooks!.publish!.run(context()), controller.signal);
          } catch (error) {
            return this.markAmbiguous(entryId, plan.record, 'publication', error);
          }
          return this.commit(entryId, plan.record, (state) => {
            state.phase = 'published';
            state.publication = { result: toJson(published ? published.result : undefined) };
            state.pending = undefined;
          });
        }
        case 'reconcile-publication': {
          let check: OfflineQueuePublicationCheck;
          try {
            check = await raceAbort(this.options.hooks!.publish!.reconcile!(context()), controller.signal);
          } catch (error) {
            return this.markAmbiguous(entryId, plan.record, 'publication', error);
          }
          if (check?.published === true) {
            return this.commit(entryId, plan.record, (state) => {
              state.phase = 'published';
              state.publication = { result: toJson(check.published ? check.result : undefined) };
              state.pending = undefined;
            });
          }
          if (check?.published === false) {
            return this.commit(entryId, plan.record, (state) => {
              state.phase = 'verified';
            });
          }
          return this.markAmbiguous(entryId, plan.record, 'publication', new Error('reconcile returned no outcome'));
        }
      }
      return null;
    } finally {
      this.lifetime.signal.removeEventListener('abort', onAbort);
      signal?.removeEventListener('abort', onAbort);
      if (this.entryControllers.get(entryId) === controller) this.entryControllers.delete(entryId);
    }
  }

  private async executeUpload(
    entryId: string,
    record: JournalRecord,
    file: File,
    signal: AbortSignal,
  ): Promise<OfflineQueueProcessResult | null> {
    const cur = record.current;
    let result: UploadResult;
    try {
      result = await raceAbort(
        this.options.uploader.upload({
          policy: cur.policy,
          file,
          fileName: cur.fileName,
          metadata: cur.metadata,
          fileId: cur.fileId,
          idempotencyKey: cur.replay.idempotencyKey,
          signal,
        }),
        signal,
      );
    } catch (error) {
      this.assertUsable();
      if (signal.aborted || isAbort(error)) {
        return { status: 'provisional', entry: snapshot(record), reason: 'aborted' };
      }
      if ((error as { code?: unknown })?.code === UPLOAD_SESSION_ENDED_ERROR) {
        // Confirmed final: a fresh key is journaled before the next request uses it.
        return this.commit(entryId, record, (state) => {
          state.replay.retiredKeys.push(state.replay.idempotencyKey);
          state.replay.idempotencyKey = randomId('idem');
          state.phase = 'staged';
          state.pending = undefined;
        });
      }
      if (isPermanentUploadError(error)) {
        return this.commit(entryId, record, (state) => {
          state.phase = 'failed';
          state.error = errorInfo(error);
          state.claim = undefined;
        }, 'failed');
      }
      return this.markAmbiguous(entryId, record, 'upload', error);
    }
    if (result.fileId !== cur.fileId) {
      return this.commit(entryId, record, (state) => {
        state.phase = 'failed';
        state.error = { code: 'FILEFN_CLIENT_FILE_ID_MISMATCH', message: 'Server stored a different fileId' };
      }, 'failed');
    }
    return this.commit(entryId, record, (state) => {
      state.phase = 'uploaded';
      state.upload = { fileId: result.fileId, versionId: result.versionId };
      state.pending = undefined;
      state.claim = undefined;
    });
  }

  /**
   * Applies `mutate` only if the entry is still at the planned generation and
   * operation. A newer generation is never touched by an older one's result.
   * Returns null to continue the pipeline, or the final result.
   */
  private async commit(
    entryId: string,
    planned: JournalRecord,
    mutate: (state: GenerationState) => void,
    stopReason?: 'rejected' | 'failed' | 'ambiguous',
  ): Promise<OfflineQueueProcessResult | null> {
    const record = await this.transact(async (root) => {
      const found = await this.readEntry(root, entryId);
      if (!found) return null;
      const cur = found.record.current;
      if (
        cur.generation !== planned.current.generation ||
        cur.operationId !== planned.current.operationId ||
        // The step's claim: an outcome recorded meanwhile (an explicit reconcile) is never overwritten.
        cur.phase !== planned.current.phase
      ) {
        return null;
      }
      mutate(cur);
      await this.writeRecord(found.dir, found.record);
      return found.record;
    });
    if (!record) return { status: 'superseded' };
    this.emitFor(record);
    this.observe(record);
    return stopReason ? { status: 'provisional', entry: snapshot(record), reason: stopReason } : null;
  }

  private async markAmbiguous(
    entryId: string,
    planned: JournalRecord,
    stage: OfflineQueuePending['stage'],
    error: unknown,
  ): Promise<OfflineQueueProcessResult> {
    // A disposed instance writes nothing: the outcome stays as journaled.
    this.assertUsable();
    const result = await this.commit(entryId, planned, (state) => {
      state.pending = { stage, reason: 'ambiguous', message: errorInfo(error).message };
    }, 'ambiguous');
    return result ?? { status: 'superseded' };
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

  /** Settles waiters and drops previews of entries that are gone (cancelled or reclaimed, here or in another tab). */
  private forgetAbsent(present: Set<string>): void {
    for (const entryId of [...this.waiters.keys()]) {
      if (!present.has(entryId)) this.rejectWaiters(entryId, 'FILEFN_QUEUE_CANCELLED', 'Entry was removed');
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
      void Promise.all(entryIds.map(async (entryId) => {
        if (!(await this.get(entryId))) this.rejectWaiters(entryId, 'FILEFN_QUEUE_CANCELLED', 'Entry was removed');
      }))
        .catch(() => {})
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

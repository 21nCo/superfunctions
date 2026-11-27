import { createHash, randomUUID } from 'node:crypto';
import type { Adapter } from '@superfunctions/db';
import { getStorageCapabilities, type StorageAdapter } from '@superfunctions/storage';
import type { FileProviderContext } from '@superfunctions/files';
import type { FileFnEventEmitter } from '../events.js';
import { resolveArtifactStorageTarget, resolveStorageTarget, type PolicyRegistry } from '../policies.js';
import type { Logger } from '../observability/logger.js';
import { recordProcessingDuration, type FileFnMetrics } from '../metrics.js';
import { signedDownloadConstraints } from '../download-headers.js';
import * as errors from '../errors.js';
import { createBackgroundScheduler, type BackgroundScheduler } from '../runtime.js';
import { findReferencedStorageRefs, parseStorageRef, storageRef } from '../storage-references.js';
import {
  CLIENT_ARTIFACT_KINDS,
  MAX_CLIENT_PROCESSING_DURATION_MS,
  artifactSourceOf,
  clientArtifactRule,
  normalizeMimeType,
  type ClientArtifactProcessingMetadata,
} from './client-artifacts.js';
import { isGrantExpired } from '../authz/grant-expiry.js';
import { isFileOwner } from '../authz/ownership.js';

export interface Processor {
  name: string;
  supportedMimeTypes: string[];
  /**
   * Artifact kinds the processor may emit. When every one of them has a
   * client-supplied artifact for the version, an unforced run skips the
   * processor. Without it the processor runs, and its artifacts of a kind the
   * client supplied are dropped unless the run is forced.
   */
  artifactKinds?: string[];
  process(
    input: ProcessorInput,
    getData: () => Promise<Uint8Array>
  ): Promise<ProcessorResult>;
}

export interface ProcessorInput {
  fileId: string;
  versionId: string;
  storageKey: string;
  mimeType: string;
  size: number;
  fileName: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
}

export interface ProcessorOutputArtifact {
  kind: string;
  data: Uint8Array;
  mimeType: string;
  storageKey: string;
  metadata?: Record<string, unknown>;
}

export interface ProcessorResult {
  success: boolean;
  artifacts: ProcessorOutputArtifact[];
  error?: string;
}

/** Queue name FileFn enqueues processing jobs on through `flowFn.getQueue`. */
export const PROCESSING_QUEUE_NAME = 'filefn.processing';

/**
 * Body FileFn enqueues for each processing job. A producer may add fields
 * (the Cloudflare producer adds `jobId`). The job handler reads the version
 * from the database and ignores the file details carried here.
 */
export interface ProcessingJob {
  fileId: string;
  versionId: string;
  idempotencyKey: string;
  storageKey?: string;
  mimeType?: string;
  size?: number;
  fileName?: string;
  tenantId?: string;
  requestId?: string;
  jobId?: string;
  /** Replace client-supplied artifacts too, instead of skipping their kinds. */
  force?: boolean;
}

/** Result of running one queued processing job. */
export type ProcessingJobOutcome =
  /**
   * Every applicable processor succeeded and `processing.completed` was
   * emitted; processors with a run recorded for this key were skipped.
   * `artifactsCreated` counts the job's artifacts across its deliveries.
   */
  | { status: 'completed'; artifactsCreated: number; skippedProcessors: ProcessorInstance[] }
  /** Every applicable processor has a run recorded for this key and the job's completion was recorded. */
  | { status: 'duplicate' }
  /** Nothing to process: the body is not a job, or the file version no longer exists. */
  | { status: 'dropped'; reason: 'invalid-job' | 'version-deleted' }
  /**
   * A processor failed, or cleanup of a deleted version's output failed, and
   * the delivery is not the last; the queue should redeliver.
   */
  | { status: 'retry'; errors: string[] }
  /** A processor failed on the last delivery; `processing.failed` was emitted. */
  | { status: 'failed'; errors: string[] };

/**
 * One configured processor: its name and its 1-based position among the
 * configured processors with that name (the bundled gzip and deflate
 * compression processors are both named `compression`).
 */
export interface ProcessorInstance {
  processor: string;
  instance: number;
}

export interface ProcessingJobDelivery {
  /** 1-based delivery attempt, e.g. a Cloudflare message's `attempts`. */
  attempts: number;
  /** True when the queue will not redeliver after this attempt. */
  finalAttempt: boolean;
}

/** FileFn's record of how an artifact was produced, stored under `metadata.processing`. */
export interface ArtifactProcessingMetadata {
  source: 'server';
  processor: string;
  /** Wall-clock time the processor's `process` call took, in milliseconds. */
  durationMs: number;
  idempotencyKey: string;
  /**
   * Storage target the artifact object was written to. Cleanup of a deleted
   * version uses it once the file row, and so its policy, is gone.
   */
  storageTarget: string;
}

/**
 * Kind of the `fileArtifacts` rows a processing job writes to record that one
 * processor finished for one idempotency key, including a run that produced
 * no artifacts, and that the job's `processing.completed` was emitted. They
 * have no stored object, and the artifact list, lookup and download
 * operations never return them.
 */
export const PROCESSING_RUN_KIND = 'filefn.processing-run';

/**
 * Kind of the `fileArtifacts` rows that keep an object an artifact row stopped
 * naming (a replaced artifact, or a server upload that lost to a client
 * artifact) owned by its file version, so cleanup still finds it. A row is
 * written before the artifact row switches away from the object. A client
 * object's record goes only once its delete is confirmed: file deletion
 * leaves it (and turns each client artifact row into one) for
 * `cleanupOrphanedArtifacts`. A server object's record stays, and nothing
 * deletes its object, since its key may be published again at any moment
 * (see `discardDisplacedObject`). The artifact list, lookup and download
 * operations never return them.
 */
export const DISPLACED_OBJECT_KIND = 'filefn.displaced-object';

/**
 * Kind of the `fileArtifacts` rows that record a client upload's own object
 * from before it is written until a row names it or it is deleted. An upload
 * lives at most `CLIENT_ARTIFACT_UPLOAD_MS` from before its record and
 * starts or waits for no write and commits nothing after that, so besides
 * the upload itself only `cleanupOrphanedArtifacts` removes one, once its
 * version is gone and that lifetime and a grace period are over, counted
 * from the record's last renewal while a store the upload gave up on was
 * still under way (see `holdUntilSettled`); file and version cleanup leave
 * them in place.
 */
export const UPLOAD_INTENT_KIND = 'filefn.upload-intent';

/** True for a row kind FileFn keeps for itself rather than an artifact. */
function isInternalKind(kind: string): boolean {
  return kind === PROCESSING_RUN_KIND || kind === DISPLACED_OBJECT_KIND || kind === UPLOAD_INTENT_KIND;
}

export interface FlowFnQueue {
  name: string;
  add(job: unknown): Promise<{ jobId: string }>;
}

export interface FlowFnProvider {
  getQueue(name: string): FlowFnQueue | undefined;
}

export interface ProcessingServiceConfig {
  db: Adapter;
  storage: StorageAdapter;
  policies?: Pick<PolicyRegistry, 'get'>;
  events: FileFnEventEmitter;
  processors?: Processor[];
  flowFn?: FlowFnProvider;
  logger?: Logger;
  /** Records processing duration when a run reaches `processing.completed`. */
  metrics?: FileFnMetrics;
  namespace?: string;
  enabled?: boolean;
  maxFileBytes?: number;
  /** Runs queue-less processing after the response; defaults to a detached `setImmediate`. */
  background?: BackgroundScheduler;
  /**
   * Decides who may write a file (attach artifacts, force processing);
   * FileFn passes its file service so the configured authorizer applies.
   * Without it only the file's owner may.
   */
  writeChecker?: { canWriteFile(fileId: string, ctx: FileProviderContext): Promise<boolean> };
  /**
   * Decides who may read a file (list and download artifacts, trigger
   * processing). FileFn passes its file service, so the configured authorizer
   * and grants decide exactly as they do for the file itself. Without it the
   * service falls back to owner, visibility and read grants.
   */
  readChecker?: { canReadFile(fileId: string, ctx: FileProviderContext): Promise<boolean> };
}

/** A client-supplied artifact for one file version. */
export interface ClientArtifactUpload {
  fileId: string;
  versionId: string;
  kind: string;
  /** Content-Type of the body. */
  mimeType: string;
  body: ReadableStream<Uint8Array> | Uint8Array | Blob | null | undefined;
  /** Declared body length, checked before any byte is stored; a stream body needs it on storage that only signs upload URLs. */
  contentLength?: number;
  /** Time the client spent producing the artifact, in milliseconds. */
  durationMs?: number;
}

export interface FileArtifactRecord {
  artifactId: string;
  fileId: string;
  versionId: string;
  kind: string;
  storageKey: string;
  mimeType: string;
  size: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/** An object an artifact row named, or was about to name. */
type DisplacedObject = Pick<FileArtifactRecord, 'fileId' | 'versionId' | 'storageKey' | 'metadata'>;

interface FileRecord {
  fileId: string;
  currentVersionId: string;
  ownerId: string;
  tenantId: string | null;
  visibility: 'private' | 'shared' | 'public';
  policy: string;
  name: string;
  mimeType: string;
  size: number;
}

interface FilePermissionRecord {
  fileId: string;
  userId?: string;
  tenantId?: string | null;
  canRead?: boolean;
  expiresAt?: string | null;
}

interface FileVersionRecord {
  versionId: string;
  fileId: string;
  storageKey: string;
  mimeType: string;
  size: number;
}

/** Crockford base32, lowercase, matching the alphabet of generated FileFn IDs. */
const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

function derivedId(prefix: string, parts: (string | number)[]): string {
  // JSON keeps the parts apart whatever characters they contain.
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest();
  let suffix = '';
  for (let index = 0; index < 20; index += 1) {
    suffix += ID_ALPHABET[digest[index] & 31];
  }
  return `${prefix}_${suffix}`;
}

/**
 * Derives the artifact ID for one (file, version, kind). Concurrent deliveries
 * of the same job then create the same row, so the unique `artifactId` makes
 * the second insert fail instead of adding a duplicate artifact.
 */
function artifactIdFor(fileId: string, versionId: string, kind: string): string {
  return derivedId('art', [fileId, versionId, kind]);
}

/** Derives the ID of the run row for one processor instance and idempotency key. */
function processingRunIdFor(
  fileId: string,
  versionId: string,
  idempotencyKey: string,
  instance: ProcessorInstance,
): string {
  return derivedId('run', [PROCESSING_RUN_KIND, fileId, versionId, idempotencyKey, instance.processor, instance.instance]);
}

/**
 * Derives the ID of the row that records that a job's `processing.completed`
 * was emitted. Its parts have a different length from a processor run's, so
 * no processor instance can derive it.
 */
function processingCompletionIdFor(fileId: string, versionId: string, idempotencyKey: string): string {
  return derivedId('run', [PROCESSING_RUN_KIND, fileId, versionId, idempotencyKey]);
}

/** Artifacts a run row says its processor recorded. */
function recordedArtifactCount(run: FileArtifactRecord | undefined): number {
  const count = (run?.metadata?.processingRun as { artifactCount?: unknown } | undefined)?.artifactCount;
  return typeof count === 'number' && Number.isFinite(count) ? count : 0;
}

/** Storage target a processing-written artifact row recorded for its object. */
export function recordedStorageTarget(row: { metadata?: Record<string, unknown> }): string | undefined {
  const target = (row.metadata?.processing as { storageTarget?: unknown } | undefined)?.storageTarget;
  return typeof target === 'string' && target.length > 0 ? target : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Why a processor's result cannot be accepted, or `undefined` when it can.
 * `success` must be a boolean; a success needs an `artifacts` array whose
 * every artifact can be stored, under a kind other than the reserved run
 * kind. Nothing is uploaded or recorded for a result this rejects.
 */
function invalidProcessorResult(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return 'processor returned an invalid result';
  const { success, artifacts } = result as Partial<ProcessorResult>;
  if (typeof success !== 'boolean') return 'processor returned an invalid result';
  if (!success) return undefined;
  if (!Array.isArray(artifacts)) return 'processor returned an invalid result';
  for (const artifact of artifacts as unknown[]) {
    const { kind, storageKey, mimeType, data } = (artifact ?? {}) as Partial<ProcessorOutputArtifact>;
    if (typeof kind === 'string' && isInternalKind(kind)) return `processor emitted the reserved artifact kind ${kind}`;
    if (!isNonEmptyString(kind) || !isNonEmptyString(storageKey) || typeof mimeType !== 'string' || !(data instanceof Uint8Array)) {
      return 'processor returned an invalid artifact';
    }
  }
  return undefined;
}

/** Runs one processor and times its `process` call. */
async function executeProcessor(
  processor: Processor,
  input: ProcessorInput,
  getData: () => Promise<Uint8Array>,
): Promise<{ result?: ProcessorResult; error?: string; durationMs: number }> {
  const startedAt = Date.now();
  try {
    const result = await processor.process(input, getData);
    const durationMs = Math.max(0, Date.now() - startedAt);
    // An invalid result is a processor failure, never a skip or a success.
    const invalid = invalidProcessorResult(result);
    if (invalid) {
      return { error: invalid, durationMs };
    }
    if (!result.success) {
      return { error: result.error, durationMs };
    }
    return { result, durationMs };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Unknown error', durationMs: Math.max(0, Date.now() - startedAt) };
  }
}

/**
 * Emits a processing event to every listener without letting one change the
 * job or keep the event from the others: a listener's error is logged.
 */
function emitIsolated(
  events: FileFnEventEmitter,
  logger: Logger | undefined,
  event: 'processing.started' | 'processing.completed' | 'processing.failed',
  payload: { requestId?: string; fileId: string; versionId: string } & Record<string, unknown>,
): void {
  events.emitToEachListener(event, { type: event, timestamp: new Date().toISOString(), ...payload } as any, (error) => {
    logger?.error(`${event} listener failed`, {
      requestId: payload.requestId,
      fileId: payload.fileId,
      versionId: payload.versionId,
      error: errorMessage(error),
    });
  });
}

const MAX_JOB_FIELD_LENGTH = 512;

/**
 * Times one artifact write re-reads its row after another writer changed it
 * first. Each retry follows a write that landed, so a writer only runs out
 * under sustained concurrent writes of the same kind.
 */
const MAX_ARTIFACT_WRITE_ATTEMPTS = 5;
/** Lifetime of a URL the server signs for its own upload, used at once. */
const SIGNED_SERVER_UPLOAD_TTL_SECONDS = 300;
/** How long a client artifact upload may take; past it, it stores and commits nothing. */
const CLIENT_ARTIFACT_UPLOAD_MS = 30 * 60 * 1000;
/** How long after an upload's lifetime a sweep still leaves its record alone, for storage writes already in flight. */
const CLIENT_ARTIFACT_RECORD_GRACE_MS = 24 * 60 * 60 * 1000;
/**
 * How often an upload renews the record of an object whose store it gave up
 * on while that store is still under way, well within the grace period, so a
 * sweep never retires it while that store may still publish the object.
 */
const CLIENT_ARTIFACT_HOLD_RENEW_MS = 60 * 60 * 1000;

interface StoredObject {
  key: string;
  target: string;
  contentType: string;
}

function isJobField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_JOB_FIELD_LENGTH;
}

/** An optional job field that fails the bound is left out instead of invalidating the job. */
function optionalJobField(value: unknown): string | undefined {
  return isJobField(value) ? value : undefined;
}

function parseProcessingJob(body: unknown): Omit<ProcessingJob, 'idempotencyKey'> & { idempotencyKey?: string } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const job = body as Record<string, unknown>;
  if (!isJobField(job.fileId) || !isJobField(job.versionId)) {
    return null;
  }
  return {
    fileId: job.fileId,
    versionId: job.versionId,
    idempotencyKey: optionalJobField(job.idempotencyKey),
    jobId: optionalJobField(job.jobId),
    requestId: optionalJobField(job.requestId),
    force: job.force === true ? true : undefined,
  };
}

/**
 * Cleanup of a deleted version's processing output failed. The job is about
 * a version that no longer exists, so it is never a processing failure: the
 * cleanup is retried while the queue redelivers, and the rows it kept are
 * logged after the last delivery.
 */
class DeletedVersionCleanupError extends Error {
  constructor(readonly keptArtifactIds: string[], cause: unknown) {
    super(`cleanup of deleted version output failed: ${errorMessage(cause)}`);
    this.name = 'DeletedVersionCleanupError';
  }
}

/** A configured processor and the instance that identifies it in run records. */
interface ProcessorEntry {
  processor: Processor;
  instance: ProcessorInstance;
  /** Names the processor in error messages; never used as an identity. */
  label: string;
}

/**
 * Identifies each configured processor by its name and its position among
 * the processors with that name, kept as separate values so no name can
 * stand for another processor's instance.
 */
function processorEntriesFor(processors: Processor[]): ProcessorEntry[] {
  const seen = new Map<string, number>();
  return processors.map((processor) => {
    const instance = (seen.get(processor.name) ?? 0) + 1;
    seen.set(processor.name, instance);
    return {
      processor,
      instance: { processor: processor.name, instance },
      label: instance === 1 ? processor.name : `${processor.name} (instance ${instance})`,
    };
  });
}

/** What one processing run wrote, kept even when a later write fails. */
interface ProcessingWrites {
  artifactsRecorded: number;
  uploadedKeys: Set<string>;
}

function emptyWrites(): ProcessingWrites {
  return { artifactsRecorded: 0, uploadedKeys: new Set<string>() };
}

function supportsProcessor(processor: Processor, mimeType: string): boolean {
  if (processor.supportedMimeTypes.includes('*/*')) {
    return true;
  }
  return processor.supportedMimeTypes.includes(mimeType);
}

/**
 * The job's idempotency key: the file version and its sorted processor names.
 * A forced run adds a fresh nonce, so it never counts as a duplicate of an
 * earlier run and every processor runs again. A key too long for the job
 * field bound replaces that part with its hash, so the consumer never rejects
 * a key FileFn enqueued.
 */
function buildProcessingIdempotencyKey(
  fileId: string,
  versionId: string,
  processors: Processor[],
  force = false,
): string {
  const processorKey = processors.map((processor) => processor.name).sort().join(',');
  const runKey = force ? `${processorKey}:force:${randomUUID()}` : processorKey;
  const key = `processing:${fileId}:${versionId}:${runKey}`;
  if (key.length <= MAX_JOB_FIELD_LENGTH) {
    return key;
  }
  const digest = createHash('sha256').update(runKey).digest('hex');
  return `processing:${fileId}:${versionId}:sha256:${digest}`;
}

/**
 * The processors a run executes: an unforced run leaves out a processor
 * whose declared kinds the client supplied every one of.
 */
function excludeClientCovered<T>(
  entries: T[],
  processorOf: (entry: T) => Processor,
  clientKinds: ReadonlySet<string>,
  force: boolean,
): T[] {
  if (force || clientKinds.size === 0) return entries;
  return entries.filter((entry) => {
    const kinds = processorOf(entry).artifactKinds;
    return !(Array.isArray(kinds) && kinds.length > 0 && kinds.every((kind) => clientKinds.has(kind)));
  });
}


/**
 * Reads a client artifact body chunk by chunk, a Blob as a stream so it is
 * never copied whole. Cancelling one left early is never waited for, so a
 * body that hangs on cancel cannot hold up its upload.
 */
function bodyReader(body: ReadableStream<Uint8Array> | Uint8Array | Blob): {
  read(): Promise<Uint8Array | null>;
  cancel(reason: unknown): void;
} {
  if (body instanceof Uint8Array) {
    let chunk: Uint8Array | null = body;
    return {
      read: async () => {
        const next = chunk;
        chunk = null;
        return next;
      },
      cancel: () => undefined,
    };
  }
  const stream = typeof Blob !== 'undefined' && body instanceof Blob ? body.stream() : body as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  let finished = false;
  return {
    async read() {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          return null;
        }
        if (value && value.byteLength > 0) return value instanceof Uint8Array ? value : new Uint8Array(value);
      }
    },
    cancel(reason) {
      if (finished) return;
      finished = true;
      reader.cancel(reason).catch(() => undefined);
    },
  };
}

export function createProcessingService(config: ProcessingServiceConfig) {
  const {
    db,
    storage,
    policies,
    events,
    processors = [],
    flowFn,
    logger,
    metrics,
    namespace = 'filefn',
    enabled = true,
    maxFileBytes = 50 * 1024 * 1024,
    writeChecker,
    readChecker,
  } = config;
  const background = config.background ?? createBackgroundScheduler(undefined, logger);

  const QUEUE_NAME = PROCESSING_QUEUE_NAME;

  async function getReadableGrantFileIds(ctx: FileProviderContext): Promise<Set<string>> {
    if (!ctx.principalId) {
      return new Set<string>();
    }

    const grants: FilePermissionRecord[] = [];
    grants.push(...await db.findMany<FilePermissionRecord>({
      model: 'filePermissions',
      where: [{ field: 'userId', operator: 'eq', value: ctx.principalId }],
      namespace,
    }));
    if (ctx.tenantId) {
      grants.push(...await db.findMany<FilePermissionRecord>({
        model: 'filePermissions',
        where: [{ field: 'tenantId', operator: 'eq', value: ctx.tenantId }],
        namespace,
      }));
    }

    const readable = new Set<string>();
    for (const grant of grants) {
      if (!grant?.canRead || isGrantExpired(grant.expiresAt)) continue;
      if (
        grant.userId === ctx.principalId ||
        (grant.tenantId && grant.tenantId === ctx.tenantId)
      ) {
        readable.add(grant.fileId);
      }
    }

    return readable;
  }

  function canReadByVisibility(file: FileRecord, ctx: FileProviderContext): boolean {
    if (file.visibility === 'public') return true;
    if (isFileOwner(file, ctx)) return true;
    if (file.visibility === 'shared' && file.tenantId && file.tenantId === ctx.tenantId) return true;
    return false;
  }

  // The artifacts listed for a file (internal kinds excluded); callers authorize first.
  async function queryArtifacts(fileId: string, page?: { limit?: number; offset?: number }): Promise<FileArtifactRecord[]> {
    const artifacts = await db.findMany<FileArtifactRecord>({
        model: 'fileArtifacts',
        where: [
          { field: 'fileId', operator: 'eq', value: fileId },
          { field: 'kind', operator: 'ne', value: PROCESSING_RUN_KIND },
          { field: 'kind', operator: 'ne', value: DISPLACED_OBJECT_KIND },
          { field: 'kind', operator: 'ne', value: UPLOAD_INTENT_KIND },
        ],
        orderBy: [
          { field: 'createdAt', direction: 'desc' },
          { field: 'artifactId', direction: 'asc' },
        ],
        limit: page?.limit,
        offset: page?.offset,
        namespace,
      });

    return artifacts;
  }

  async function requireReadableFile(fileId: string, ctx: FileProviderContext): Promise<FileRecord> {
    const file = await db.findOne<FileRecord>({
      model: 'files',
      where: [{ field: 'fileId', operator: 'eq', value: fileId }],
      namespace,
    });

    if (!file) {
      throw errors.notFound('File');
    }

    // An unauthenticated guest (no principal, or the shared 'anonymous'
    // principal) reads only public files here, as before, whatever a host
    // authorizer or the fallback rules would allow it.
    if ((!ctx.principalId || ctx.principalId === 'anonymous') && file.visibility !== 'public') {
      throw errors.forbidden();
    }

    // The file service's read check applies the host's authorizer, so an
    // artifact (often the whole content: OCR text, previews, transcodes) is
    // never readable by someone the authorizer refuses the file to.
    if (readChecker) {
      if (await readChecker.canReadFile(fileId, ctx)) {
        return file;
      }
      throw errors.forbidden();
    }

    if (canReadByVisibility(file, ctx)) {
      return file;
    }

    const grantFileIds = await getReadableGrantFileIds(ctx);
    if (grantFileIds.has(fileId)) {
      return file;
    }

    throw errors.forbidden();
  }

  async function getVersionChecked(fileId: string, versionId: string): Promise<FileVersionRecord> {
    const version = await db.findOne<FileVersionRecord>({
      model: 'fileVersions',
      where: [{ field: 'versionId', operator: 'eq', value: versionId }],
      namespace,
    });

    if (!version) {
      throw errors.notFound('Version');
    }

    if (version.fileId !== fileId) {
      throw errors.notFound('Version');
    }

    return version;
  }

  /**
   * The file, when the principal may write it: its owner or a writer, as the
   * configured write check decides. Read access is not checked separately, so
   * a writer the configured authorizer allows is not refused by this
   * service's own visibility and grant rules.
   */
  async function requireWritableFile(fileId: string, ctx: FileProviderContext): Promise<FileRecord> {
    const file = await db.findOne<FileRecord>({
      model: 'files',
      where: [{ field: 'fileId', operator: 'eq', value: fileId }],
      namespace,
    });
    if (!file) {
      throw errors.notFound('File');
    }
    const canWrite = writeChecker
      ? await writeChecker.canWriteFile(fileId, ctx)
      : isFileOwner(file, ctx);
    if (!canWrite) {
      throw errors.forbidden();
    }
    return file;
  }

  async function getReadableVersionForFile(
    fileId: string,
    ctx: FileProviderContext,
    versionId?: string,
  ): Promise<{ file: FileRecord; version: FileVersionRecord }> {
    const file = await requireReadableFile(fileId, ctx);
    const version = await getVersionChecked(fileId, versionId || file.currentVersionId);
    return { file, version };
  }

  function getFileStorageTarget(file: Pick<FileRecord, 'policy'>): string {
    return resolveStorageTarget(policies?.get(file.policy) ?? {});
  }

  function getArtifactStorageTarget(file: Pick<FileRecord, 'policy'>): string {
    return resolveArtifactStorageTarget(policies?.get(file.policy) ?? {});
  }

  async function getBoundArtifact(fileId: string, artifactId: string): Promise<FileArtifactRecord> {
    const artifact = await db.findOne<FileArtifactRecord>({
      model: 'fileArtifacts',
      where: [{ field: 'artifactId', operator: 'eq', value: artifactId }],
      namespace,
    });

    if (!artifact || isInternalKind(artifact.kind)) {
      throw errors.notFound('Artifact');
    }

    if (artifact.fileId !== fileId) {
      throw errors.notFound('Artifact');
    }

    return artifact;
  }

  /**
   * Returns a reader that loads the source object once per run. Processing
   * reads the source into memory, so overly large inputs are rejected early.
   */
  function createSourceReader(storageKey: string, target: string): () => Promise<Uint8Array> {
    let dataCache: Uint8Array | null = null;
    return async (): Promise<Uint8Array> => {
      if (dataCache) return dataCache;

      if (!storage.openDownloadStream) {
        throw new Error('Storage adapter does not support streaming downloads');
      }
      const stream = await storage.openDownloadStream({ key: storageKey, target });
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let totalLength = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalLength += value.length;
          if (totalLength > maxFileBytes) {
            throw new Error(
              `Processing source exceeds ${maxFileBytes} bytes; increase maxFileBytes or use a streaming-friendly processor.`,
            );
          }
          chunks.push(value);
        }
      }
      const data = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      dataCache = data;
      return data;
    };
  }

  /**
   * How the server writes an object to `target`: streamed through the adapter,
   * or, where the adapter only signs upload URLs (R2, for example), with one
   * PUT to a URL it signs for the exact size and content type.
   */
  function serverUploadMode(target: string): 'stream' | 'signed' {
    const capabilities = getStorageCapabilities(storage, target) as Partial<ReturnType<typeof getStorageCapabilities>> | undefined;
    if (storage.openUploadStream && capabilities?.proxyStreamingUpload) return 'stream';
    if (storage.signUploadUrl && capabilities?.signedUploadUrls) return 'signed';
    // Capabilities not declared: try the stream, as before signed writes existed.
    if (storage.openUploadStream) return 'stream';
    throw errors.storageUploadUnsupported(target);
  }

  /**
   * Writes `body` of exactly `length` bytes through a signed upload URL; a
   * refused PUT throws. A stream is sent as it arrives, with the length it
   * was signed for, so it is never held in memory whole. A PUT still running
   * at `deadline` is aborted.
   */
  async function putSigned(
    object: StoredObject,
    body: Uint8Array | Blob | ReadableStream<Uint8Array>,
    length: number,
    deadline?: number,
  ): Promise<void> {
    const signed = await storage.signUploadUrl!({
      key: object.key,
      target: object.target,
      expiresInSeconds: SIGNED_SERVER_UPLOAD_TTL_SECONDS,
      constraints: { contentType: object.contentType, contentLength: length },
    });
    const headers = new Headers(signed.headers);
    if (!headers.has('content-type')) headers.set('content-type', object.contentType);
    let requestBody = body;
    const init: RequestInit & { duplex?: 'half' } = { method: 'PUT', headers };
    if (deadline !== undefined) {
      if (Date.now() > deadline) throw errors.uploadExpired();
      init.signal = AbortSignal.timeout(deadline - Date.now());
    }
    if (body instanceof ReadableStream) {
      // Workers sends a stream with a Content-Length only through a
      // FixedLengthStream; Node's fetch takes the header itself.
      const FixedLength = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream<Uint8Array, Uint8Array> })
        .FixedLengthStream;
      if (FixedLength) {
        requestBody = body.pipeThrough(new FixedLength(length));
      } else {
        headers.set('content-length', String(length));
      }
      init.duplex = 'half';
    }
    init.body = requestBody as RequestInit['body'];
    // Resolved per call, so a test or runtime may replace the global.
    const response = await globalThis.fetch(signed.url, init);
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      throw new Error(`Storage refused the artifact upload with HTTP ${response.status}`);
    }
  }

  /**
   * Sends a client body to a signed upload URL without buffering it: a byte
   * array or Blob goes as it is, and a stream is piped through as it arrives.
   * A signed PUT is signed for an exact size, so a stream needs its declared
   * length and is refused when it turns out longer or shorter.
   */
  async function putSignedBounded(
    body: NonNullable<ClientArtifactUpload['body']>,
    object: StoredObject,
    kind: string,
    maxBytes: number,
    declaredLength: number | undefined,
    deadline: number,
  ): Promise<number> {
    if (!(body instanceof ReadableStream)) {
      const size = body instanceof Uint8Array ? body.byteLength : body.size;
      if (size > maxBytes) throw errors.artifactTooLarge(kind, maxBytes);
      if (size === 0) throw errors.invalidRequest('Artifact body is empty');
      await putSigned(object, body, size, deadline);
      return size;
    }
    if (declaredLength === undefined) {
      throw errors.invalidRequest('Content-Length is required to upload an artifact to this storage', { target: object.target });
    }
    if (declaredLength > maxBytes) throw errors.artifactTooLarge(kind, maxBytes);
    if (declaredLength === 0) throw errors.invalidRequest('Artifact body is empty');
    let refusal: errors.FileFnError | undefined;
    let seen = 0;
    const lengthMismatch = (relation: 'longer' | 'shorter') => {
      refusal = errors.invalidRequest(`Artifact body is ${relation} than its Content-Length`, { contentLength: declaredLength });
      return refusal;
    };
    const counted = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > declaredLength) throw lengthMismatch('longer');
          controller.enqueue(chunk);
        },
        flush() {
          if (seen < declaredLength) throw lengthMismatch('shorter');
        },
      }),
    );
    try {
      await putSigned(object, counted, declaredLength, deadline);
    } catch (error) {
      throw refusal ?? error;
    }
    if (refusal) throw refusal;
    return declaredLength;
  }

  /** Writes `data` to a new or replaced object. */
  async function writeObject(object: StoredObject, data: Uint8Array): Promise<void> {
    if (serverUploadMode(object.target) === 'signed') {
      await putSigned(object, data, data.byteLength);
      return;
    }
    const writer = (await storage.openUploadStream!(object)).getWriter();
    await writer.write(data);
    await writer.close();
  }

  /** The artifact row for one (file, version, kind), if any. */
  async function findKindRow(fileId: string, versionId: string, kind: string): Promise<FileArtifactRecord | null> {
    return db.findOne<FileArtifactRecord>({
      model: 'fileArtifacts',
      where: [
        { field: 'fileId', operator: 'eq', value: fileId },
        { field: 'versionId', operator: 'eq', value: versionId },
        { field: 'kind', operator: 'eq', value: kind },
      ],
      namespace,
    });
  }

  async function findArtifactRow(artifactId: string): Promise<FileArtifactRecord | null> {
    return db.findOne<FileArtifactRecord>({
      model: 'fileArtifacts',
      where: [{ field: 'artifactId', operator: 'eq', value: artifactId }],
      namespace,
    });
  }

  /**
   * Writes `fields` over `row` only while the row still names the object it
   * named when read, and reports whether it did. A client object's key is
   * unique to one upload attempt, so a row naming the same client key was
   * not written in between; a row naming the same server key may have been
   * rewritten, but only to that same object, which replacement never deletes
   * (see `discardDisplacedObject`), so the object a writer discards is still
   * the one it replaced.
   *
   * A count of zero is not taken as a lost race: some adapters report none
   * for a committed update (the Kysely adapter of `@superfunctions/db` 0.2.0
   * always reports 0, as does Drizzle on postgres-js), so the row read back
   * decides. It was written when it names the new object; a row naming the
   * same server key through another writer holds that same object.
   */
  async function replaceIfUnchanged(
    row: FileArtifactRecord,
    fields: Record<string, unknown> & { storageKey: string },
  ): Promise<boolean> {
    const updated = await db.updateMany({
      model: 'fileArtifacts',
      where: [
        { field: 'artifactId', operator: 'eq', value: row.artifactId },
        { field: 'storageKey', operator: 'eq', value: row.storageKey },
      ],
      data: fields,
      namespace,
    });
    if (updated > 0) return true;
    return (await findArtifactRow(row.artifactId))?.storageKey === fields.storageKey;
  }

  /**
   * Stores a client body in a new object, refusing it once it passes
   * `maxBytes`, when it is empty, or when it is longer or shorter than a
   * declared length, without holding it in memory whole. No read, write or
   * close is started past `deadline`, and none is waited for past it: at the
   * deadline the body is cancelled, the writer aborted and the store refused
   * as expired, none of it waited for. A close that was already under way, or
   * a stream opened late (aborted once it is returned), may still publish the
   * object after that, so `onAbandon` gets, at the deadline itself and before
   * anything else is awaited, a promise that settles once the stream has.
   * The caller has recorded the object before (see `attachClientArtifact`)
   * and deletes whatever a refused or failed upload wrote.
   */
  async function storeBounded(
    body: NonNullable<ClientArtifactUpload['body']>,
    object: StoredObject,
    kind: string,
    maxBytes: number,
    declaredLength: number | undefined,
    deadline: number,
    onAbandon: (settled: Promise<unknown>) => void,
  ): Promise<number> {
    if (serverUploadMode(object.target) === 'signed') {
      return putSignedBounded(body, object, kind, maxBytes, declaredLength, deadline);
    }
    const beforeDeadline = () => {
      if (Date.now() > deadline) throw errors.uploadExpired();
    };
    const input = bodyReader(body);
    // The stream is opened only for a first chunk within the limit, so a body
    // refused at once leaves no object half-created behind.
    let writer: WritableStreamDefaultWriter | null = null;
    let abandoned = false;
    const untilDeadline = async <T>(operation: Promise<T>, releaseLate?: (late: T) => Promise<unknown>): Promise<T> => {
      const expired = Symbol('expired');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        operation,
        new Promise<typeof expired>((resolve) => {
          timer = setTimeout(() => resolve(expired), Math.max(0, deadline - Date.now()));
        }),
      ]).finally(() => clearTimeout(timer));
      if (outcome !== expired) return outcome as T;
      abandoned = true;
      const error = errors.uploadExpired();
      input.cancel(error);
      if (writer) {
        // An abort waits for a write or close under way, so it is not waited for.
        writer.abort(error).catch(() => undefined);
        onAbandon(writer.closed.then(() => undefined, () => undefined));
      } else if (releaseLate) {
        onAbandon(operation.then(releaseLate).then(() => undefined, () => undefined));
      }
      throw error;
    };
    const lengthMismatch = (relation: 'longer' | 'shorter') =>
      errors.invalidRequest(`Artifact body is ${relation} than its Content-Length`, { contentLength: declaredLength });
    try {
      let size = 0;
      beforeDeadline();
      for (let chunk = await untilDeadline(input.read()); chunk; chunk = await untilDeadline(input.read())) {
        size += chunk.byteLength;
        if (declaredLength !== undefined && size > declaredLength) throw lengthMismatch('longer');
        if (size > maxBytes) {
          throw errors.artifactTooLarge(kind, maxBytes);
        }
        beforeDeadline();
        writer ??= (await untilDeadline(
          storage.openUploadStream!(object),
          (late) => late.abort(errors.uploadExpired()),
        )).getWriter();
        beforeDeadline();
        await untilDeadline(writer.write(chunk));
        beforeDeadline();
      }
      if (size === 0) {
        throw errors.invalidRequest('Artifact body is empty');
      }
      if (declaredLength !== undefined && size < declaredLength) throw lengthMismatch('shorter');
      beforeDeadline();
      await untilDeadline(writer!.close());
      return size;
    } catch (error) {
      input.cancel(error);
      const aborted = writer?.abort(error).catch(() => undefined);
      if (!abandoned) await aborted;
      throw error;
    }
  }

  /**
   * Records that `object` belongs to its file version without an artifact row
   * naming it (see `DISPLACED_OBJECT_KIND`), and returns that record's ID. It
   * is written before an artifact row stops naming the object, so an
   * interruption at any point leaves the object findable by cleanup. Writing
   * the same object twice keeps one record. An upload attempt records its own
   * object under a separate `intent` record before writing it, so removing
   * that record once its row names the object never removes the record of a
   * concurrent writer that displaced the object in between.
   */
  async function journalDisplaced(object: DisplacedObject, fallbackTarget: string, purpose?: 'intent'): Promise<string> {
    const target = recordedStorageTarget(object as FileArtifactRecord) ?? fallbackTarget;
    const artifactId = derivedId('dsp', [
      DISPLACED_OBJECT_KIND,
      ...(purpose ? [purpose] : []),
      object.fileId,
      object.versionId,
      target,
      object.storageKey,
    ]);
    try {
      await db.create({
        model: 'fileArtifacts',
        data: {
          artifactId,
          fileId: object.fileId,
          versionId: object.versionId,
          kind: purpose === 'intent' ? UPLOAD_INTENT_KIND : DISPLACED_OBJECT_KIND,
          storageKey: object.storageKey,
          mimeType: 'application/octet-stream',
          size: 0,
          metadata: { processing: { source: artifactSourceOf(object), storageTarget: target } },
          createdAt: new Date().toISOString(),
        },
        namespace,
      });
    } catch (error) {
      if (!(await findArtifactRow(artifactId))) throw error;
    }
    return artifactId;
  }

  /**
   * Deletes a client-supplied object no artifact row names any more, best
   * effort, and then its displaced-object record. A client object's key is
   * unique to one upload attempt, so no row can name it again. A failed
   * delete is logged and keeps the record, so version or file cleanup
   * deletes the object later. A server object is never deleted: its key is
   * the processor's own, which another file's processor (a deduplicated file
   * sharing the version's storage key, say) may publish again between any
   * reference check and a delete, so it stays recorded, and file and version
   * cleanup keep the record, until a reclamation coordinated with those
   * publishers exists. Never throws, so a caller's own error
   * is the one it reports; an object it could not record is still deleted,
   * since no row names it.
   *
   * The record is written again first, even when the caller wrote it, so
   * the object is recorded whenever its delete fails; only a confirmed
   * delete (here, in version cleanup or in `cleanupOrphanedArtifacts`)
   * removes a client object's record.
   */
  async function discardDisplacedObject(object: DisplacedObject, fallbackTarget: string, purpose?: 'intent'): Promise<void> {
    if (artifactSourceOf(object) !== 'client') return;
    const target = recordedStorageTarget(object as FileArtifactRecord) ?? fallbackTarget;
    const id = await journalDisplaced(object, fallbackTarget, purpose).catch(() => undefined);
    try {
      await storage.deleteObject({ key: object.storageKey, target });
      if (id) await removeDisplacedRecord(id);
    } catch (error) {
      logger?.warn('displaced artifact object not deleted', {
        fileId: object.fileId,
        versionId: object.versionId,
        error: errorMessage(error),
      });
    }
  }

  /** Removes a displaced-object record whose object is deleted or named by a row again. */
  async function removeDisplacedRecord(recordId: string): Promise<void> {
    await db.delete({ model: 'fileArtifacts', where: [{ field: 'artifactId', operator: 'eq', value: recordId }], namespace });
  }

  /**
   * After a failed row write, deletes an upload attempt's own object unless
   * the row turns out to name it (a write that committed and still failed).
   * When the row cannot be read the object stays recorded for cleanup.
   */
  async function discardUnlessNamed(object: DisplacedObject, artifactId: string, target: string): Promise<void> {
    let row: FileArtifactRecord | null;
    try {
      row = await findArtifactRow(artifactId);
    } catch {
      await journalDisplaced(object, target, 'intent').catch(() => undefined);
      return;
    }
    if (row?.storageKey === object.storageKey) return;
    await discardDisplacedObject(object, target, 'intent');
  }

  /**
   * Keeps an upload's own record of `object` while a store it gave up on is
   * still under way, renewing it (see `CLIENT_ARTIFACT_HOLD_RENEW_MS`) until
   * `settled`, and then deletes the object. Until then the store may publish
   * the object at any moment, so the record stays whatever else fails. Storage
   * may still finish work it reported settled (a stream's initialization or
   * abort), so the record is renewed once more and kept, and the sweep
   * deletes the object again before it retires the record, once the version
   * is gone and the grace period after that renewal is over. If this process
   * dies, its store dies with it, and the same applies from the last renewal.
   */
  async function holdUntilSettled(object: DisplacedObject, target: string, settled: Promise<unknown>): Promise<void> {
    const renew = async () => {
      try {
        const id = await journalDisplaced(object, target, 'intent');
        await db.updateMany({
          model: 'fileArtifacts',
          where: [{ field: 'artifactId', operator: 'eq', value: id }],
          data: { metadata: { processing: { source: 'client', storageTarget: target, heldAt: new Date().toISOString() } } },
          namespace,
        });
      } catch (error) {
        logger?.warn('client artifact upload record not renewed', { fileId: object.fileId, versionId: object.versionId, error: errorMessage(error) });
      }
    };
    await renew();
    const timer = setInterval(() => void renew(), CLIENT_ARTIFACT_HOLD_RENEW_MS);
    (timer as { unref?: () => void }).unref?.();
    void settled.then(async () => {
      clearInterval(timer);
      await renew();
      await storage.deleteObject({ key: object.storageKey, target }).catch((error: unknown) => {
        logger?.warn('displaced artifact object not deleted', { fileId: object.fileId, versionId: object.versionId, error: errorMessage(error) });
      });
    });
  }

  /**
   * Uploads one artifact and creates or updates its row for (file, version,
   * kind), noting each write in `writes` as it lands. Unless `force` is set,
   * a kind the client supplied keeps the client's artifact and nothing is
   * uploaded for it.
   *
   * The object goes to the processor's own key, as it always has. Each row
   * write is conditional on the row it read (see `replaceIfUnchanged`); when
   * the row changed in between, it is read again and the decision is made
   * afresh. An object the row stops naming, and a server object this run
   * stored but lost to a client artifact, are recorded as displaced (see
   * `journalDisplaced`) so cleanup still finds them; only a client object is
   * deleted at once, since a server key may be shared (see
   * `discardDisplacedObject`).
   */
  async function recordArtifact(
    input: Pick<ProcessorInput, 'fileId' | 'versionId'>,
    artifact: ProcessorOutputArtifact,
    target: string,
    processing: ArtifactProcessingMetadata,
    writes: ProcessingWrites,
    force: boolean,
  ): Promise<void> {
    const keepsClientArtifact = (row: FileArtifactRecord) => !force && artifactSourceOf(row) === 'client';
    const artifactId = artifactIdFor(input.fileId, input.versionId, artifact.kind);
    const { storageKey } = artifact;
    const fields = {
      storageKey,
      mimeType: artifact.mimeType,
      size: artifact.data.length,
      metadata: { ...(artifact.metadata ?? {}), processing },
    };
    let uploaded = false;
    let current = await findKindRow(input.fileId, input.versionId, artifact.kind);
    for (let attempt = 1; ; attempt += 1) {
      if (current && keepsClientArtifact(current)) {
        // The client's artifact stays; nothing of this run is recorded for
        // it, but an object it already stored stays findable by cleanup.
        if (uploaded) {
          await journalDisplaced({ ...input, storageKey, metadata: fields.metadata }, target);
        }
        return;
      }
      if (!uploaded) {
        writes.uploadedKeys.add(storageKey);
        await writeObject({ key: storageKey, target, contentType: artifact.mimeType }, artifact.data);
        uploaded = true;
      }
      if (!current) {
        try {
          await db.create({
            model: 'fileArtifacts',
            data: {
              artifactId,
              fileId: input.fileId,
              versionId: input.versionId,
              kind: artifact.kind,
              ...fields,
              createdAt: new Date().toISOString(),
            },
            namespace,
          });
          writes.artifactsRecorded += 1;
          return;
        } catch (error) {
          // A concurrent delivery or client upload created the same row first.
          current = await findArtifactRow(artifactId);
          if (!current) {
            throw error;
          }
          continue;
        }
      }
      const displaces = current.storageKey !== storageKey;
      if (displaces) {
        await journalDisplaced(current, target);
      }
      if (await replaceIfUnchanged(current, fields)) {
        writes.artifactsRecorded += 1;
        if (displaces) {
          await discardDisplacedObject(current, target);
        }
        return;
      }
      if (attempt >= MAX_ARTIFACT_WRITE_ATTEMPTS) {
        throw errors.artifactWriteConflict(artifact.kind);
      }
      current = await findArtifactRow(current.artifactId);
    }
  }

  /**
   * Records every artifact of one successful processor run. A failed write
   * throws; `writes` still counts the artifacts recorded before it.
   */
  async function recordArtifacts(
    input: Pick<ProcessorInput, 'fileId' | 'versionId'>,
    processor: Processor,
    run: { result?: ProcessorResult; durationMs: number },
    target: string,
    idempotencyKey: string,
    writes: ProcessingWrites,
    force: boolean,
  ): Promise<void> {
    const processing: ArtifactProcessingMetadata = {
      source: 'server',
      processor: processor.name,
      durationMs: run.durationMs,
      idempotencyKey,
      storageTarget: target,
    };
    for (const artifact of run.result?.artifacts ?? []) {
      await recordArtifact(input, artifact, target, processing, writes, force);
    }
  }

  /** The run rows recorded for one file version, by ID. */
  async function findProcessingRuns(fileId: string, versionId: string): Promise<Map<string, FileArtifactRecord>> {
    const runs = await db.findMany<FileArtifactRecord>({
      model: 'fileArtifacts',
      where: [
        { field: 'fileId', operator: 'eq', value: fileId },
        { field: 'versionId', operator: 'eq', value: versionId },
        { field: 'kind', operator: 'eq', value: PROCESSING_RUN_KIND },
      ],
      namespace,
    });
    return new Map(runs.map((run) => [run.artifactId, run]));
  }

  /**
   * Creates one run-kind row. A concurrent delivery may have created the same
   * row first, which counts as recorded.
   */
  async function recordRunRow(
    input: Pick<ProcessorInput, 'fileId' | 'versionId'>,
    artifactId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await db.create({
        model: 'fileArtifacts',
        data: {
          artifactId,
          fileId: input.fileId,
          versionId: input.versionId,
          kind: PROCESSING_RUN_KIND,
          // No object is stored under this key.
          storageKey: `filefn/processing-runs/${artifactId}`,
          mimeType: 'application/json',
          size: 0,
          metadata,
          createdAt: new Date().toISOString(),
        },
        namespace,
      });
    } catch (error) {
      const existing = await db.findOne<FileArtifactRecord>({
        model: 'fileArtifacts',
        where: [{ field: 'artifactId', operator: 'eq', value: artifactId }],
        namespace,
      });
      if (!existing) {
        throw error;
      }
    }
  }

  /**
   * Removes what processing left for a deleted version. Its `fileArtifacts`
   * rows are the cleanup journal: the objects they name go first, unless
   * another row still references the same object (deduplicated files can share
   * storage keys), and the rows go last. A failed reference scan or object
   * delete throws with the rows kept, so the job is retried and its next
   * delivery, which finds the version gone, resumes the cleanup. Objects this
   * delivery uploaded without a row yet are removed best effort.
   */
  async function discardDeletedVersionOutput(
    input: Pick<ProcessorInput, 'fileId' | 'versionId'>,
    writes: ProcessingWrites,
    runTarget?: string,
  ): Promise<void> {
    let rows: FileArtifactRecord[] = [];
    try {
      rows = await db.findMany<FileArtifactRecord>({
        model: 'fileArtifacts',
        where: [
          { field: 'fileId', operator: 'eq', value: input.fileId },
          { field: 'versionId', operator: 'eq', value: input.versionId },
          // An upload may still be writing the object its intent row records.
          { field: 'kind', operator: 'ne', value: UPLOAD_INTENT_KIND },
        ],
        namespace,
      });
      await discardRows(input, rows, writes, runTarget);
    } catch (error) {
      throw new DeletedVersionCleanupError(rows.map((row) => row.artifactId), error);
    }
  }

  async function discardRows(
    input: Pick<ProcessorInput, 'fileId' | 'versionId'>,
    rows: FileArtifactRecord[],
    writes: ProcessingWrites,
    runTarget?: string,
  ): Promise<void> {
    if (rows.length === 0 && writes.uploadedKeys.size === 0) {
      return;
    }
    const file = runTarget === undefined
      ? await db.findOne<FileRecord>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: input.fileId }],
        namespace,
      })
      : null;
    const fallbackTarget = runTarget ?? getArtifactStorageTarget(file ?? { policy: '' });
    // A server object no row names any more is neither deleted nor unrecorded
    // here (see `discardDisplacedObject`): a processor of any file may publish
    // its key again between the reference scan below and a delete.
    const displacedServer = (row: FileArtifactRecord) => row.kind === DISPLACED_OBJECT_KIND && artifactSourceOf(row) !== 'client';
    const journaled = new Set<string>();
    const keptRefs = new Set<string>();
    for (const row of rows) {
      if (row.kind !== PROCESSING_RUN_KIND) {
        (displacedServer(row) ? keptRefs : journaled).add(storageRef(recordedStorageTarget(row) ?? fallbackTarget, row.storageKey));
      }
    }
    const unjournaled = new Set(
      [...writes.uploadedKeys].map((key) => storageRef(fallbackTarget, key)).filter((ref) => !journaled.has(ref) && !keptRefs.has(ref)),
    );
    // Only this version's rows are excluded: another version may share a key.
    const referenced = await findReferencedStorageRefs(
      { db, namespace, policies },
      new Set([...journaled, ...unjournaled]),
      input,
    );
    for (const ref of journaled) {
      if (!referenced.has(ref)) {
        await storage.deleteObject(parseStorageRef(ref));
      }
    }
    for (const ref of unjournaled) {
      if (!referenced.has(ref)) {
        try {
          await storage.deleteObject(parseStorageRef(ref));
        } catch {
          // Best effort: the upload may never have completed.
        }
      }
    }
    // Only the rows listed above: a row written since then names an object
    // this cleanup has not considered, so it stays for the next cleanup.
    for (const row of rows.filter((candidate) => !displacedServer(candidate))) {
      await db.delete({
        model: 'fileArtifacts',
        where: [{ field: 'artifactId', operator: 'eq', value: row.artifactId }],
        namespace,
      });
    }
  }

  /** Kinds the client supplied for one file version. */
  async function findClientSuppliedKinds(fileId: string, versionId: string): Promise<Set<string>> {
    const rows = await db.findMany<FileArtifactRecord>({
      model: 'fileArtifacts',
      where: [
        { field: 'fileId', operator: 'eq', value: fileId },
        { field: 'versionId', operator: 'eq', value: versionId },
      ],
      namespace,
    });
    return new Set(
      rows
        .filter((row) => !isInternalKind(row.kind) && artifactSourceOf(row) === 'client')
        .map((row) => row.kind),
    );
  }

  /** The IDs of the versions of `records` whose version and file still exist. */
  async function findLiveVersionIds(records: FileArtifactRecord[]): Promise<Set<string>> {
    if (records.length === 0) return new Set();
    const versions = await db.findMany<FileVersionRecord>({
      model: 'fileVersions',
      where: [{ field: 'versionId', operator: 'in', value: [...new Set(records.map((record) => record.versionId))] }],
      namespace,
    });
    const files = versions.length === 0 ? [] : await db.findMany<FileRecord>({
      model: 'files',
      where: [{ field: 'fileId', operator: 'in', value: [...new Set(versions.map((version) => version.fileId))] }],
      namespace,
    });
    const fileIds = new Set(files.map((file) => file.fileId));
    const fileOfRecord = new Map(records.map((record) => [record.versionId, record.fileId]));
    return new Set(versions
      .filter((version) => fileIds.has(version.fileId) && fileOfRecord.get(version.versionId) === version.fileId)
      .map((version) => version.versionId));
  }

  async function findVersion(fileId: string, versionId: string): Promise<{ file: FileRecord; version: FileVersionRecord } | null> {
    const version = await db.findOne<FileVersionRecord>({
      model: 'fileVersions',
      where: [{ field: 'versionId', operator: 'eq', value: versionId }],
      namespace,
    });
    if (!version || version.fileId !== fileId) {
      return null;
    }
    const file = await db.findOne<FileRecord>({
      model: 'files',
      where: [{ field: 'fileId', operator: 'eq', value: fileId }],
      namespace,
    });
    return file ? { file, version } : null;
  }

  async function processValidJob(
    job: NonNullable<ReturnType<typeof parseProcessingJob>>,
    delivery: ProcessingJobDelivery,
  ): Promise<ProcessingJobOutcome> {
    const found = await findVersion(job.fileId, job.versionId);
    if (!found) {
      // An earlier delivery may have written rows before it saw the delete.
      await discardDeletedVersionOutput(job, emptyWrites());
      return { status: 'dropped', reason: 'version-deleted' };
    }
    const { file, version } = found;
    // The database, not the queued body, is the source of the file details.
    const input: ProcessorInput = {
      fileId: file.fileId,
      versionId: version.versionId,
      storageKey: version.storageKey,
      mimeType: version.mimeType,
      size: version.size,
      fileName: file.name,
      tenantId: file.tenantId ?? undefined,
    };
    const force = job.force === true;
    const idempotencyKey = job.idempotencyKey
      ?? buildProcessingIdempotencyKey(input.fileId, input.versionId, processors, force);
    // Read the configured list per job, as the producer and runProcessing do:
    // processors may be added to it after the FileFn instance is created.
    const supported = processorEntriesFor(processors).filter((entry) => supportsProcessor(entry.processor, input.mimeType));
    if (supported.length === 0) {
      // As runProcessing does, a version no processor applies to completes without an event.
      return { status: 'completed', artifactsCreated: 0, skippedProcessors: [] };
    }
    const clientKinds = force ? new Set<string>() : await findClientSuppliedKinds(input.fileId, input.versionId);
    const applicable = excludeClientCovered(supported, (entry) => entry.processor, clientKinds, force);

    const recordedRuns = await findProcessingRuns(input.fileId, input.versionId);
    const runIdFor = (entry: ProcessorEntry) =>
      processingRunIdFor(input.fileId, input.versionId, idempotencyKey, entry.instance);
    const completionId = processingCompletionIdFor(input.fileId, input.versionId, idempotencyKey);
    const pending = applicable.filter((entry) => !recordedRuns.has(runIdFor(entry)));
    const skipped = applicable.filter((entry) => recordedRuns.has(runIdFor(entry)));
    if (pending.length === 0 && recordedRuns.has(completionId)) {
      return { status: 'duplicate' };
    }

    const getData = createSourceReader(input.storageKey, getFileStorageTarget(file));
    const artifactStorageTarget = getArtifactStorageTarget(file);
    const processingErrors: string[] = [];
    const writes = emptyWrites();
    const startedAt = Date.now();
    const dropDeletedVersion = async (): Promise<ProcessingJobOutcome> => {
      await discardDeletedVersionOutput(input, writes, artifactStorageTarget);
      return { status: 'dropped', reason: 'version-deleted' };
    };

    for (const entry of pending) {
      const run = await executeProcessor(entry.processor, input, getData);
      // The version may have been deleted while the processor ran; its source
      // read then fails too, which is not a failure worth retrying.
      if (!(await findVersion(input.fileId, input.versionId))) {
        return dropDeletedVersion();
      }
      if (!run.result) {
        processingErrors.push(`${entry.label}: ${run.error ?? 'processor reported failure'}`);
        continue;
      }
      const recordedBefore = writes.artifactsRecorded;
      try {
        await recordArtifacts(input, entry.processor, run, artifactStorageTarget, idempotencyKey, writes, force);
        await recordRunRow(input, runIdFor(entry), {
          processingRun: {
            ...entry.instance,
            idempotencyKey,
            durationMs: run.durationMs,
            artifactCount: writes.artifactsRecorded - recordedBefore,
          },
        });
      } catch (error) {
        processingErrors.push(`${entry.label}: ${errorMessage(error)}`);
      }
    }

    // A delete that ran during an upload or row write would leave this run's
    // rows and objects behind for a version that no longer exists.
    if (!(await findVersion(input.fileId, input.versionId))) {
      return dropDeletedVersion();
    }

    if (processingErrors.length > 0) {
      return { status: 'retry', errors: processingErrors };
    }

    // Every processor has its run recorded; report the job's whole output,
    // including the processors earlier deliveries ran.
    const artifactsCreated = skipped.reduce(
      (total, entry) => total + recordedArtifactCount(recordedRuns.get(runIdFor(entry))),
      writes.artifactsRecorded,
    );
    emitIsolated(events, logger, 'processing.completed', {
      requestId: job.requestId,
      fileId: input.fileId,
      versionId: input.versionId,
      artifactsCreated,
    });
    recordProcessingDuration(metrics, Date.now() - startedAt, true);
    // Recorded only after the event, so a delivery that fails before this
    // point leaves the job to notify on its next delivery.
    try {
      await recordRunRow(input, completionId, { processingCompleted: { idempotencyKey, artifactsCreated } });
    } catch (error) {
      // The event went out; a later delivery of this job may emit it again.
      logger?.warn('processing job completion not recorded', {
        requestId: job.requestId,
        fileId: input.fileId,
        versionId: input.versionId,
        error: errorMessage(error),
      });
    }
    // A delete whose artifact listing ran before the completion row was
    // written would leave that row behind.
    let versionAfterCompletion: Awaited<ReturnType<typeof findVersion>>;
    try {
      versionAfterCompletion = await findVersion(input.fileId, input.versionId);
    } catch (error) {
      // A redelivery checks again (and finds the job a duplicate otherwise);
      // the last delivery must not report a failure after processing.completed.
      if (!delivery.finalAttempt) throw error;
      logger?.warn('processing job version check after completion failed', {
        requestId: job.requestId,
        fileId: input.fileId,
        versionId: input.versionId,
        error: errorMessage(error),
      });
      versionAfterCompletion = found;
    }
    if (!versionAfterCompletion) {
      return dropDeletedVersion();
    }
    return { status: 'completed', artifactsCreated, skippedProcessors: skipped.map((entry) => entry.instance) };
  }

  return {
    isEnabled(): boolean {
      return enabled && processors.length > 0;
    },

    async triggerProcessing(
      input: {
        fileId: string;
        versionId: string;
        storageKey: string;
        mimeType: string;
        size: number;
        fileName: string;
        tenantId?: string;
        /** Replace client-supplied artifacts too; the caller checks the principal may write the file. */
        force?: boolean;
      },
      ctx: FileProviderContext
    ): Promise<{ enqueued: boolean; jobId?: string }> {
      if (!enabled || processors.length === 0) {
        return { enqueued: false };
      }

      emitIsolated(events, logger, 'processing.started', {
        requestId: ctx.requestId,
        fileId: input.fileId,
        versionId: input.versionId,
      });

      if (flowFn) {
        const queue = flowFn.getQueue(QUEUE_NAME);
        if (queue) {
          try {
            const result = await queue.add({
              fileId: input.fileId,
              versionId: input.versionId,
              storageKey: input.storageKey,
              mimeType: input.mimeType,
              size: input.size,
              fileName: input.fileName,
              tenantId: input.tenantId,
              idempotencyKey: buildProcessingIdempotencyKey(input.fileId, input.versionId, processors, input.force === true),
              requestId: optionalJobField(ctx.requestId),
              ...(input.force === true ? { force: true } : {}),
            } satisfies ProcessingJob);
            return { enqueued: true, jobId: result.jobId };
          } catch {
            throw errors.processingEnqueueFailed();
          }
        }
      }

      background.schedule(async () => {
        try {
          await this.runProcessing(input, ctx, { force: input.force === true });
        } catch (error) {
          logger?.error('processing failed', {
            requestId: ctx.requestId,
            fileId: input.fileId,
            versionId: input.versionId,
            error: error instanceof Error ? error.stack ?? error.message : String(error),
          });
          emitIsolated(events, logger, 'processing.failed', {
            requestId: ctx.requestId,
            fileId: input.fileId,
            versionId: input.versionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      return { enqueued: false };
    },

    async runProcessing(
      input: ProcessorInput,
      ctx: FileProviderContext,
      options: { force?: boolean } = {},
    ): Promise<{ artifactsCreated: number; errors: string[] }> {
      const force = options.force === true;
      const supportedProcessors = processors.filter((p) =>
        supportsProcessor(p, input.mimeType)
      );

      if (supportedProcessors.length === 0) {
        return { artifactsCreated: 0, errors: [] };
      }
      const clientKinds = force ? new Set<string>() : await findClientSuppliedKinds(input.fileId, input.versionId);
      const applicableProcessors = excludeClientCovered(supportedProcessors, (p) => p, clientKinds, force);

      const file = await db.findOne<FileRecord>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: input.fileId }],
        namespace,
      });
      const policyRef = file ?? { policy: '' };
      const getData = createSourceReader(input.storageKey, getFileStorageTarget(policyRef));
      const artifactStorageTarget = getArtifactStorageTarget(policyRef);
      const idempotencyKey = buildProcessingIdempotencyKey(input.fileId, input.versionId, processors, force);

      const processingErrors: string[] = [];
      let artifactsCreated = 0;
      const startedAt = Date.now();

      for (const processor of applicableProcessors) {
        const run = await executeProcessor(processor, input, getData);
        if (!run.result) {
          processingErrors.push(`${processor.name}: ${run.error || 'processor reported failure'}`);
          continue;
        }
        const writes = emptyWrites();
        try {
          await recordArtifacts(input, processor, run, artifactStorageTarget, idempotencyKey, writes, force);
        } catch (error) {
          processingErrors.push(`${processor.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
        // Artifacts written before a failed write still count, as they did before.
        artifactsCreated += writes.artifactsRecorded;
      }

      emitIsolated(events, logger, 'processing.completed', {
        requestId: ctx.requestId,
        fileId: input.fileId,
        versionId: input.versionId,
        artifactsCreated,
      });
      recordProcessingDuration(metrics, Date.now() - startedAt, processingErrors.length === 0);

      return { artifactsCreated, errors: processingErrors };
    },

    /**
     * Runs one queued processing job: the processors that apply to the job's
     * file version and have no run recorded for the job's idempotency key.
     * Never throws; the outcome tells the queue consumer whether to
     * acknowledge or redeliver the message.
     */
    async processJob(body: unknown, delivery: ProcessingJobDelivery): Promise<ProcessingJobOutcome> {
      const job = parseProcessingJob(body);
      if (!job) {
        logger?.warn('processing job dropped: invalid job body', { attempts: delivery.attempts });
        return { status: 'dropped', reason: 'invalid-job' };
      }
      const logContext = {
        requestId: job.requestId,
        jobId: job.jobId,
        fileId: job.fileId,
        versionId: job.versionId,
        attempts: delivery.attempts,
      };

      let outcome: ProcessingJobOutcome;
      try {
        outcome = await processValidJob(job, delivery);
      } catch (error) {
        if (!(error instanceof DeletedVersionCleanupError)) {
          outcome = { status: 'retry', errors: [errorMessage(error)] };
        } else if (!delivery.finalAttempt) {
          logger?.warn('processing job will be retried to finish cleanup of a deleted version', {
            ...logContext,
            error: error.message,
          });
          return { status: 'retry', errors: [error.message] };
        } else {
          // Never `processing.failed`: the version is gone, so the job is
          // dropped. No further delivery resumes the cleanup.
          logger?.error('processing job dropped: deleted version cleanup not finished; rows kept', {
            ...logContext,
            keptArtifactIds: error.keptArtifactIds,
            error: error.message,
          });
          return { status: 'dropped', reason: 'version-deleted' };
        }
      }

      if (outcome.status === 'dropped') {
        logger?.info('processing job dropped: file version deleted', logContext);
        return outcome;
      }
      if (outcome.status !== 'retry') {
        return outcome;
      }
      if (!delivery.finalAttempt) {
        logger?.warn('processing job will be retried', { ...logContext, errors: outcome.errors });
        return outcome;
      }

      logger?.error('processing job failed after its last attempt', { ...logContext, errors: outcome.errors });
      emitIsolated(events, logger, 'processing.failed', {
        requestId: job.requestId,
        fileId: job.fileId,
        versionId: job.versionId,
        error: outcome.errors.join('; '),
      });
      return { status: 'failed', errors: outcome.errors };
    },

    /**
     * Records an artifact the client produced on the device for one file
     * version, under the same (file, version, kind) row a server processor
     * would write, so both resolve the same way. Only the file's owner or a
     * writer may attach one, and only a kind, content type and size the
     * file's policy allows. The body goes to a key of its own for each
     * attempt and the row is switched to it only once fully stored, so a
     * retried or interrupted upload never leaves the row naming a partial
     * object; a client object the row named before is then deleted, and a
     * server one stays recorded for cleanup (see `discardDisplacedObject`). On storage that only signs
     * upload URLs a streamed body needs its Content-Length.
     */
    async attachClientArtifact(upload: ClientArtifactUpload, ctx: FileProviderContext): Promise<FileArtifactRecord> {
      const file = await requireWritableFile(upload.fileId, ctx);
      const version = await getVersionChecked(upload.fileId, upload.versionId);
      const rule = clientArtifactRule(upload.kind, policies?.get(file.policy), maxFileBytes);
      if (!rule) {
        throw errors.artifactKindNotAllowed(upload.kind, [...CLIENT_ARTIFACT_KINDS]);
      }
      const mimeType = normalizeMimeType(upload.mimeType);
      if (!rule.mimeTypes.includes(mimeType)) {
        throw errors.artifactTypeNotAllowed(upload.kind, mimeType, rule.mimeTypes);
      }
      const { durationMs } = upload;
      if (
        durationMs !== undefined &&
        !(Number.isInteger(durationMs) && durationMs >= 0 && durationMs <= MAX_CLIENT_PROCESSING_DURATION_MS)
      ) {
        throw errors.invalidRequest(
          `durationMs must be an integer from 0 to ${MAX_CLIENT_PROCESSING_DURATION_MS}`,
          { durationMs },
        );
      }
      // A Blob is refused by its size before any of it is read.
      const declaredSize = upload.contentLength ?? (typeof Blob !== 'undefined' && upload.body instanceof Blob ? upload.body.size : undefined);
      if (declaredSize !== undefined && declaredSize > rule.maxSizeBytes) {
        throw errors.artifactTooLarge(upload.kind, rule.maxSizeBytes);
      }
      if (upload.contentLength === 0 || !upload.body) {
        throw errors.invalidRequest('Artifact body is empty');
      }

      const target = getArtifactStorageTarget(file);
      serverUploadMode(target);
      const storageKey = `${version.storageKey}.client-artifacts/${upload.kind}/${randomUUID()}`;
      const ownObject = { fileId: file.fileId, versionId: version.versionId, storageKey, metadata: { processing: { source: 'client' } } };
      // Taken before the record is written, so the record's age bounds the
      // upload's own (see `UPLOAD_INTENT_KIND`).
      const deadline = Date.now() + CLIENT_ARTIFACT_UPLOAD_MS;
      // Recorded before anything is written, so an object a failed or
      // interrupted attempt leaves behind stays findable by cleanup.
      const intentId = await journalDisplaced(ownObject, target, 'intent');
      let size: number;
      // A store given up on at the deadline is held from that moment on,
      // whatever unwinding the upload still has to do.
      let held: Promise<void> | undefined;
      try {
        size = await storeBounded(
          upload.body,
          { key: storageKey, target, contentType: mimeType },
          upload.kind,
          rule.maxSizeBytes,
          upload.contentLength,
          deadline,
          (settled) => { held = holdUntilSettled(ownObject, target, settled); },
        );
      } catch (error) {
        if (held) {
          await held;
        } else {
          await discardDisplacedObject(ownObject, target, 'intent');
        }
        throw error;
      }

      const processing: ClientArtifactProcessingMetadata = {
        source: 'client',
        ...(durationMs !== undefined ? { durationMs } : {}),
        storageTarget: target,
      };
      const fields = { storageKey, mimeType, size, metadata: { processing } };
      const artifactId = artifactIdFor(file.fileId, version.versionId, upload.kind);
      // A client artifact replaces whatever the row holds, but conditionally on
      // the row it read, so the object it discards is the one it replaced.
      let replaced: FileArtifactRecord | null = null;
      let rowId = artifactId;
      try {
        // Past its lifetime a sweep may have retired this attempt's record.
        if (Date.now() > deadline) throw errors.uploadExpired();
        let current = await findKindRow(file.fileId, version.versionId, upload.kind);
        if (!current) {
          try {
            await db.create({
              model: 'fileArtifacts',
              data: {
                artifactId,
                fileId: file.fileId,
                versionId: version.versionId,
                kind: upload.kind,
                ...fields,
                createdAt: new Date().toISOString(),
              },
              namespace,
            });
          } catch (error) {
            // A concurrent upload or processing run created the row first,
            // or this create committed and still failed. A failed re-read
            // reports the create's own error.
            current = await findArtifactRow(artifactId).catch(() => null);
            if (!current) throw error;
          }
        }
        rowId = current?.artifactId ?? artifactId;
        // A row already naming this attempt's object means the write committed.
        if (current && current.storageKey !== storageKey) {
          // The row's object stays findable by cleanup once the row moves off it.
          await journalDisplaced(current, target);
          // A replace that is not confirmed is not tried again with this
          // attempt's key: had it committed, a writer that replaced it since
          // may have deleted this attempt's object already.
          if (!(await replaceIfUnchanged(current, fields))) {
            throw errors.artifactWriteConflict(upload.kind);
          }
          replaced = current;
        }
      } catch (error) {
        await discardUnlessNamed(ownObject, rowId, target);
        throw error;
      }
      if (replaced) {
        await discardDisplacedObject(replaced, target);
      }

      // A delete of the version while the body was stored would leave this
      // row and object behind for a version that no longer exists.
      if (!(await findVersion(file.fileId, version.versionId))) {
        await db.delete({ model: 'fileArtifacts', where: [{ field: 'artifactId', operator: 'eq', value: rowId }], namespace });
        await discardDisplacedObject(ownObject, target, 'intent');
        throw errors.notFound('Version');
      }

      const recorded = await findArtifactRow(rowId);
      if (!recorded) {
        // Deleted since it was written; the object is no longer named by any row.
        await discardDisplacedObject(ownObject, target, 'intent');
        throw errors.notFound('Artifact');
      }
      // The row named this object once; whichever write replaces it records
      // and discards it, so this attempt's own record is no longer needed. A
      // record left by a failed removal names an object a row names or a
      // later writer discards, so cleanup still handles it.
      await removeDisplacedRecord(intentId).catch((error: unknown) => {
        logger?.warn('client artifact upload record not removed', {
          fileId: file.fileId,
          versionId: version.versionId,
          error: errorMessage(error),
        });
      });
      logger?.info('client artifact attached', {
        requestId: ctx.requestId,
        fileId: file.fileId,
        versionId: version.versionId,
        kind: upload.kind,
        size,
      });
      return recorded;
    },

    /**
     * Deletes the client objects of versions that are gone, and retires the
     * records that kept them (see `DISPLACED_OBJECT_KIND`,
     * `UPLOAD_INTENT_KIND`), each only after its delete is confirmed: every
     * displaced object, and the object of an upload once its lifetime and a
     * grace period after the record's last renewal are over. A client
     * object's key is unique to its upload, so nothing else can name or
     * write it, and a row of a version that is gone is never served. A server
     * key's record is left alone, as everywhere else (see
     * `discardDisplacedObject`): a processor of another file may publish the
     * same key at any moment, so this sweep never deletes it. A
     * failed delete keeps its record for the next run. `deletedObjects`
     * counts confirmed deletes. Call it from a scheduled job; FileFn does
     * not run it on its own.
     */
    async cleanupOrphanedArtifacts(): Promise<{ deletedObjects: number; keptRecords: number }> {
      const pageSize = 100;
      const result = { deletedObjects: 0, keptRecords: 0 };
      const expiredBefore = Date.now() - CLIENT_ARTIFACT_UPLOAD_MS - CLIENT_ARTIFACT_RECORD_GRACE_MS;
      // Records left in place are skipped by the offset; retired ones shift the next page up.
      let offset = 0;
      for (;;) {
        const records = await db.findMany<FileArtifactRecord>({
          model: 'fileArtifacts',
          where: [{ field: 'kind', operator: 'in', value: [DISPLACED_OBJECT_KIND, UPLOAD_INTENT_KIND] }],
          orderBy: [{ field: 'artifactId', direction: 'asc' }],
          limit: pageSize,
          offset,
          namespace,
        });
        const live = await findLiveVersionIds(records);
        // An upload renews the record while a store it gave up on may still publish.
        const expired = (record: FileArtifactRecord) => {
          const heldAt = (record.metadata?.processing as { heldAt?: unknown } | undefined)?.heldAt;
          const since = Math.max(new Date(record.createdAt).getTime(), typeof heldAt === 'string' ? new Date(heldAt).getTime() : 0);
          return record.kind === UPLOAD_INTENT_KIND && since < expiredBefore;
        };
        for (const record of records) {
          const intent = record.kind === UPLOAD_INTENT_KIND;
          const due = artifactSourceOf(record) === 'client' && !live.has(record.versionId) && (!intent || expired(record));
          if (!due) {
            offset += 1;
            continue;
          }
          try {
            const target = recordedStorageTarget(record) ?? getArtifactStorageTarget({ policy: '' });
            await storage.deleteObject({ key: record.storageKey, target });
            result.deletedObjects += 1;
            await removeDisplacedRecord(record.artifactId);
          } catch (error) {
            offset += 1;
            result.keptRecords += 1;
            logger?.warn('orphaned artifact object not deleted', {
              fileId: record.fileId,
              versionId: record.versionId,
              error: errorMessage(error),
            });
          }
        }
        if (records.length < pageSize) return result;
      }
    },

    async requireWritableFile(fileId: string, ctx: FileProviderContext): Promise<void> {
      await requireWritableFile(fileId, ctx);
    },

    /** The file and a version of it, when the principal may write the file. */
    async getWritableVersionForFile(
      fileId: string,
      ctx: FileProviderContext,
      versionId?: string,
    ): Promise<{ file: FileRecord; version: FileVersionRecord }> {
      const file = await requireWritableFile(fileId, ctx);
      const version = await getVersionChecked(fileId, versionId || file.currentVersionId);
      return { file, version };
    },

    async listArtifacts(
      fileId: string,
      ctx: FileProviderContext,
      page?: { limit?: number; offset?: number },
    ): Promise<FileArtifactRecord[]> {
      // With a read check configured, this entry point is authorized too.
      if (readChecker) {
        await requireReadableFile(fileId, ctx);
      }
      return queryArtifacts(fileId, page);
    },

    async listArtifactsForFile(
      fileId: string,
      ctx: FileProviderContext,
      page?: { limit?: number; offset?: number },
    ): Promise<FileArtifactRecord[]> {
      // Authorized exactly once.
      await requireReadableFile(fileId, ctx);
      return queryArtifacts(fileId, page);
    },


    async getArtifactDownloadUrl(
      artifactId: string,
      ctx: FileProviderContext
    ): Promise<{ url: string; headers?: Record<string, string> }> {
      const artifact = await db.findOne<FileArtifactRecord>({
        model: 'fileArtifacts',
        where: [{ field: 'artifactId', operator: 'eq', value: artifactId }],
        namespace,
      });

      if (!artifact || isInternalKind(artifact.kind)) {
        throw errors.notFound('Artifact');
      }

      const file = await db.findOne<FileRecord>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: artifact.fileId }],
        namespace,
      });
      if (!file) {
        // An orphaned artifact has no parent file to authorize against: fail
        // closed in every configuration, with or without a readChecker.
        throw errors.notFound('Artifact');
      }
      await requireReadableFile(file.fileId, ctx);
      const artifactStorageTarget = getArtifactStorageTarget(file);

      if (getStorageCapabilities(storage, artifactStorageTarget).signedDownloadUrls && storage.signDownloadUrl) {
        const result = await storage.signDownloadUrl({
          key: artifact.storageKey,
          target: artifactStorageTarget,
          expiresInSeconds: 900,
          ...signedDownloadConstraints(artifact.mimeType),
        });
        return { url: result.url, headers: result.headers };
      }

      return { url: `/proxy/files/${artifact.fileId}/artifacts/${artifact.artifactId}/download` };
    },

    async getArtifactDownloadUrlForFile(
      fileId: string,
      artifactId: string,
      ctx: FileProviderContext,
    ): Promise<{ url: string; headers?: Record<string, string> }> {
      await requireReadableFile(fileId, ctx);
      const artifact = await getBoundArtifact(fileId, artifactId);
      const file = await db.findOne<FileRecord>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });
      const artifactStorageTarget = getArtifactStorageTarget(file ?? { policy: '' });

      if (getStorageCapabilities(storage, artifactStorageTarget).signedDownloadUrls && storage.signDownloadUrl) {
        const result = await storage.signDownloadUrl({
          key: artifact.storageKey,
          target: artifactStorageTarget,
          expiresInSeconds: 900,
          ...signedDownloadConstraints(artifact.mimeType),
        });
        return { url: result.url, headers: result.headers };
      }

      return { url: `/proxy/files/${fileId}/artifacts/${artifactId}/download` };
    },

    async getArtifactDownloadStreamForFile(
      fileId: string,
      artifactId: string,
      ctx: FileProviderContext,
    ): Promise<{ stream: ReadableStream; contentType: string; size: number; fileName: string }> {
      await requireReadableFile(fileId, ctx);
      const artifact = await getBoundArtifact(fileId, artifactId);

      if (!storage.openDownloadStream) {
        throw new Error('Storage adapter does not support streaming');
      }

      const file = await db.findOne<FileRecord>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });
      const artifactStorageTarget = getArtifactStorageTarget(file ?? { policy: '' });
      const stream = await storage.openDownloadStream({ key: artifact.storageKey, target: artifactStorageTarget });
      return {
        stream: stream as unknown as ReadableStream,
        contentType: artifact.mimeType,
        size: artifact.size,
        // A download name for the attachment: the kind plus the stored key's extension.
        fileName: `${artifact.kind}${/\.[A-Za-z0-9]{1,10}$/.exec(artifact.storageKey.split('/').pop() ?? '')?.[0] ?? ''}`,
      };
    },

    async getReadableVersionForFile(
      fileId: string,
      ctx: FileProviderContext,
      versionId?: string,
    ) {
      return getReadableVersionForFile(fileId, ctx, versionId);
    },
  };
}

export type ProcessingService = ReturnType<typeof createProcessingService>;

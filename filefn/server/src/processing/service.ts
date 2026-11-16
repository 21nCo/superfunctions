import { createHash, randomUUID } from 'node:crypto';
import type { Adapter } from '@superfunctions/db';
import { getStorageCapabilities, type StorageAdapter } from '@superfunctions/storage';
import type { FileProviderContext } from '@superfunctions/files';
import type { FileFnEventEmitter } from '../events.js';
import { resolveArtifactStorageTarget, resolveStorageTarget, type PolicyRegistry } from '../policies.js';
import type { Logger } from '../observability/logger.js';
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
}

/** A client-supplied artifact for one file version. */
export interface ClientArtifactUpload {
  fileId: string;
  versionId: string;
  kind: string;
  /** Content-Type of the body. */
  mimeType: string;
  body: ReadableStream<Uint8Array> | Uint8Array | Blob | null | undefined;
  /** Declared body length, checked before any byte is stored. */
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
function recordedStorageTarget(row: FileArtifactRecord): string | undefined {
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
    if (kind === PROCESSING_RUN_KIND) return `processor emitted the reserved artifact kind ${PROCESSING_RUN_KIND}`;
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

function isGrantExpired(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) {
    return false;
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    return false;
  }
  return expiresAtMs <= Date.now();
}

/** The chunks of a client artifact body; a stream left early is cancelled. */
async function* bodyChunks(body: ReadableStream<Uint8Array> | Uint8Array | Blob): AsyncGenerator<Uint8Array> {
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    yield new Uint8Array(await body.arrayBuffer());
    return;
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      if (value && value.byteLength > 0) {
        yield value instanceof Uint8Array ? value : new Uint8Array(value);
      }
    }
  } finally {
    if (!finished) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
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
    namespace = 'filefn',
    enabled = true,
    maxFileBytes = 50 * 1024 * 1024,
    writeChecker,
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
    if (file.ownerId === ctx.principalId) return true;
    if (file.visibility === 'shared' && file.tenantId && file.tenantId === ctx.tenantId) return true;
    return false;
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

  /** The file, when the principal may read and write it: its owner or a writer. */
  async function requireWritableFile(fileId: string, ctx: FileProviderContext): Promise<FileRecord> {
    const file = await requireReadableFile(fileId, ctx);
    const canWrite = writeChecker
      ? await writeChecker.canWriteFile(fileId, ctx)
      : Boolean(ctx.principalId) && file.ownerId === ctx.principalId;
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

    if (!artifact || artifact.kind === PROCESSING_RUN_KIND) {
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
   * Opens a server-side upload to `object.target`, or refuses with a typed
   * error when that target cannot take one (the R2 adapter, for example, only
   * signs URLs for the client to upload to directly).
   */
  async function openServerUpload(object: { key: string; target: string; contentType: string }): Promise<WritableStream> {
    if (!storage.openUploadStream || !getStorageCapabilities(storage, object.target).proxyStreamingUpload) {
      throw errors.storageUploadUnsupported(object.target);
    }
    return storage.openUploadStream(object);
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
   * named when read, and reports whether it did. Every write gives the row a
   * new storage key or the same server key, and a client object's key is
   * unique to one upload attempt, so an unchanged key means no client
   * artifact landed in between.
   */
  async function replaceIfUnchanged(row: FileArtifactRecord, fields: Record<string, unknown>): Promise<boolean> {
    const updated = await db.updateMany({
      model: 'fileArtifacts',
      where: [
        { field: 'artifactId', operator: 'eq', value: row.artifactId },
        { field: 'storageKey', operator: 'eq', value: row.storageKey },
      ],
      data: fields,
      namespace,
    });
    return updated > 0;
  }

  /**
   * Streams a client body into a new object, refusing it once it passes
   * `maxBytes` or when it is empty. A refused or failed upload deletes what
   * it wrote, best effort, and nothing records the object.
   */
  async function storeBounded(
    body: NonNullable<ClientArtifactUpload['body']>,
    object: { key: string; target: string; contentType: string },
    kind: string,
    maxBytes: number,
  ): Promise<number> {
    const stream = await openServerUpload(object);
    const writer = stream.getWriter();
    let size = 0;
    try {
      for await (const chunk of bodyChunks(body)) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          throw errors.artifactTooLarge(kind, maxBytes);
        }
        await writer.write(chunk);
      }
      if (size === 0) {
        throw errors.invalidRequest('Artifact body is empty');
      }
      await writer.close();
      return size;
    } catch (error) {
      await writer.abort(error).catch(() => undefined);
      try {
        await storage.deleteObject({ key: object.key, target: object.target });
      } catch {
        // Best effort: the object may never have been created.
      }
      throw error;
    }
  }

  /**
   * Deletes an artifact object no row needs any more, best effort: a failure
   * is logged and leaves the object behind. A client-supplied object's key is
   * unique to its row, so only a server object needs the reference scan
   * (deduplicated files can share storage keys).
   */
  async function discardReplacedObject(
    replaced: Pick<FileArtifactRecord, 'fileId' | 'versionId' | 'storageKey' | 'metadata'>,
    fallbackTarget: string,
  ): Promise<void> {
    const ref = storageRef(recordedStorageTarget(replaced as FileArtifactRecord) ?? fallbackTarget, replaced.storageKey);
    try {
      if (artifactSourceOf(replaced) !== 'client') {
        const referenced = await findReferencedStorageRefs({ db, namespace, policies }, new Set([ref]));
        if (referenced.has(ref)) return;
      }
      await storage.deleteObject(parseStorageRef(ref));
    } catch (error) {
      logger?.warn('replaced artifact object not deleted', {
        fileId: replaced.fileId,
        versionId: replaced.versionId,
        error: errorMessage(error),
      });
    }
  }

  /**
   * Uploads one artifact and creates or updates its row for (file, version,
   * kind), noting each write in `writes` as it lands. Unless `force` is set,
   * a kind the client supplied keeps the client's artifact and nothing is
   * uploaded for it.
   */
  async function recordArtifact(
    input: Pick<ProcessorInput, 'fileId' | 'versionId'>,
    artifact: ProcessorOutputArtifact,
    target: string,
    processing: ArtifactProcessingMetadata,
    writes: ProcessingWrites,
    force: boolean,
  ): Promise<void> {
    if (!storage.openUploadStream) {
      throw new Error('Storage adapter does not support streaming uploads');
    }
    const existingArtifact = await findKindRow(input.fileId, input.versionId, artifact.kind);
    const keepsClientArtifact = (row: FileArtifactRecord) => !force && artifactSourceOf(row) === 'client';
    if (existingArtifact && keepsClientArtifact(existingArtifact)) {
      return;
    }

    writes.uploadedKeys.add(artifact.storageKey);
    const stream = await storage.openUploadStream({
      key: artifact.storageKey,
      target,
      contentType: artifact.mimeType,
    });
    const writer = stream.getWriter();
    await writer.write(artifact.data);
    await writer.close();

    const fields = {
      storageKey: artifact.storageKey,
      mimeType: artifact.mimeType,
      size: artifact.data.length,
      metadata: { ...(artifact.metadata ?? {}), processing },
    };
    // The row read above may be stale by now: a client upload can land while
    // the object was stored. Each write is conditional on the row it read, so
    // an unforced run never replaces a client artifact it did not see, and
    // the object discarded is the one of the row actually replaced.
    const artifactId = artifactIdFor(input.fileId, input.versionId, artifact.kind);
    let current = existingArtifact;
    for (let attempt = 1; ; attempt += 1) {
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
        }
      }
      if (keepsClientArtifact(current)) {
        // The client's artifact stays; the object uploaded above is not recorded.
        writes.uploadedKeys.delete(artifact.storageKey);
        await discardReplacedObject({ ...current, storageKey: artifact.storageKey, metadata: { processing } }, target);
        return;
      }
      if (await replaceIfUnchanged(current, fields)) {
        writes.artifactsRecorded += 1;
        // A forced run replacing a client artifact leaves its object unreferenced.
        if (artifactSourceOf(current) === 'client' && current.storageKey !== artifact.storageKey) {
          await discardReplacedObject(current, target);
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
    const journaled = new Set<string>();
    for (const row of rows) {
      if (row.kind !== PROCESSING_RUN_KIND) {
        journaled.add(storageRef(recordedStorageTarget(row) ?? fallbackTarget, row.storageKey));
      }
    }
    const unjournaled = new Set(
      [...writes.uploadedKeys].map((key) => storageRef(fallbackTarget, key)).filter((ref) => !journaled.has(ref)),
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
    for (const row of rows) {
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
        .filter((row) => row.kind !== PROCESSING_RUN_KIND && artifactSourceOf(row) === 'client')
        .map((row) => row.kind),
    );
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

      for (const processor of applicableProcessors) {
        const run = await executeProcessor(processor, input, getData);
        if (!run.result) {
          if (run.error) {
            processingErrors.push(`${processor.name}: ${run.error}`);
          }
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
     * object; the object the row named before is then deleted.
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
      if (upload.contentLength !== undefined && upload.contentLength > rule.maxSizeBytes) {
        throw errors.artifactTooLarge(upload.kind, rule.maxSizeBytes);
      }
      if (upload.contentLength === 0 || !upload.body) {
        throw errors.invalidRequest('Artifact body is empty');
      }

      const target = getArtifactStorageTarget(file);
      const storageKey = `${version.storageKey}.client-artifacts/${upload.kind}/${randomUUID()}`;
      const size = await storeBounded(upload.body, { key: storageKey, target, contentType: mimeType }, upload.kind, rule.maxSizeBytes);
      const ownObject = { fileId: file.fileId, versionId: version.versionId, storageKey, metadata: { processing: { source: 'client' } } };

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
        let current = await findKindRow(file.fileId, version.versionId, upload.kind);
        for (let attempt = 1; ; attempt += 1) {
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
              rowId = artifactId;
              break;
            } catch (error) {
              // A concurrent upload or processing run created the row first.
              current = await findArtifactRow(artifactId);
              if (!current) throw error;
            }
          }
          if (await replaceIfUnchanged(current, fields)) {
            replaced = current;
            rowId = current.artifactId;
            break;
          }
          if (attempt >= MAX_ARTIFACT_WRITE_ATTEMPTS) {
            throw errors.artifactWriteConflict(upload.kind);
          }
          current = await findArtifactRow(current.artifactId);
        }
      } catch (error) {
        await discardReplacedObject(ownObject, target);
        throw error;
      }

      // A delete of the version while the body was stored would leave this
      // row and object behind for a version that no longer exists.
      if (!(await findVersion(file.fileId, version.versionId))) {
        await db.delete({ model: 'fileArtifacts', where: [{ field: 'artifactId', operator: 'eq', value: rowId }], namespace });
        await discardReplacedObject(ownObject, target);
        throw errors.notFound('Version');
      }
      if (replaced && replaced.storageKey !== storageKey) {
        await discardReplacedObject(replaced, target);
      }

      const recorded = await findArtifactRow(rowId);
      if (!recorded) {
        // Deleted since it was written; the object is no longer named by any row.
        await discardReplacedObject(ownObject, target);
        throw errors.notFound('Artifact');
      }
      // A concurrent write may have replaced this one since; whichever write
      // replaced it discards this object, so nothing more is done here.
      logger?.info('client artifact attached', {
        requestId: ctx.requestId,
        fileId: file.fileId,
        versionId: version.versionId,
        kind: upload.kind,
        size,
      });
      return recorded;
    },

    async requireWritableFile(fileId: string, ctx: FileProviderContext): Promise<void> {
      await requireWritableFile(fileId, ctx);
    },

    async listArtifacts(
      fileId: string,
      ctx: FileProviderContext,
      page?: { limit?: number; offset?: number },
    ): Promise<FileArtifactRecord[]> {
      void ctx;

      const artifacts = await db.findMany<FileArtifactRecord>({
        model: 'fileArtifacts',
        where: [
          { field: 'fileId', operator: 'eq', value: fileId },
          { field: 'kind', operator: 'ne', value: PROCESSING_RUN_KIND },
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
    },

    async listArtifactsForFile(
      fileId: string,
      ctx: FileProviderContext,
      page?: { limit?: number; offset?: number },
    ): Promise<FileArtifactRecord[]> {
      await requireReadableFile(fileId, ctx);
      return this.listArtifacts(fileId, ctx, page);
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

      if (!artifact || artifact.kind === PROCESSING_RUN_KIND) {
        throw errors.notFound('Artifact');
      }

      const file = await db.findOne<FileRecord>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: artifact.fileId }],
        namespace,
      });
      if (file) {
        await requireReadableFile(file.fileId, ctx);
      }
      const artifactStorageTarget = getArtifactStorageTarget(file ?? { policy: '' });

      if (getStorageCapabilities(storage, artifactStorageTarget).signedDownloadUrls && storage.signDownloadUrl) {
        const result = await storage.signDownloadUrl({
          key: artifact.storageKey,
          target: artifactStorageTarget,
          expiresInSeconds: 900,
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
        });
        return { url: result.url, headers: result.headers };
      }

      return { url: `/proxy/files/${fileId}/artifacts/${artifactId}/download` };
    },

    async getArtifactDownloadStreamForFile(
      fileId: string,
      artifactId: string,
      ctx: FileProviderContext,
    ): Promise<{ stream: ReadableStream; contentType: string; size: number }> {
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

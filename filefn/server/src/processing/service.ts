import { createHash } from 'node:crypto';
import type { Adapter } from '@superfunctions/db';
import { getStorageCapabilities, type StorageAdapter } from '@superfunctions/storage';
import type { FileProviderContext } from '@superfunctions/files';
import type { FileFnEventEmitter } from '../events.js';
import { resolveArtifactStorageTarget, resolveStorageTarget, type PolicyRegistry } from '../policies.js';
import type { Logger } from '../observability/logger.js';
import * as errors from '../errors.js';
import { createBackgroundScheduler, type BackgroundScheduler } from '../runtime.js';
import { findReferencedStorageRefs, parseStorageRef, storageRef } from '../storage-references.js';

export interface Processor {
  name: string;
  supportedMimeTypes: string[];
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
}

/** Result of running one queued processing job. */
export type ProcessingJobOutcome =
  /** Every applicable processor succeeded; processors with a run recorded for this key were skipped. */
  | { status: 'completed'; artifactsCreated: number; skippedProcessors: ProcessorInstance[] }
  /** Every applicable processor already has a run recorded for this idempotency key. */
  | { status: 'duplicate' }
  /** Nothing to process: the body is not a job, or the file version no longer exists. */
  | { status: 'dropped'; reason: 'invalid-job' | 'version-deleted' }
  /** A processor failed and the delivery is not the last; the queue should redeliver. */
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
  processor: string;
  /** Wall-clock time the processor's `process` call took, in milliseconds. */
  durationMs: number;
  idempotencyKey: string;
}

/**
 * Kind of the `fileArtifacts` rows a processing job writes to record that one
 * processor finished for one idempotency key, including a run that produced
 * no artifacts. They have no stored object, and the artifact list, lookup and
 * download operations never return them.
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MAX_JOB_FIELD_LENGTH = 512;

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
  };
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
 * A processor list too long for the job field bound is replaced by its hash,
 * so the consumer never rejects a key FileFn enqueued.
 */
function buildProcessingIdempotencyKey(fileId: string, versionId: string, processors: Processor[]): string {
  const processorKey = processors.map((processor) => processor.name).sort().join(',');
  const key = `processing:${fileId}:${versionId}:${processorKey}`;
  if (key.length <= MAX_JOB_FIELD_LENGTH) {
    return key;
  }
  const digest = createHash('sha256').update(processorKey).digest('hex');
  return `processing:${fileId}:${versionId}:sha256:${digest}`;
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
  } = config;
  const background = config.background ?? createBackgroundScheduler(undefined, logger);
  const processorEntries = processorEntriesFor(processors);

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
      if (!result?.success) {
        return { error: result?.error, durationMs };
      }
      return { result, durationMs };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unknown error', durationMs: Math.max(0, Date.now() - startedAt) };
    }
  }

  /**
   * Uploads one artifact and creates or updates its row for (file, version,
   * kind), noting each write in `writes` as it lands.
   */
  async function recordArtifact(
    input: Pick<ProcessorInput, 'fileId' | 'versionId'>,
    artifact: ProcessorOutputArtifact,
    target: string,
    processing: ArtifactProcessingMetadata,
    writes: ProcessingWrites,
  ): Promise<void> {
    if (!storage.openUploadStream) {
      throw new Error('Storage adapter does not support streaming uploads');
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
    const existingArtifact = await db.findOne<FileArtifactRecord>({
      model: 'fileArtifacts',
      where: [
        { field: 'fileId', operator: 'eq', value: input.fileId },
        { field: 'versionId', operator: 'eq', value: input.versionId },
        { field: 'kind', operator: 'eq', value: artifact.kind },
      ],
      namespace,
    });
    if (existingArtifact) {
      await db.update({
        model: 'fileArtifacts',
        where: [{ field: 'artifactId', operator: 'eq', value: existingArtifact.artifactId }],
        data: fields,
        namespace,
      });
      writes.artifactsRecorded += 1;
      return;
    }

    const artifactId = artifactIdFor(input.fileId, input.versionId, artifact.kind);
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
    } catch (error) {
      // A concurrent delivery created the same row first; record over it.
      const raced = await db.findOne<FileArtifactRecord>({
        model: 'fileArtifacts',
        where: [{ field: 'artifactId', operator: 'eq', value: artifactId }],
        namespace,
      });
      if (!raced) {
        throw error;
      }
      await db.update({
        model: 'fileArtifacts',
        where: [{ field: 'artifactId', operator: 'eq', value: artifactId }],
        data: fields,
        namespace,
      });
    }
    writes.artifactsRecorded += 1;
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
  ): Promise<void> {
    const processing: ArtifactProcessingMetadata = {
      processor: processor.name,
      durationMs: run.durationMs,
      idempotencyKey,
    };
    for (const artifact of run.result?.artifacts ?? []) {
      await recordArtifact(input, artifact, target, processing, writes);
    }
  }

  /** IDs of the run rows recorded for one file version. */
  async function findProcessingRuns(fileId: string, versionId: string): Promise<Set<string>> {
    const runs = await db.findMany<FileArtifactRecord>({
      model: 'fileArtifacts',
      where: [
        { field: 'fileId', operator: 'eq', value: fileId },
        { field: 'versionId', operator: 'eq', value: versionId },
        { field: 'kind', operator: 'eq', value: PROCESSING_RUN_KIND },
      ],
      namespace,
    });
    return new Set(runs.map((run) => run.artifactId));
  }

  /**
   * Records that a processor finished for an idempotency key. It is written
   * after the processor's artifacts, so a redelivery skips the processor only
   * once its whole output is recorded.
   */
  async function recordProcessingRun(
    input: Pick<ProcessorInput, 'fileId' | 'versionId'>,
    idempotencyKey: string,
    instance: ProcessorInstance,
    details: { durationMs: number; artifactCount: number },
  ): Promise<void> {
    const artifactId = processingRunIdFor(input.fileId, input.versionId, idempotencyKey, instance);
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
          metadata: { processingRun: { ...instance, idempotencyKey, ...details } },
          createdAt: new Date().toISOString(),
        },
        namespace,
      });
    } catch (error) {
      // A concurrent delivery recorded the same run first.
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
   * Removes what processing left for a deleted version: its rows, and the
   * objects this run uploaded or the rows named, unless another row still
   * references the same object (deduplicated files can share storage keys).
   * The rows go first, so of two cleanups racing over one object the later
   * one sees no reference and deletes it.
   */
  async function discardDeletedVersionOutput(
    input: Pick<ProcessorInput, 'fileId' | 'versionId'>,
    target: string,
    writes: ProcessingWrites,
  ): Promise<void> {
    const where = [
      { field: 'fileId', operator: 'eq' as const, value: input.fileId },
      { field: 'versionId', operator: 'eq' as const, value: input.versionId },
    ];
    const rows = await db.findMany<FileArtifactRecord>({ model: 'fileArtifacts', where, namespace });
    const refs = new Set([...writes.uploadedKeys].map((key) => storageRef(target, key)));
    for (const row of rows) {
      if (row.kind !== PROCESSING_RUN_KIND) {
        refs.add(storageRef(target, row.storageKey));
      }
    }
    await db.deleteMany({ model: 'fileArtifacts', where, namespace });
    const referenced = await findReferencedStorageRefs({ db, namespace, policies }, refs);
    for (const ref of refs) {
      if (referenced.has(ref)) {
        continue;
      }
      try {
        await storage.deleteObject(parseStorageRef(ref));
      } catch {
        // Best effort, as in deleteFile: the object may never have been written.
      }
    }
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
  ): Promise<ProcessingJobOutcome> {
    const found = await findVersion(job.fileId, job.versionId);
    if (!found) {
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
    const idempotencyKey = job.idempotencyKey ?? buildProcessingIdempotencyKey(input.fileId, input.versionId, processors);
    const applicable = processorEntries.filter((entry) => supportsProcessor(entry.processor, input.mimeType));
    if (applicable.length === 0) {
      // As runProcessing does, a version no processor applies to completes without an event.
      return { status: 'completed', artifactsCreated: 0, skippedProcessors: [] };
    }

    const recordedRuns = await findProcessingRuns(input.fileId, input.versionId);
    const isRecorded = (entry: ProcessorEntry) =>
      recordedRuns.has(processingRunIdFor(input.fileId, input.versionId, idempotencyKey, entry.instance));
    const pending = applicable.filter((entry) => !isRecorded(entry));
    const skippedProcessors = applicable.filter(isRecorded).map((entry) => entry.instance);
    if (pending.length === 0) {
      return { status: 'duplicate' };
    }

    const getData = createSourceReader(input.storageKey, getFileStorageTarget(file));
    const artifactStorageTarget = getArtifactStorageTarget(file);
    const processingErrors: string[] = [];
    const writes = emptyWrites();
    const dropDeletedVersion = async (): Promise<ProcessingJobOutcome> => {
      await discardDeletedVersionOutput(input, artifactStorageTarget, writes);
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
        await recordArtifacts(input, entry.processor, run, artifactStorageTarget, idempotencyKey, writes);
        await recordProcessingRun(input, idempotencyKey, entry.instance, {
          durationMs: run.durationMs,
          artifactCount: writes.artifactsRecorded - recordedBefore,
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

    events.emit('processing.completed' as any, {
      type: 'processing.completed',
      timestamp: new Date().toISOString(),
      requestId: job.requestId,
      fileId: input.fileId,
      versionId: input.versionId,
      artifactsCreated: writes.artifactsRecorded,
    });
    return { status: 'completed', artifactsCreated: writes.artifactsRecorded, skippedProcessors };
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
      },
      ctx: FileProviderContext
    ): Promise<{ enqueued: boolean; jobId?: string }> {
      if (!enabled || processors.length === 0) {
        return { enqueued: false };
      }

      events.emit('processing.started' as any, {
        type: 'processing.started',
        timestamp: new Date().toISOString(),
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
              idempotencyKey: buildProcessingIdempotencyKey(input.fileId, input.versionId, processors),
              requestId: optionalJobField(ctx.requestId),
            } satisfies ProcessingJob);
            return { enqueued: true, jobId: result.jobId };
          } catch {
            throw errors.processingEnqueueFailed();
          }
        }
      }

      background.schedule(async () => {
        try {
          await this.runProcessing(input, ctx);
        } catch (error) {
          logger?.error('processing failed', {
            requestId: ctx.requestId,
            fileId: input.fileId,
            versionId: input.versionId,
            error: error instanceof Error ? error.stack ?? error.message : String(error),
          });
          events.emit('processing.failed' as any, {
            type: 'processing.failed',
            timestamp: new Date().toISOString(),
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
      ctx: FileProviderContext
    ): Promise<{ artifactsCreated: number; errors: string[] }> {
      const applicableProcessors = processors.filter((p) =>
        supportsProcessor(p, input.mimeType)
      );

      if (applicableProcessors.length === 0) {
        return { artifactsCreated: 0, errors: [] };
      }

      const file = await db.findOne<FileRecord>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: input.fileId }],
        namespace,
      });
      const policyRef = file ?? { policy: '' };
      const getData = createSourceReader(input.storageKey, getFileStorageTarget(policyRef));
      const artifactStorageTarget = getArtifactStorageTarget(policyRef);
      const idempotencyKey = buildProcessingIdempotencyKey(input.fileId, input.versionId, processors);

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
          await recordArtifacts(input, processor, run, artifactStorageTarget, idempotencyKey, writes);
        } catch (error) {
          processingErrors.push(`${processor.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
        // Artifacts written before a failed write still count, as they did before.
        artifactsCreated += writes.artifactsRecorded;
      }

      events.emit('processing.completed' as any, {
        type: 'processing.completed',
        timestamp: new Date().toISOString(),
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
        outcome = await processValidJob(job);
      } catch (error) {
        outcome = { status: 'retry', errors: [errorMessage(error)] };
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
      events.emit('processing.failed' as any, {
        type: 'processing.failed',
        timestamp: new Date().toISOString(),
        requestId: job.requestId,
        fileId: job.fileId,
        versionId: job.versionId,
        error: outcome.errors.join('; '),
      });
      return { status: 'failed', errors: outcome.errors };
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

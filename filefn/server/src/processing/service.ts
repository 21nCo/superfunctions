import { createHash } from 'node:crypto';
import type { Adapter } from '@superfunctions/db';
import { getStorageCapabilities, type StorageAdapter } from '@superfunctions/storage';
import type { FileProviderContext } from '@superfunctions/files';
import type { FileFnEventEmitter } from '../events.js';
import { resolveArtifactStorageTarget, resolveStorageTarget, type PolicyRegistry } from '../policies.js';
import type { Logger } from '../observability/logger.js';
import * as errors from '../errors.js';
import { createBackgroundScheduler, type BackgroundScheduler } from '../runtime.js';

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
  /** Every applicable processor succeeded; processors already recorded for this key were skipped. */
  | { status: 'completed'; artifactsCreated: number; skippedProcessors: string[] }
  /** Every applicable processor was already recorded for this idempotency key. */
  | { status: 'duplicate' }
  /** Nothing to process: the body is not a job, or the file version no longer exists. */
  | { status: 'dropped'; reason: 'invalid-job' | 'version-deleted' }
  /** A processor failed and the delivery is not the last; the queue should redeliver. */
  | { status: 'retry'; errors: string[] }
  /** A processor failed on the last delivery; `processing.failed` was emitted. */
  | { status: 'failed'; errors: string[] };

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
  /** Number of artifacts the processor produced in the same run. */
  artifactCount: number;
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

/**
 * Derives the artifact ID for one (file, version, kind). Concurrent deliveries
 * of the same job then create the same row, so the unique `artifactId` makes
 * the second insert fail instead of adding a duplicate artifact.
 */
function artifactIdFor(fileId: string, versionId: string, kind: string): string {
  const digest = createHash('sha256').update(`${fileId}\u0000${versionId}\u0000${kind}`).digest();
  let suffix = '';
  for (let index = 0; index < 20; index += 1) {
    suffix += ID_ALPHABET[digest[index] & 31];
  }
  return `art_${suffix}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MAX_JOB_FIELD_LENGTH = 512;

function isJobField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_JOB_FIELD_LENGTH;
}

function isOptionalJobField(value: unknown): value is string | undefined {
  return value === undefined || isJobField(value);
}

function parseProcessingJob(body: unknown): Omit<ProcessingJob, 'idempotencyKey'> & { idempotencyKey?: string } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const job = body as Record<string, unknown>;
  if (!isJobField(job.fileId) || !isJobField(job.versionId)) {
    return null;
  }
  if (!isOptionalJobField(job.idempotencyKey) || !isOptionalJobField(job.jobId) || !isOptionalJobField(job.requestId)) {
    return null;
  }
  return {
    fileId: job.fileId,
    versionId: job.versionId,
    idempotencyKey: job.idempotencyKey,
    jobId: job.jobId,
    requestId: job.requestId,
  };
}

function readProcessingMetadata(artifact: FileArtifactRecord): Partial<ArtifactProcessingMetadata> | undefined {
  const value = artifact.metadata?.processing;
  return typeof value === 'object' && value !== null ? value as Partial<ArtifactProcessingMetadata> : undefined;
}

/**
 * Names of processors whose complete artifact set is already recorded for
 * `idempotencyKey`. A processor with fewer recorded artifacts than it
 * produced (an interrupted earlier delivery) is not complete.
 */
function completedProcessors(artifacts: FileArtifactRecord[], idempotencyKey: string): Set<string> {
  const recorded = new Map<string, { count: number; expected: number }>();
  for (const artifact of artifacts) {
    const processing = readProcessingMetadata(artifact);
    if (!processing || processing.idempotencyKey !== idempotencyKey || typeof processing.processor !== 'string') {
      continue;
    }
    const entry = recorded.get(processing.processor) ?? { count: 0, expected: Number.POSITIVE_INFINITY };
    entry.count += 1;
    if (typeof processing.artifactCount === 'number') {
      entry.expected = Math.min(entry.expected, processing.artifactCount);
    }
    recorded.set(processing.processor, entry);
  }
  const complete = new Set<string>();
  for (const [processor, entry] of recorded) {
    if (entry.count >= entry.expected) {
      complete.add(processor);
    }
  }
  return complete;
}

function supportsProcessor(processor: Processor, mimeType: string): boolean {
  if (processor.supportedMimeTypes.includes('*/*')) {
    return true;
  }
  return processor.supportedMimeTypes.includes(mimeType);
}

function buildProcessingIdempotencyKey(fileId: string, versionId: string, processors: Processor[]): string {
  const processorKey = processors.map((processor) => processor.name).sort().join(',');
  return `processing:${fileId}:${versionId}:${processorKey}`;
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

    if (!artifact) {
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

  /** Uploads one artifact and creates or updates its row for (file, version, kind). */
  async function recordArtifact(
    input: Pick<ProcessorInput, 'fileId' | 'versionId'>,
    artifact: ProcessorOutputArtifact,
    target: string,
    processing: ArtifactProcessingMetadata,
  ): Promise<void> {
    if (!storage.openUploadStream) {
      throw new Error('Storage adapter does not support streaming uploads');
    }
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
  }

  /** Records every artifact of one successful processor run; returns how many. */
  async function recordArtifacts(
    input: Pick<ProcessorInput, 'fileId' | 'versionId'>,
    processor: Processor,
    run: { result?: ProcessorResult; durationMs: number },
    target: string,
    idempotencyKey: string,
  ): Promise<number> {
    const artifacts = run.result?.artifacts ?? [];
    const processing: ArtifactProcessingMetadata = {
      processor: processor.name,
      durationMs: run.durationMs,
      idempotencyKey,
      artifactCount: artifacts.length,
    };
    for (const artifact of artifacts) {
      await recordArtifact(input, artifact, target, processing);
    }
    return artifacts.length;
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
    const applicableProcessors = processors.filter((processor) => supportsProcessor(processor, input.mimeType));

    const recorded = await db.findMany<FileArtifactRecord>({
      model: 'fileArtifacts',
      where: [
        { field: 'fileId', operator: 'eq', value: input.fileId },
        { field: 'versionId', operator: 'eq', value: input.versionId },
      ],
      namespace,
    });
    const complete = completedProcessors(recorded, idempotencyKey);
    const pending = applicableProcessors.filter((processor) => !complete.has(processor.name));
    const skippedProcessors = applicableProcessors
      .filter((processor) => complete.has(processor.name))
      .map((processor) => processor.name);
    if (applicableProcessors.length > 0 && pending.length === 0) {
      return { status: 'duplicate' };
    }

    const getData = createSourceReader(input.storageKey, getFileStorageTarget(file));
    const artifactStorageTarget = getArtifactStorageTarget(file);
    const processingErrors: string[] = [];
    let artifactsCreated = 0;

    for (const processor of pending) {
      const run = await executeProcessor(processor, input, getData);
      // The version may have been deleted while the processor ran; its source
      // read then fails too, which is not a failure worth retrying.
      if (!(await findVersion(input.fileId, input.versionId))) {
        return { status: 'dropped', reason: 'version-deleted' };
      }
      if (!run.result) {
        processingErrors.push(`${processor.name}: ${run.error ?? 'processor reported failure'}`);
        continue;
      }
      try {
        artifactsCreated += await recordArtifacts(input, processor, run, artifactStorageTarget, idempotencyKey);
      } catch (error) {
        processingErrors.push(`${processor.name}: ${errorMessage(error)}`);
      }
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
      artifactsCreated,
    });
    return { status: 'completed', artifactsCreated, skippedProcessors };
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
              requestId: ctx.requestId,
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
        try {
          artifactsCreated += await recordArtifacts(input, processor, run, artifactStorageTarget, idempotencyKey);
        } catch (error) {
          processingErrors.push(`${processor.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
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
     * file version and have no complete artifact set recorded for the job's
     * idempotency key. Never throws; the outcome tells the queue consumer
     * whether to acknowledge or redeliver the message.
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
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
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

      if (!artifact) {
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

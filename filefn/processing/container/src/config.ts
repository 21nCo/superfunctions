import type { R2StorageConfig } from '@superfunctions/storage-r2';

export type ContainerEnv = Record<string, string | undefined>;

/** Processors the image can run. Audio and video are not offered yet. */
export const CONTAINER_PROCESSORS = ['thumbnail', 'pdf-preview', 'ocr'] as const;
export type ContainerProcessorName = (typeof CONTAINER_PROCESSORS)[number];

export interface ContainerConfig {
  port: number;
  token?: string;
  storage: R2StorageConfig;
  /** `memory`, or an ES module specifier whose default export creates the database adapter. */
  database: string;
  namespace?: string;
  processors: ContainerProcessorName[];
  maxRetries?: number;
  maxConcurrentJobs: number;
  /** Milliseconds a job request waits for a free slot before 503. */
  maxJobWaitMs: number;
  maxBodyBytes: number;
  ocrLanguage: string;
}

export class ContainerConfigError extends Error {
  constructor(message: string) {
    super(`FILEFN_CONTAINER_CONFIG_INVALID: ${message}`);
    this.name = 'ContainerConfigError';
  }
}

function text(env: ContainerEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

function required(env: ContainerEnv, key: string): string {
  const value = text(env, key);
  if (value === undefined) throw new ContainerConfigError(`${key} is required`);
  return value;
}

function integer(env: ContainerEnv, key: string, fallback: number | undefined, min: number, max: number): number | undefined {
  const value = text(env, key);
  if (value === undefined) return fallback;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ContainerConfigError(`${key} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function processors(env: ContainerEnv): ContainerProcessorName[] {
  const names = (text(env, 'FILEFN_PROCESSORS') ?? CONTAINER_PROCESSORS.join(','))
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) throw new ContainerConfigError('FILEFN_PROCESSORS must name at least one processor');
  for (const name of names) {
    if (!(CONTAINER_PROCESSORS as readonly string[]).includes(name)) {
      throw new ContainerConfigError(`FILEFN_PROCESSORS: unknown processor "${name}" (use ${CONTAINER_PROCESSORS.join(', ')})`);
    }
  }
  return [...new Set(names)] as ContainerProcessorName[];
}

function jurisdiction(env: ContainerEnv): R2StorageConfig['jurisdiction'] {
  const value = text(env, 'FILEFN_R2_JURISDICTION');
  if (value === undefined || value === 'eu' || value === 'fedramp') return value;
  throw new ContainerConfigError('FILEFN_R2_JURISDICTION must be eu or fedramp');
}

/**
 * Reads the container's configuration from its environment. Storage is the
 * FileFn R2 adapter (an S3-compatible `FILEFN_R2_ENDPOINT` such as MinIO
 * replaces the account endpoint); the database is `FILEFN_DATABASE`.
 */
export function readContainerConfig(env: ContainerEnv): ContainerConfig {
  const endpoint = text(env, 'FILEFN_R2_ENDPOINT');
  const ocrLanguage = text(env, 'FILEFN_OCR_LANGUAGE') ?? 'eng';
  if (!/^\w+(\+\w+)*$/.test(ocrLanguage)) {
    throw new ContainerConfigError('FILEFN_OCR_LANGUAGE must be tesseract language codes joined by +');
  }
  const storage: R2StorageConfig = {
    accountId: endpoint ? text(env, 'FILEFN_R2_ACCOUNT_ID') ?? 'endpoint' : required(env, 'FILEFN_R2_ACCOUNT_ID'),
    bucket: required(env, 'FILEFN_R2_BUCKET'),
    accessKeyId: required(env, 'FILEFN_R2_ACCESS_KEY_ID'),
    secretAccessKey: required(env, 'FILEFN_R2_SECRET_ACCESS_KEY'),
  };
  const region = text(env, 'FILEFN_R2_REGION');
  const storageJurisdiction = jurisdiction(env);
  if (endpoint) storage.endpoint = endpoint;
  if (region) storage.region = region;
  if (storageJurisdiction) storage.jurisdiction = storageJurisdiction;

  return {
    port: integer(env, 'PORT', 8080, 0, 65_535)!,
    token: text(env, 'FILEFN_CONTAINER_TOKEN'),
    storage,
    database: required(env, 'FILEFN_DATABASE'),
    namespace: text(env, 'FILEFN_NAMESPACE'),
    processors: processors(env),
    maxRetries: integer(env, 'FILEFN_PROCESSING_MAX_RETRIES', undefined, 0, 1_000),
    maxConcurrentJobs: integer(env, 'FILEFN_CONTAINER_MAX_CONCURRENT_JOBS', 2, 1, 64)!,
    maxJobWaitMs: integer(env, 'FILEFN_CONTAINER_JOB_WAIT_MS', 60_000, 0, 600_000)!,
    maxBodyBytes: integer(env, 'FILEFN_CONTAINER_MAX_BODY_BYTES', 256 * 1024, 1_024, 16 * 1024 * 1024)!,
    ocrLanguage,
  };
}

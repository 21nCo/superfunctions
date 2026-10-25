/**
 * Pipeline reference resolution: repo/ref/configPath → pipeline document string.
 * Default config path fallback order: .ci/pipeline.yml, .ci/pipeline.yaml, cifn.yml, cifn.yaml.
 */

import { mkdtempSync, rmSync, realpathSync, openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { executeOwnedCheckout } from './git-checkout.js';
import { ProcessGroupUncertainError } from '../execution/owned-process.js';

export interface PipelineRef {
  repo: string;
  ref: string;
  configPath?: string;
}

export const DEFAULT_CONFIG_PATHS = [
  '.ci/pipeline.yml',
  '.ci/pipeline.yaml',
  'cifn.yml',
  'cifn.yaml',
] as const;

export interface ResolveResult {
  doc: string;
  resolvedConfigPath: string;
}

export type PipelineFetcher = (
  ref: PipelineRef,
  configPath: string,
) => Promise<string | null>;

/**
 * Resolves a pipeline document from a repo reference.
 * If configPath is provided, reads that path only (fails if missing).
 * If configPath is omitted, tries DEFAULT_CONFIG_PATHS in order; first existing file wins.
 *
 * @param pipelineRef - repo URL, ref (branch/tag/SHA), optional configPath
 * @param options.fetcher - optional custom fetcher for tests (no git required). Return null if path not found.
 * @returns { doc, resolvedConfigPath }
 * @throws on clone error, missing file, or when no default path exists (deterministic RUN_CREATE_FAILED)
 */
export interface ResolveOptions { fetcher?: PipelineFetcher; signal?: AbortSignal; token?: string; allowLocalRepositories?: boolean }
const MAX_CONFIG_BYTES = 500 * 1024;
function validateConfigPath(path: string): void {
  if (typeof path !== 'string' || !path || path.length > 4096 || isAbsolute(path) || /[\\\x00]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new ResolverError('Invalid pipeline config path');
}
function boundedDoc(doc: string): string {
  if (typeof doc !== 'string' || Buffer.byteLength(doc, 'utf8') > MAX_CONFIG_BYTES) throw new ResolverError('Pipeline document exceeds 500KB');
  return doc;
}

export async function resolvePipelineDoc(
  pipelineRef: PipelineRef,
  options?: ResolveOptions,
): Promise<ResolveResult> {
  if (pipelineRef.configPath !== undefined) validateConfigPath(pipelineRef.configPath);
  if (options?.signal?.aborted) throw new ResolverError('Pipeline resolution cancelled');
  if (options?.fetcher) {
    return resolveWithFetcher(pipelineRef, options.fetcher, options.signal);
  }
  return resolveWithGit(pipelineRef, options);
}

async function resolveWithFetcher(
  ref: PipelineRef,
  fetcher: PipelineFetcher,
  signal?: AbortSignal,
): Promise<ResolveResult> {
  const pathsToTry = ref.configPath
    ? [ref.configPath]
    : [...DEFAULT_CONFIG_PATHS];

  for (const configPath of pathsToTry) {
    if (signal?.aborted) throw new ResolverError('Pipeline resolution cancelled');
    const doc = await fetcher(ref, configPath);
    if (signal?.aborted) throw new ResolverError('Pipeline resolution cancelled');
    if (doc != null && doc !== '') {
      return { doc: boundedDoc(doc), resolvedConfigPath: configPath };
    }
  }

  if (ref.configPath) {
    throw new ResolverError(`Config path not found: ${ref.configPath}`);
  }
  throw new ResolverError(
    `No pipeline config found at any of: ${DEFAULT_CONFIG_PATHS.join(', ')}`,
  );
}

async function resolveWithGit(ref: PipelineRef, options: ResolveOptions = {}): Promise<ResolveResult> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cifn-resolver-')));
  let uncertain = false;
  try {
    const checkout = await executeOwnedCheckout({ repo: ref.repo, ref: ref.ref, workspace: dir,
      token: options.token, signal: options.signal, allowLocalRepositories: options.allowLocalRepositories });
    if (!checkout.success) throw new ResolverError('Git checkout failed');
    if (options.signal?.aborted) throw new ResolverError('Pipeline resolution cancelled');
    const pathsToTry = ref.configPath ? [ref.configPath] : [...DEFAULT_CONFIG_PATHS];
    for (const configPath of pathsToTry) {
      let canonical: string;
      try { canonical = realpathSync(join(dir, configPath)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw new ResolverError('Pipeline config cannot be resolved'); }
      const rel = relative(dir, canonical);
      if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new ResolverError('Pipeline config escapes workspace');
      let fd: number | undefined;
      try {
        fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = fstatSync(fd);
        if (!stat.isFile()) throw new ResolverError('Pipeline config must be a regular file');
        if (stat.size > MAX_CONFIG_BYTES) throw new ResolverError('Pipeline document exceeds 500KB');
        const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1); let used = 0;
        while (used < bytes.length) {
          const count = readSync(fd, bytes, used, bytes.length - used, null);
          if (!count) break;
          used += count;
        }
        if (used > MAX_CONFIG_BYTES) throw new ResolverError('Pipeline document exceeds 500KB');
        return { doc: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)), resolvedConfigPath: configPath };
      } catch (error) {
        if (error instanceof ResolverError) throw error;
        throw new ResolverError('Pipeline config cannot be read');
      } finally { if (fd !== undefined) closeSync(fd); }
    }
    throw new ResolverError(ref.configPath ? 'Pipeline config path not found' : 'No pipeline config found at supported paths');
  } catch (error) {
    if (error instanceof ProcessGroupUncertainError) uncertain = true;
    throw error;
  } finally {
    if (!uncertain) rmSync(dir, { recursive: true, force: true });
  }
}

export class ResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolverError';
    Object.setPrototypeOf(this, ResolverError.prototype);
  }
}

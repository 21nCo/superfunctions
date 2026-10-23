/**
 * Pipeline reference resolution: repo/ref/configPath → pipeline document string.
 * Default config path fallback order: .ci/pipeline.yml, .ci/pipeline.yaml, cifn.yml, cifn.yaml.
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

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
export async function resolvePipelineDoc(
  pipelineRef: PipelineRef,
  options?: { fetcher?: PipelineFetcher },
): Promise<ResolveResult> {
  if (options?.fetcher) {
    return resolveWithFetcher(pipelineRef, options.fetcher);
  }
  return resolveWithGit(pipelineRef);
}

async function resolveWithFetcher(
  ref: PipelineRef,
  fetcher: PipelineFetcher,
): Promise<ResolveResult> {
  const pathsToTry = ref.configPath
    ? [ref.configPath]
    : [...DEFAULT_CONFIG_PATHS];

  for (const configPath of pathsToTry) {
    const doc = await fetcher(ref, configPath);
    if (doc != null && doc !== '') {
      return { doc, resolvedConfigPath: configPath };
    }
  }

  if (ref.configPath) {
    throw new ResolverError(`Config path not found: ${ref.configPath}`);
  }
  throw new ResolverError(
    `No pipeline config found at any of: ${DEFAULT_CONFIG_PATHS.join(', ')}`,
  );
}

function resolveWithGit(ref: PipelineRef): Promise<ResolveResult> {
  const dir = mkdtempSync(join(tmpdir(), 'cifn-resolver-'));
  try {
    const branch = ref.ref.replace(/^refs\/heads\//, '');
    execSync(`git clone --depth 1 --branch "${branch}" "${ref.repo}" "${dir}"`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    const msg = err instanceof Error ? err.message : String(err);
    throw new ResolverError(`Git clone failed: ${msg}`);
  }

  try {
    const pathsToTry = ref.configPath
      ? [ref.configPath]
      : [...DEFAULT_CONFIG_PATHS];

    for (const configPath of pathsToTry) {
      const fullPath = join(dir, configPath);
      if (existsSync(fullPath)) {
        const doc = readFileSync(fullPath, 'utf-8');
        return Promise.resolve({ doc, resolvedConfigPath: configPath });
      }
    }

    if (ref.configPath) {
      throw new ResolverError(`Config path not found: ${ref.configPath}`);
    }
    throw new ResolverError(
      `No pipeline config found at any of: ${DEFAULT_CONFIG_PATHS.join(', ')}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export class ResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolverError';
    Object.setPrototypeOf(this, ResolverError.prototype);
  }
}

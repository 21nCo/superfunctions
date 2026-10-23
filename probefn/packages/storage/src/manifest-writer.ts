import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createProbefnError } from '@probefn/contracts/errors';
import type { JsonValue } from '@probefn/contracts/envelopes';

export function assertRepositoryRelativePath(relativePath: string): string {
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.startsWith('~')
  ) {
    throw createProbefnError({
      code: 'E_STORAGE_WRITE_FAILED',
      message: `Artifact path ${relativePath || '<empty>'} must be repository-relative.`,
      retryable: false,
      details: {
        path: relativePath,
      },
    });
  }

  const normalized = path.posix.normalize(relativePath.replaceAll(path.sep, path.posix.sep));

  if (normalized === '..' || normalized.startsWith('../')) {
    throw createProbefnError({
      code: 'E_STORAGE_WRITE_FAILED',
      message: `Artifact path ${relativePath} escapes the repository root.`,
      retryable: false,
      details: {
        path: relativePath,
      },
    });
  }

  return normalized;
}

export async function writeJsonManifestAtomic(
  repoRoot: string,
  relativePath: string,
  value: JsonValue | Record<string, unknown> | unknown[] | object,
): Promise<number> {
  return writeAtomicFile(
    repoRoot,
    relativePath,
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

export async function writeAtomicFile(
  repoRoot: string,
  relativePath: string,
  contents: string | Uint8Array,
): Promise<number> {
  const normalizedPath = assertRepositoryRelativePath(relativePath);
  const absolutePath = path.resolve(repoRoot, normalizedPath);
  const directory = path.dirname(absolutePath);
  const tempPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}`;

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(tempPath, contents);
    await rename(tempPath, absolutePath);
    const fileStats = await stat(absolutePath);
    return fileStats.size;
  } catch (error) {
    throw createProbefnError({
      code: 'E_STORAGE_WRITE_FAILED',
      message: `Could not write artifact ${normalizedPath}.`,
      retryable: false,
      details: {
        path: normalizedPath,
      },
      cause: error,
    });
  }
}

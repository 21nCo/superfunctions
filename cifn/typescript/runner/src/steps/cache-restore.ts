import { unpackWorkspace, validateArchiveLimits, archiveError, type ArchiveLimits } from './archive.js';

export interface CacheRestoreOptions {
  key: string;
  workspace: string;
  archiveLimits?: ArchiveLimits;
  fileFnClient: {
    downloadByKey(namespace: string, key: string): Promise<Buffer | null>;
  };
}

export interface CacheRestoreResult {
  success: boolean;
  hit: boolean;
  lines: string[];
  error?: string;
}

export async function executeCacheRestore(options: CacheRestoreOptions): Promise<CacheRestoreResult> {
  const { key, workspace, fileFnClient } = options;
  const lines: string[] = [];

  // Validate cache key length (max 1KB)
  const keyByteLength = Buffer.byteLength(key, 'utf8');
  if (keyByteLength > 1024) {
    const msg = `Cache key exceeds maximum length of 1KB (actual: ${keyByteLength} bytes)`;
    lines.push(msg);
    return { success: false, hit: false, lines, error: msg };
  }

  try {
    validateArchiveLimits(options.archiveLimits);
    lines.push(`Restoring cache with key "${key}"`);

    const data = await fileFnClient.downloadByKey('cache', key);

    if (!data) {
      lines.push(`Cache miss for key "${key}"`);
      return { success: true, hit: false, lines };
    }

    const count = unpackWorkspace(workspace, data, options.archiveLimits);

    lines.push(`Cache hit: restored ${count} file(s)`);
    return { success: true, hit: true, lines };
  } catch (err: unknown) {
    const msg = archiveError(err);
    lines.push(`Cache restore failed: ${msg}`);
    return { success: false, hit: false, lines, error: msg };
  }
}

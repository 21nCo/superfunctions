import { packWorkspace, archiveError, type ArchiveLimits } from './archive.js';

export interface CacheSaveOptions {
  key: string;
  paths: string[];
  workspace: string;
  archiveLimits?: ArchiveLimits;
  fileFnClient: {
    upload(namespace: string, key: string, data: Buffer): Promise<string>;
  };
}

export interface CacheSaveResult {
  success: boolean;
  lines: string[];
  error?: string;
}

export async function executeCacheSave(options: CacheSaveOptions): Promise<CacheSaveResult> {
  const { key, paths, workspace, fileFnClient } = options;
  const lines: string[] = [];

  // Validate cache key length (max 1KB)
  const keyByteLength = Buffer.byteLength(key, 'utf8');
  if (keyByteLength > 1024) {
    const msg = `Cache key exceeds maximum length of 1KB (actual: ${keyByteLength} bytes)`;
    lines.push(msg);
    return { success: false, lines, error: msg };
  }

  try {
    lines.push(`Saving cache with key "${key}"`);

    const packed = packWorkspace(workspace, paths, false, options.archiveLimits);
    if (!packed.count) { lines.push('No files found to cache'); return {success:true,lines}; }
    await fileFnClient.upload('cache', key, packed.data);
    lines.push(`Cached ${packed.count} file(s) under key "${key}"`);
    return { success: true, lines };
  } catch (err: unknown) {
    const msg = archiveError(err);
    lines.push(`Cache save failed: ${msg}`);
    return { success: false, lines, error: msg };
  }
}

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface CacheRestoreOptions {
  key: string;
  workspace: string;
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
    lines.push(`Restoring cache with key "${key}"`);

    const data = await fileFnClient.downloadByKey('cache', key);

    if (!data) {
      lines.push(`Cache miss for key "${key}"`);
      return { success: true, hit: false, lines };
    }

    const manifestLen = data.readUInt32BE(0);
    const manifestJson = data.subarray(4, 4 + manifestLen).toString('utf-8');
    const manifest: Array<{ relativePath: string; offset: number; size: number }> = JSON.parse(manifestJson);

    const dataStart = 4 + manifestLen;

    for (const entry of manifest) {
      const fileBuf = data.subarray(dataStart + entry.offset, dataStart + entry.offset + entry.size);
      const outPath = join(workspace, entry.relativePath);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, fileBuf);
    }

    lines.push(`Cache hit: restored ${manifest.length} file(s)`);
    return { success: true, hit: true, lines };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    lines.push(`Cache restore failed: ${msg}`);
    return { success: false, hit: false, lines, error: msg };
  }
}

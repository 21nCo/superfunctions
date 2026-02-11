import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface CacheSaveOptions {
  key: string;
  paths: string[];
  workspace: string;
  fileFnClient: {
    upload(namespace: string, key: string, data: Buffer): Promise<string>;
  };
}

export interface CacheSaveResult {
  success: boolean;
  lines: string[];
  error?: string;
}

function collectFiles(dirPath: string, basePath: string): Array<{ relativePath: string; data: Buffer }> {
  const results: Array<{ relativePath: string; data: Buffer }> = [];
  if (!existsSync(dirPath)) return results;
  const stat = statSync(dirPath);
  if (stat.isFile()) {
    results.push({ relativePath: relative(basePath, dirPath), data: readFileSync(dirPath) });
    return results;
  }
  if (!stat.isDirectory()) return results;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isFile()) {
      results.push({ relativePath: relative(basePath, fullPath), data: readFileSync(fullPath) });
    } else if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, basePath));
    }
  }
  return results;
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

    const allFiles: Array<{ relativePath: string; data: Buffer }> = [];
    for (const p of paths) {
      const fullPath = join(workspace, p);
      const files = collectFiles(fullPath, workspace);
      allFiles.push(...files);
    }

    if (allFiles.length === 0) {
      lines.push('No files found to cache');
      return { success: true, lines };
    }

    const manifest: Array<{ relativePath: string; offset: number; size: number }> = [];
    const buffers: Buffer[] = [];
    let offset = 0;
    for (const f of allFiles) {
      manifest.push({ relativePath: f.relativePath, offset, size: f.data.length });
      buffers.push(f.data);
      offset += f.data.length;
    }

    const manifestBuf = Buffer.from(JSON.stringify(manifest));
    const headerBuf = Buffer.alloc(4);
    headerBuf.writeUInt32BE(manifestBuf.length, 0);
    const combined = Buffer.concat([headerBuf, manifestBuf, ...buffers]);

    await fileFnClient.upload('cache', key, combined);
    lines.push(`Cached ${allFiles.length} file(s) under key "${key}"`);
    return { success: true, lines };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    lines.push(`Cache save failed: ${msg}`);
    return { success: false, lines, error: msg };
  }
}

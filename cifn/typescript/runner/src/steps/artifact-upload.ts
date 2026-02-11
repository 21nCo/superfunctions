import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface ArtifactUploadOptions {
  name: string;
  path: string;
  workspace: string;
  runId: string;
  fileFnClient: {
    upload(namespace: string, key: string, data: Buffer): Promise<string>;
  };
}

export interface ArtifactUploadResult {
  success: boolean;
  fileId?: string;
  lines: string[];
  error?: string;
}

function collectFiles(dirPath: string): string[] {
  const files: string[] = [];
  if (!existsSync(dirPath)) return files;
  const stat = statSync(dirPath);
  if (stat.isFile()) return [dirPath];
  if (!stat.isDirectory()) return files;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isFile()) {
      files.push(fullPath);
    } else if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    }
  }
  return files;
}

export async function executeArtifactUpload(options: ArtifactUploadOptions): Promise<ArtifactUploadResult> {
  const { name, path: artifactPath, workspace, runId, fileFnClient } = options;
  const lines: string[] = [];

  // Validate artifact name length (max 256 chars)
  if (name.length > 256) {
    const msg = `Artifact name exceeds maximum length of 256 characters (actual: ${name.length})`;
    lines.push(msg);
    return { success: false, lines, error: msg };
  }

  const fullPath = join(workspace, artifactPath);

  if (!existsSync(fullPath)) {
    const msg = `Artifact path not found: ${artifactPath}`;
    lines.push(msg);
    return { success: false, lines, error: msg };
  }

  try {
    lines.push(`Uploading artifact "${name}" from ${artifactPath}`);

    const files = collectFiles(fullPath);
    const buffers: Buffer[] = [];
    const manifest: Array<{ relativePath: string; offset: number; size: number }> = [];

    let offset = 0;
    for (const file of files) {
      const data = readFileSync(file);
      const rel = relative(fullPath, file) || relative(workspace, file);
      manifest.push({ relativePath: rel, offset, size: data.length });
      buffers.push(data);
      offset += data.length;
    }

    const manifestBuf = Buffer.from(JSON.stringify(manifest));
    const headerBuf = Buffer.alloc(4);
    headerBuf.writeUInt32BE(manifestBuf.length, 0);

    const combined = Buffer.concat([headerBuf, manifestBuf, ...buffers]);

    const namespace = `artifact:${runId}`;
    const fileId = await fileFnClient.upload(namespace, name, combined);

    lines.push(`Uploaded ${files.length} file(s), artifact fileId: ${fileId}`);
    return { success: true, fileId, lines };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    lines.push(`Upload failed: ${msg}`);
    return { success: false, lines, error: msg };
  }
}

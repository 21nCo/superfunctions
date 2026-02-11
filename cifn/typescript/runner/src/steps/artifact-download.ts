import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface ArtifactDownloadOptions {
  name: string;
  workspace: string;
  runId: string;
  fileFnClient: {
    downloadByKey(namespace: string, key: string): Promise<Buffer | null>;
  };
}

export interface ArtifactDownloadResult {
  success: boolean;
  lines: string[];
  error?: string;
}

export async function executeArtifactDownload(options: ArtifactDownloadOptions): Promise<ArtifactDownloadResult> {
  const { name, workspace, runId, fileFnClient } = options;
  const lines: string[] = [];

  try {
    lines.push(`Downloading artifact "${name}"`);

    const namespace = `artifact:${runId}`;
    const data = await fileFnClient.downloadByKey(namespace, name);

    if (!data) {
      const msg = `Artifact "${name}" not found`;
      lines.push(msg);
      return { success: false, lines, error: msg };
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

    lines.push(`Downloaded and extracted ${manifest.length} file(s)`);
    return { success: true, lines };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    lines.push(`Download failed: ${msg}`);
    return { success: false, lines, error: msg };
  }
}

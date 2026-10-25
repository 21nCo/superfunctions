import { unpackWorkspace, validateArchiveLimits, archiveError, type ArchiveLimits } from './archive.js';

export interface ArtifactDownloadOptions {
  name: string;
  workspace: string;
  archiveLimits?: ArchiveLimits;
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
    validateArchiveLimits(options.archiveLimits);
    lines.push(`Downloading artifact "${name}"`);

    const namespace = `artifact:${runId}`;
    const data = await fileFnClient.downloadByKey(namespace, name);

    if (!data) {
      const msg = `Artifact "${name}" not found`;
      lines.push(msg);
      return { success: false, lines, error: msg };
    }

    const count = unpackWorkspace(workspace, data, options.archiveLimits);

    lines.push(`Downloaded and extracted ${count} file(s)`);
    return { success: true, lines };
  } catch (err: unknown) {
    const msg = archiveError(err);
    lines.push(`Download failed: ${msg}`);
    return { success: false, lines, error: msg };
  }
}

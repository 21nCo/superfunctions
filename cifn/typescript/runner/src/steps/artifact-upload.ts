import { packWorkspace, archiveError, type ArchiveLimits } from './archive.js';

export interface ArtifactUploadOptions {
  name: string;
  path: string;
  workspace: string;
  archiveLimits?: ArchiveLimits;
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

export async function executeArtifactUpload(options: ArtifactUploadOptions): Promise<ArtifactUploadResult> {
  const { name, path: artifactPath, workspace, runId, fileFnClient } = options;
  const lines: string[] = [];

  // Validate artifact name length (max 256 chars)
  if (name.length > 256) {
    const msg = `Artifact name exceeds maximum length of 256 characters (actual: ${name.length})`;
    lines.push(msg);
    return { success: false, lines, error: msg };
  }

  try {
    lines.push(`Uploading artifact "${name}" from ${artifactPath}`);

    const packed = packWorkspace(workspace, [artifactPath], true, options.archiveLimits);
    const namespace = `artifact:${runId}`;
    const fileId = await fileFnClient.upload(namespace, name, packed.data);

    lines.push(`Uploaded ${packed.count} file(s), artifact fileId: ${fileId}`);
    return { success: true, fileId, lines };
  } catch (err: unknown) {
    const msg = archiveError(err);
    lines.push(`Upload failed: ${msg}`);
    return { success: false, lines, error: msg };
  }
}

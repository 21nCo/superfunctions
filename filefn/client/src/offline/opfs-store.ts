import type { PendingLocalDescriptor } from '../types.js';
import { isValidFileId } from '../upload-manager.js';
import type { PendingLocalSourceMetadata } from '../preprocessing/types.js';

export interface PendingUpload {
  uploadSessionId: string;
  fileId?: string;
  policy: string;
  idempotencyKey?: string;
  fileName: string;
  size: number;
  mimeType: string;
  fileData: ArrayBuffer;
  localSource?: PendingLocalSourceMetadata;
  metadata?: Record<string, unknown>;
  createdAt: string;
  retryCount: number;
}

function deriveFallbackLocalSource(upload: Pick<PendingUpload, 'fileName' | 'mimeType' | 'size'>): PendingLocalSourceMetadata {
  if (upload.mimeType.startsWith('image/')) {
    return {
      mode: 'local-object-url',
      kind: 'image',
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      size: upload.size,
      opfsDataFile: 'data.bin',
      previewBehavior: 'direct-image',
    };
  }

  if (upload.mimeType === 'application/pdf') {
    return {
      mode: 'local-object-url',
      kind: 'pdf',
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      size: upload.size,
      opfsDataFile: 'data.bin',
      previewBehavior: 'deterministic-placeholder',
    };
  }

  return {
    mode: 'local-object-url',
    kind: 'binary',
    fileName: upload.fileName,
    mimeType: upload.mimeType,
    size: upload.size,
    opfsDataFile: 'data.bin',
    previewBehavior: 'download-only',
  };
}

/**
 * File ID of a pending upload staged without one. It is derived from the
 * upload session ID, so every read of the same upload gives the same ID, and
 * it matches the grammar `upload/init` accepts, `file_[A-Za-z0-9_-]{8,64}`.
 */
export function fallbackFileId(uploadSessionId: string): string {
  return `file_${uploadSessionId.replace(/[^A-Za-z0-9_-]/g, '_').padEnd(8, '_').slice(0, 64)}`;
}

/**
 * File ID of a pending upload. Earlier clients persisted the upload session ID
 * (`offline_...`) as the file ID of an upload staged without one; that, like a
 * missing ID, is outside the grammar and resolves to `fallbackFileId`. A valid
 * ID is kept as staged.
 */
function resolveFileId(fileId: string | undefined, uploadSessionId: string): string {
  return isValidFileId(fileId) ? fileId : fallbackFileId(uploadSessionId);
}

export interface OPFSStoreConfig {
  rootDir?: string;
}

export class OPFSStore {
  private static readonly LOCAL_OBJECT_URL_REVOKE_DELAY_MS = 5 * 60 * 1000;
  private rootDirName: string;
  private rootDir: FileSystemDirectoryHandle | null = null;
  private isInitialized = false;
  private localObjectUrls = new Map<string, string>();
  private localObjectUrlTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: OPFSStoreConfig = {}) {
    this.rootDirName = config.rootDir || 'filefn-pending-uploads';
  }

  /**
   * Check if OPFS is supported in the current environment.
   */
  static isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      'storage' in navigator &&
      'getDirectory' in (navigator.storage as any)
    );
  }

  /**
   * Initialize the OPFS store by getting the root directory handle.
   */
  async init(): Promise<void> {
    if (this.isInitialized) return;

    if (!OPFSStore.isSupported()) {
      throw new Error('OPFS is not supported in this environment');
    }

    try {
      const opfsRoot = await (navigator.storage as any).getDirectory();
      this.rootDir = await opfsRoot.getDirectoryHandle(this.rootDirName, { create: true });
      this.isInitialized = true;
    } catch (error) {
      throw new Error(
        `Failed to initialize OPFS: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Stage a pending upload to OPFS.
   */
  async stagePendingUpload(upload: PendingUpload): Promise<void> {
    await this.ensureInitialized();

    const uploadDir = await this.rootDir!.getDirectoryHandle(upload.uploadSessionId, {
      create: true,
    });

    try {
      const dataFileHandle = await uploadDir.getFileHandle('data.bin', { create: true });
      const dataWritable = await dataFileHandle.createWritable();
      await dataWritable.write(upload.fileData);
      await dataWritable.close();

      const metadata = {
        uploadSessionId: upload.uploadSessionId,
        fileId: resolveFileId(upload.fileId, upload.uploadSessionId),
        policy: upload.policy,
        idempotencyKey: upload.idempotencyKey,
        fileName: upload.fileName,
        size: upload.size,
        mimeType: upload.mimeType,
        localSource: upload.localSource || deriveFallbackLocalSource(upload),
        metadata: upload.metadata,
        createdAt: upload.createdAt,
        retryCount: upload.retryCount,
      };

      const metaFileHandle = await uploadDir.getFileHandle('metadata.json', { create: true });
      const metaWritable = await metaFileHandle.createWritable();
      await metaWritable.write(JSON.stringify(metadata, null, 2));
      await metaWritable.close();
    } catch (error) {
      await this.rootDir!.removeEntry(upload.uploadSessionId, { recursive: true }).catch(() => {});
      throw error;
    }
  }

  /**
   * Get a pending upload from OPFS.
   */
  async getPendingUpload(uploadSessionId: string): Promise<PendingUpload | null> {
    await this.ensureInitialized();

    try {
      const metadata = await this.readPendingMetadata(uploadSessionId);
      if (!metadata) {
        return null;
      }

      // Read file data
      const uploadDir = await this.rootDir!.getDirectoryHandle(uploadSessionId);
      const dataFileHandle = await uploadDir.getFileHandle('data.bin');
      const dataFile = await dataFileHandle.getFile();
      const fileData = await dataFile.arrayBuffer();

      return {
        ...metadata,
        fileId: resolveFileId(metadata.fileId, uploadSessionId),
        localSource: metadata.localSource || deriveFallbackLocalSource(metadata),
        fileData,
      };
    } catch (error) {
      // Directory doesn't exist
      return null;
    }
  }

  /**
   * List all pending uploads.
   */
  async listPendingUploads(): Promise<string[]> {
    await this.ensureInitialized();

    const uploadSessionIds: string[] = [];

    for await (const entry of (this.rootDir as any).values()) {
      if (entry.kind === 'directory') {
        uploadSessionIds.push(entry.name);
      }
    }

    return uploadSessionIds;
  }

  async getPendingUploadByFileId(fileId: string): Promise<PendingUpload | null> {
    const uploadSessionIds = await this.listPendingUploads();
    let bestMatch: Omit<PendingUpload, 'fileData'> | null = null;
    for (const uploadSessionId of uploadSessionIds) {
      const metadata = await this.readPendingMetadata(uploadSessionId);
      if (metadata?.fileId !== fileId) {
        continue;
      }
      if (!bestMatch || this.isPreferredPendingUpload(metadata, bestMatch)) {
        bestMatch = metadata;
      }
    }
    if (!bestMatch) {
      return null;
    }
    return this.getPendingUpload(bestMatch.uploadSessionId);
  }

  async getPendingLocalDescriptor(fileId: string): Promise<PendingLocalDescriptor | null> {
    const upload = await this.getPendingUploadByFileId(fileId);
    if (!upload) {
      return null;
    }

    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      const error = new Error('Local preview unavailable') as Error & { code?: string };
      error.code = 'FILEFN_OFFLINE_PREVIEW_UNSUPPORTED';
      throw error;
    }

    let url = this.localObjectUrls.get(upload.uploadSessionId);
    if (!url) {
      this.clearLocalObjectUrlTimer(upload.uploadSessionId);
      const blob = new Blob([upload.fileData], { type: upload.mimeType });
      url = URL.createObjectURL(blob);
      this.localObjectUrls.set(upload.uploadSessionId, url);
    }
    const resolvedFileId = resolveFileId(upload.fileId, upload.uploadSessionId);
    const resolvedLocalSource = upload.localSource ?? deriveFallbackLocalSource(upload);

    return {
      fileId: resolvedFileId,
      uploadSessionId: upload.uploadSessionId,
      state: 'pending-local',
      source: {
        ...resolvedLocalSource,
        url,
      },
    };
  }

  /**
   * Delete a pending upload from OPFS.
   */
  async deletePendingUpload(uploadSessionId: string): Promise<void> {
    await this.ensureInitialized();

    try {
      await this.rootDir!.removeEntry(uploadSessionId, { recursive: true });
    } catch (error) {
      // Ignore errors if directory doesn't exist
    } finally {
      this.scheduleLocalObjectUrlRevoke(uploadSessionId);
    }
  }

  /**
   * Increment retry count for a pending upload.
   */
  async incrementRetryCount(uploadSessionId: string): Promise<void> {
    await this.ensureInitialized();
    const metadata = await this.readPendingMetadata(uploadSessionId);
    if (!metadata) return;

    await this.writePendingMetadata(uploadSessionId, {
      ...metadata,
      retryCount: metadata.retryCount + 1,
    });
  }

  /**
   * Clear all pending uploads.
   */
  async clearAll(): Promise<void> {
    await this.ensureInitialized();

    const uploadSessionIds = await this.listPendingUploads();

    for (const uploadSessionId of uploadSessionIds) {
      await this.deletePendingUpload(uploadSessionId);
    }
  }

  /**
   * Get the total size of all pending uploads.
   */
  async getTotalSize(): Promise<number> {
    await this.ensureInitialized();

    let totalSize = 0;
    const uploadSessionIds = await this.listPendingUploads();

    for (const uploadSessionId of uploadSessionIds) {
      const upload = await this.getPendingUpload(uploadSessionId);
      if (upload) {
        totalSize += upload.size;
      }
    }

    return totalSize;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.isInitialized) {
      await this.init();
    }
  }

  private async readPendingMetadata(uploadSessionId: string): Promise<Omit<PendingUpload, 'fileData'> | null> {
    try {
      const uploadDir = await this.rootDir!.getDirectoryHandle(uploadSessionId);
      const metaFileHandle = await uploadDir.getFileHandle('metadata.json');
      const metaFile = await metaFileHandle.getFile();
      const metaText = await metaFile.text();
      const metadata = JSON.parse(metaText);
      return {
        ...metadata,
        fileId: resolveFileId(metadata.fileId, uploadSessionId),
        localSource: metadata.localSource || deriveFallbackLocalSource(metadata),
      };
    } catch {
      return null;
    }
  }

  private async writePendingMetadata(
    uploadSessionId: string,
    metadata: Omit<PendingUpload, 'fileData'>,
  ): Promise<void> {
    await this.ensureInitialized();

    const uploadDir = await this.rootDir!.getDirectoryHandle(uploadSessionId, {
      create: true,
    });
    const metaFileHandle = await uploadDir.getFileHandle('metadata.json', { create: true });
    const metaWritable = await metaFileHandle.createWritable();
    await metaWritable.write(JSON.stringify(metadata, null, 2));
    await metaWritable.close();
  }

  private revokeLocalObjectUrl(uploadSessionId: string): void {
    this.clearLocalObjectUrlTimer(uploadSessionId);
    const url = this.localObjectUrls.get(uploadSessionId);
    if (!url) {
      return;
    }
    this.localObjectUrls.delete(uploadSessionId);
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(url);
    }
  }

  private scheduleLocalObjectUrlRevoke(uploadSessionId: string): void {
    if (!this.localObjectUrls.has(uploadSessionId)) {
      return;
    }
    this.clearLocalObjectUrlTimer(uploadSessionId);
    const timer = setTimeout(() => {
      this.revokeLocalObjectUrl(uploadSessionId);
    }, OPFSStore.LOCAL_OBJECT_URL_REVOKE_DELAY_MS);
    this.localObjectUrlTimers.set(uploadSessionId, timer);
  }

  private clearLocalObjectUrlTimer(uploadSessionId: string): void {
    const timer = this.localObjectUrlTimers.get(uploadSessionId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.localObjectUrlTimers.delete(uploadSessionId);
  }

  private isPreferredPendingUpload(
    candidate: Omit<PendingUpload, 'fileData'>,
    current: Omit<PendingUpload, 'fileData'>,
  ): boolean {
    const candidateTime = Date.parse(candidate.createdAt);
    const currentTime = Date.parse(current.createdAt);
    if (Number.isFinite(candidateTime) && Number.isFinite(currentTime) && candidateTime !== currentTime) {
      return candidateTime > currentTime;
    }
    if (Number.isFinite(candidateTime) && !Number.isFinite(currentTime)) {
      return true;
    }
    if (!Number.isFinite(candidateTime) && Number.isFinite(currentTime)) {
      return false;
    }
    return candidate.uploadSessionId > current.uploadSessionId;
  }
}

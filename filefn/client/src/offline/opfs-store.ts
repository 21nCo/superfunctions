import type { PendingLocalDescriptor } from '../types.js';
import type { PendingLocalSourceMetadata } from '../preprocessing/types.js';

export interface PendingUpload {
  uploadSessionId: string;
  fileId?: string;
  policy: string;
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

export interface OPFSStoreConfig {
  rootDir?: string;
}

export class OPFSStore {
  private rootDirName: string;
  private rootDir: FileSystemDirectoryHandle | null = null;
  private isInitialized = false;
  private localObjectUrls = new Map<string, string>();

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

    // Store file data
    const dataFileHandle = await uploadDir.getFileHandle('data.bin', { create: true });
    const dataWritable = await dataFileHandle.createWritable();
    await dataWritable.write(upload.fileData);
    await dataWritable.close();

    // Store metadata
    const metadata = {
      uploadSessionId: upload.uploadSessionId,
      fileId: upload.fileId || upload.uploadSessionId,
      policy: upload.policy,
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
        fileId: metadata.fileId || uploadSessionId,
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
    for (const uploadSessionId of uploadSessionIds) {
      const metadata = await this.readPendingMetadata(uploadSessionId);
      if (metadata?.fileId === fileId) {
        return this.getPendingUpload(uploadSessionId);
      }
    }
    return null;
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
      const blob = new Blob([upload.fileData], { type: upload.mimeType });
      url = URL.createObjectURL(blob);
      this.localObjectUrls.set(upload.uploadSessionId, url);
    }
    const resolvedFileId = upload.fileId ?? upload.uploadSessionId;
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
      this.revokeLocalObjectUrl(uploadSessionId);
    }
  }

  /**
   * Increment retry count for a pending upload.
   */
  async incrementRetryCount(uploadSessionId: string): Promise<void> {
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
        fileId: metadata.fileId || uploadSessionId,
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
    const url = this.localObjectUrls.get(uploadSessionId);
    if (!url) {
      return;
    }
    this.localObjectUrls.delete(uploadSessionId);
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(url);
    }
  }
}

export interface PendingUpload {
  uploadSessionId: string;
  policy: string;
  fileName: string;
  size: number;
  mimeType: string;
  fileData: ArrayBuffer;
  metadata?: Record<string, unknown>;
  createdAt: string;
  retryCount: number;
}

export interface OPFSStoreConfig {
  rootDir?: string;
}

export class OPFSStore {
  private rootDirName: string;
  private rootDir: FileSystemDirectoryHandle | null = null;
  private isInitialized = false;

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
      policy: upload.policy,
      fileName: upload.fileName,
      size: upload.size,
      mimeType: upload.mimeType,
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
      const uploadDir = await this.rootDir!.getDirectoryHandle(uploadSessionId);

      // Read metadata
      const metaFileHandle = await uploadDir.getFileHandle('metadata.json');
      const metaFile = await metaFileHandle.getFile();
      const metaText = await metaFile.text();
      const metadata = JSON.parse(metaText);

      // Read file data
      const dataFileHandle = await uploadDir.getFileHandle('data.bin');
      const dataFile = await dataFileHandle.getFile();
      const fileData = await dataFile.arrayBuffer();

      return {
        ...metadata,
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

  /**
   * Delete a pending upload from OPFS.
   */
  async deletePendingUpload(uploadSessionId: string): Promise<void> {
    await this.ensureInitialized();

    try {
      await this.rootDir!.removeEntry(uploadSessionId, { recursive: true });
    } catch (error) {
      // Ignore errors if directory doesn't exist
    }
  }

  /**
   * Increment retry count for a pending upload.
   */
  async incrementRetryCount(uploadSessionId: string): Promise<void> {
    const upload = await this.getPendingUpload(uploadSessionId);
    if (!upload) return;

    upload.retryCount += 1;
    await this.stagePendingUpload(upload);
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
}

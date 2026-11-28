import type { PendingLocalDescriptor } from '../types.js';
import type { PendingLocalSourceMetadata } from '../preprocessing/types.js';
import { createInvalidFileIdError, generateFileId, isValidFileId } from '../upload-manager.js';

/**
 * `metadata.json` layout version. Version 2 records always hold the file ID that
 * replay sends, validated at staging. Records without it come from
 * `@filefn/client` 0.2.0 or earlier, which wrote the session ID as the file ID
 * when none was given.
 */
const PENDING_METADATA_VERSION = 2;

/**
 * File ID of a pending upload staged without one: `file_<uploadSessionId>`.
 * Directory names are unique, so distinct sessions get distinct IDs, and every
 * `offline_<ms>_<base36>` session ID makes a grammar-valid result.
 */
/** The handle lookup proved the record (or one of its files) does not exist. */
function isConfirmedAbsence(error: unknown): boolean {
  return error instanceof Error && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError');
}

function sessionFileId(uploadSessionId: string): string {
  return `file_${uploadSessionId}`;
}

/**
 * The file ID a stored record replays with. A legacy record whose fileId is
 * missing or equals its session ID maps to `file_<uploadSessionId>` without a
 * write. Any other stored value is returned unchanged; if it is not
 * grammar-valid, replay reports `FILEFN_INVALID_FILE_ID` and the record is kept.
 */
function resolveStoredFileId(
  stored: { fileId?: unknown; metadataVersion?: unknown },
  uploadSessionId: string,
): string {
  const fileId = stored.fileId;
  if (typeof fileId !== 'string' || fileId === '') {
    return sessionFileId(uploadSessionId);
  }
  if (stored.metadataVersion !== PENDING_METADATA_VERSION && fileId === uploadSessionId) {
    return sessionFileId(uploadSessionId);
  }
  return fileId;
}

/**
 * Whether a record is an unrewritten legacy record whose file ID comes from the
 * `file_<uploadSessionId>` mapping. Its stored retries were spent sending the
 * old ID, so it reads with `retryCount: 0` and replays with a fresh budget. The
 * first metadata write (a failed replay counts a retry) stamps the current
 * version, so the reset happens once and a later reload does not replenish it.
 */
function isMigratedLegacyRecord(
  stored: { fileId?: unknown; metadataVersion?: unknown },
  uploadSessionId: string,
): boolean {
  if (stored.metadataVersion === PENDING_METADATA_VERSION) {
    return false;
  }
  const fileId = stored.fileId;
  return typeof fileId !== 'string' || fileId === '' || fileId === uploadSessionId;
}

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

export interface OPFSStoreConfig {
  rootDir?: string;
  /** Storage root. Defaults to `navigator.storage.getDirectory()`. */
  getRoot?: () => Promise<FileSystemDirectoryHandle | { getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<unknown> }>;
}

export class OPFSStore {
  private static readonly LOCAL_OBJECT_URL_REVOKE_DELAY_MS = 5 * 60 * 1000;
  private rootDirName: string;
  private getRoot?: OPFSStoreConfig['getRoot'];
  private rootDir: FileSystemDirectoryHandle | null = null;
  private isInitialized = false;
  private localObjectUrls = new Map<string, string>();
  private localObjectUrlTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: OPFSStoreConfig = {}) {
    this.rootDirName = config.rootDir || 'filefn-pending-uploads';
    this.getRoot = config.getRoot;
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

    if (!this.getRoot && !OPFSStore.isSupported()) {
      throw new Error('OPFS is not supported in this environment');
    }

    try {
      const opfsRoot: any = this.getRoot ? await this.getRoot() : await (navigator.storage as any).getDirectory();
      this.rootDir = await opfsRoot.getDirectoryHandle(this.rootDirName, { create: true });
      this.isInitialized = true;
    } catch (error) {
      // Out of storage is kept as it is, so callers can tell it apart (a typed capacity refusal).
      if (error instanceof Error && error.name === 'QuotaExceededError') throw error;
      throw new Error(
        `Failed to initialize OPFS: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Stage a pending upload to OPFS.
   *
   * An explicit `fileId` must match `file_[A-Za-z0-9_-]{8,64}`; otherwise this
   * rejects with `FILEFN_INVALID_FILE_ID` and stages nothing. Without one, the
   * upload gets `file_<uploadSessionId>`, or a generated ID when that is not
   * grammar-valid.
   */
  async stagePendingUpload(upload: PendingUpload): Promise<void> {
    const fileId = this.resolveStagedFileId(upload);
    await this.ensureInitialized();

    const uploadDir = await this.rootDir!.getDirectoryHandle(upload.uploadSessionId, {
      create: true,
    });

    try {
      const dataFileHandle = await uploadDir.getFileHandle('data.bin', { create: true });
      const dataWritable = await dataFileHandle.createWritable();
      await dataWritable.write(upload.fileData);
      await dataWritable.close();

      const metadata: Omit<PendingUpload, 'fileData'> = {
        uploadSessionId: upload.uploadSessionId,
        fileId,
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

      await this.writePendingMetadata(upload.uploadSessionId, metadata);
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
    const resolvedFileId = upload.fileId ?? sessionFileId(upload.uploadSessionId);
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

  /** A pending upload's metadata without its data, or null. */
  async getPendingUploadMetadata(uploadSessionId: string): Promise<Omit<PendingUpload, 'fileData'> | null> {
    await this.ensureInitialized();
    return this.readPendingMetadata(uploadSessionId);
  }

  private async readPendingMetadata(uploadSessionId: string): Promise<Omit<PendingUpload, 'fileData'> | null> {
    try {
      return await this.readPendingMetadataStrict(uploadSessionId);
    } catch {
      return null;
    }
  }

  /**
   * A pending upload with its data, or null only when it is confirmed absent
   * (its directory, metadata or data file does not exist). Any other failure,
   * a transient read error or metadata that does not parse included, throws:
   * it proves nothing about the record. `OfflineQueue.migrateLegacyUpload`
   * reads through this.
   */
  async readPendingUploadConfirmed(uploadSessionId: string): Promise<PendingUpload | null> {
    await this.ensureInitialized();
    try {
      const metadata = await this.readPendingMetadataStrict(uploadSessionId);
      const uploadDir = await this.rootDir!.getDirectoryHandle(uploadSessionId);
      const dataFile = await (await uploadDir.getFileHandle('data.bin')).getFile();
      return { ...metadata, fileData: await dataFile.arrayBuffer() };
    } catch (error) {
      if (isConfirmedAbsence(error)) return null;
      throw error;
    }
  }

  /** Like `readPendingUploadConfirmed`, without the data. */
  async readPendingMetadataConfirmed(uploadSessionId: string): Promise<Omit<PendingUpload, 'fileData'> | null> {
    await this.ensureInitialized();
    try {
      return await this.readPendingMetadataStrict(uploadSessionId);
    } catch (error) {
      if (isConfirmedAbsence(error)) return null;
      throw error;
    }
  }

  private async readPendingMetadataStrict(uploadSessionId: string): Promise<Omit<PendingUpload, 'fileData'>> {
    const uploadDir = await this.rootDir!.getDirectoryHandle(uploadSessionId);
    const metaFileHandle = await uploadDir.getFileHandle('metadata.json');
    const metaFile = await metaFileHandle.getFile();
    const metaText = await metaFile.text();
    const { metadataVersion, ...metadata } = JSON.parse(metaText);
    const stored = { fileId: metadata.fileId, metadataVersion };
    return {
      ...metadata,
      fileId: resolveStoredFileId(stored, uploadSessionId),
      retryCount: isMigratedLegacyRecord(stored, uploadSessionId) ? 0 : metadata.retryCount,
      localSource: metadata.localSource || deriveFallbackLocalSource(metadata),
    };
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
    // Written fileIds are already resolved, so a legacy record rewritten here
    // (for example by incrementRetryCount) keeps the ID it replays with.
    await metaWritable.write(
      JSON.stringify({ ...metadata, metadataVersion: PENDING_METADATA_VERSION }, null, 2),
    );
    await metaWritable.close();
  }

  private resolveStagedFileId(upload: PendingUpload): string {
    if (upload.fileId !== undefined && upload.fileId !== null) {
      if (!isValidFileId(upload.fileId)) {
        throw createInvalidFileIdError(upload.fileId);
      }
      return upload.fileId;
    }
    const derived = sessionFileId(upload.uploadSessionId);
    return isValidFileId(derived) ? derived : generateFileId();
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

import type { Adapter } from '@superfunctions/db';
import type { StorageAdapter } from '@superfunctions/storage';
import type { FileProviderContext } from '@superfunctions/files';
import type { FileFnEventEmitter } from '../events.js';
import type { Logger } from '../observability/logger.js';
import type { QuotaProvider } from '../upload-sessions/service.js';
import * as errors from '../errors.js';
import { createFileDeletedEvent } from '../events.js';

export interface FileRecord {
  fileId: string;
  currentVersionId: string;
  ownerId: string;
  tenantId: string | null;
  visibility: 'private' | 'shared' | 'public';
  policy: string;
  mimeType: string;
  size: number;
  name: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface FileVersionRecord {
  versionId: string;
  fileId: string;
  storageKey: string;
  mimeType: string;
  size: number;
  checksumSha256Base64: string | null;
  createdAt: string;
}

interface FileArtifactRecord {
  artifactId: string;
  fileId: string;
  versionId: string;
  storageKey: string;
  size?: number | null;
}

interface UploadSessionRecord {
  uploadSessionId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'aborted' | 'expired';
  uploadMode: string;
  storageKey: string;
  storageUploadId: string | null;
}

interface UploadPartRecord {
  partNumber: number;
}

interface FilePermissionGrantRecord {
  fileId: string;
  principalId?: string;
  userId?: string;
  tenantId?: string | null;
  canRead?: boolean;
}

export interface Authorizer {
  canRead(file: FileRecord, ctx: FileProviderContext): Promise<boolean>;
  canWrite(file: FileRecord, ctx: FileProviderContext): Promise<boolean>;
  canDelete(file: FileRecord, ctx: FileProviderContext): Promise<boolean>;
}

export interface FileServiceConfig {
  db: Adapter;
  storage: StorageAdapter;
  events: FileFnEventEmitter;
  logger?: Logger;
  quota?: QuotaProvider;
  authorizer?: Authorizer;
  namespace?: string;
  signedUrlTtlSeconds?: number;
}

interface CursorTuple {
  updatedAt: string;
  fileId: string;
}

export type FileReadResult = FileRecord & {
  versionId?: string;
  versionCreatedAt?: string;
  checksumSha256Base64?: string | null;
  storageKey?: string;
};

function createDefaultAuthorizer(): Authorizer {
  return {
    async canRead(file, ctx) {
      if (file.visibility === 'public') return true;
      if (file.ownerId === ctx.principalId) return true;
      if (file.visibility === 'shared' && file.tenantId && file.tenantId === ctx.tenantId) return true;
      return false;
    },
    async canWrite(file, ctx) {
      return file.ownerId === ctx.principalId;
    },
    async canDelete(file, ctx) {
      return file.ownerId === ctx.principalId;
    },
  };
}

function fileSortComparator(a: FileRecord, b: FileRecord): number {
  const aTs = Date.parse(a.updatedAt);
  const bTs = Date.parse(b.updatedAt);
  if (aTs !== bTs) {
    return bTs - aTs; // updatedAt DESC
  }
  return a.fileId.localeCompare(b.fileId); // fileId ASC
}

function encodeCursor(tuple: CursorTuple): string {
  return Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
}

function isAfterCursor(file: FileRecord, cursor: CursorTuple): boolean {
  const fileTs = Date.parse(file.updatedAt);
  const cursorTs = Date.parse(cursor.updatedAt);

  if (fileTs < cursorTs) return true;
  if (fileTs > cursorTs) return false;

  return file.fileId > cursor.fileId;
}

function tryParseCursor(cursor: string): CursorTuple | null {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorTuple>;
    if (typeof decoded.updatedAt === 'string' && typeof decoded.fileId === 'string') {
      return { updatedAt: decoded.updatedAt, fileId: decoded.fileId };
    }
  } catch {
    // Fall through for legacy/plain cursor support.
  }
  return null;
}

function proxyPartKey(storageKey: string, partNumber: number): string {
  return `${storageKey}.part${partNumber}`;
}

export function createFileService(config: FileServiceConfig) {
  const {
    db,
    storage,
    events,
    logger,
    quota,
    authorizer = createDefaultAuthorizer(),
    namespace = 'filefn',
    signedUrlTtlSeconds = 900,
  } = config;

  async function getReadableGrantFileIds(ctx: FileProviderContext): Promise<Set<string>> {
    if (!ctx.principalId) {
      return new Set<string>();
    }

    const findMany = (db as Partial<Adapter>).findMany;
    if (typeof findMany !== 'function') {
      return new Set<string>();
    }

    const grants = await findMany.call(db, {
      model: 'filePermissions',
      where: [],
      namespace,
    }) as FilePermissionGrantRecord[];

    const readable = new Set<string>();
    for (const grant of grants) {
      if (!grant?.canRead) continue;
      if (
        grant.principalId === ctx.principalId ||
        grant.userId === ctx.principalId ||
        (grant.tenantId && grant.tenantId === ctx.tenantId)
      ) {
        readable.add(grant.fileId);
      }
    }

    return readable;
  }

  async function canReadFile(
    file: FileRecord,
    ctx: FileProviderContext,
    readableGrantFileIds?: Set<string>
  ): Promise<boolean> {
    if (await authorizer.canRead(file, ctx)) {
      return true;
    }

    if (readableGrantFileIds?.has(file.fileId)) {
      return true;
    }

    return false;
  }

  async function getVersionChecked(fileId: string, versionId: string): Promise<FileVersionRecord> {
    const version = await db.findOne<FileVersionRecord>({
      model: 'fileVersions',
      where: [{ field: 'versionId', operator: 'eq', value: versionId }],
      namespace,
    });

    if (!version) {
      throw errors.notFound('Version');
    }

    if (version.fileId !== fileId) {
      throw errors.notFound('Version');
    }

    return version;
  }

  return {
    async getFile(fileId: string, ctx: FileProviderContext, versionId?: string): Promise<FileReadResult> {
      const file = await db.findOne<FileRecord>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      if (!file) {
        throw errors.notFound('File');
      }

      const readableGrantFileIds = await getReadableGrantFileIds(ctx);
      const canRead = await canReadFile(file, ctx, readableGrantFileIds);
      if (!canRead) {
        throw errors.forbidden();
      }

      if (!versionId) {
        return file;
      }

      const version = await getVersionChecked(fileId, versionId);

      return {
        ...file,
        currentVersionId: version.versionId,
        mimeType: version.mimeType,
        size: version.size,
        versionId: version.versionId,
        versionCreatedAt: version.createdAt,
        checksumSha256Base64: version.checksumSha256Base64,
        storageKey: version.storageKey,
      };
    },

    async listFiles(ctx: FileProviderContext, options: { cursor?: string; limit?: number } = {}): Promise<{
      files: FileRecord[];
      nextCursor?: string;
    }> {
      const requested = typeof options.limit === 'number' && Number.isFinite(options.limit)
        ? Math.floor(options.limit)
        : 20;
      const limit = Math.min(100, Math.max(1, requested));

      const allFiles = await db.findMany<FileRecord>({
        model: 'files',
        where: [],
        namespace,
      });

      const readableGrantFileIds = await getReadableGrantFileIds(ctx);
      const readableFiles: FileRecord[] = [];
      for (const file of allFiles) {
        if (await canReadFile(file, ctx, readableGrantFileIds)) {
          readableFiles.push(file);
        }
      }

      readableFiles.sort(fileSortComparator);

      let paged = readableFiles;
      if (options.cursor) {
        const tupleCursor = tryParseCursor(options.cursor);
        if (tupleCursor) {
          paged = readableFiles.filter((file) => isAfterCursor(file, tupleCursor));
        } else {
          // Legacy cursor support: plain fileId cursor from previous implementation.
          const legacyAnchor = readableFiles.find((file) => file.fileId === options.cursor);
          if (legacyAnchor) {
            const legacyTuple: CursorTuple = {
              updatedAt: legacyAnchor.updatedAt,
              fileId: legacyAnchor.fileId,
            };
            paged = readableFiles.filter((file) => isAfterCursor(file, legacyTuple));
          }
        }
      }

      const files = paged.slice(0, limit);
      const hasMore = paged.length > limit;

      return {
        files,
        nextCursor: hasMore && files.length > 0
          ? encodeCursor({ updatedAt: files[files.length - 1].updatedAt, fileId: files[files.length - 1].fileId })
          : undefined,
      };
    },

    async getDownloadUrl(fileId: string, versionId: string | undefined, ctx: FileProviderContext): Promise<{
      url: string;
      headers?: Record<string, string>;
    }> {
      const file = await this.getFile(fileId, ctx);
      const targetVersionId = versionId || file.currentVersionId;
      const version = await getVersionChecked(fileId, targetVersionId);

      if (storage.capabilities.signedDownloadUrls && storage.signDownloadUrl) {
        const result = await storage.signDownloadUrl({
          key: version.storageKey,
          expiresInSeconds: signedUrlTtlSeconds,
        });
        return { url: result.url, headers: result.headers };
      }

      const proxyUrl = versionId
        ? `/proxy/files/${fileId}/versions/${versionId}/download`
        : `/proxy/files/${fileId}/download`;

      return { url: proxyUrl };
    },

    async getDownloadStream(fileId: string, versionId: string | undefined, ctx: FileProviderContext): Promise<{
      stream: ReadableStream;
      contentType: string;
      size: number;
    }> {
      const file = await this.getFile(fileId, ctx);
      const targetVersionId = versionId || file.currentVersionId;
      const version = await getVersionChecked(fileId, targetVersionId);

      if (!storage.openDownloadStream) {
        throw new Error('Storage adapter does not support streaming');
      }

      const stream = await storage.openDownloadStream({ key: version.storageKey });
      return {
        stream: stream as unknown as ReadableStream,
        contentType: version.mimeType,
        size: version.size,
      };
    },

    async deleteFile(fileId: string, ctx: FileProviderContext): Promise<void> {
      const file = await db.findOne<FileRecord>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      if (!file) {
        throw errors.notFound('File');
      }

      const canDelete = await authorizer.canDelete(file, ctx);
      if (!canDelete) {
        throw errors.forbidden();
      }

      const versions = await db.findMany<FileVersionRecord>({
        model: 'fileVersions',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      const artifacts = await db.findMany<FileArtifactRecord>({
        model: 'fileArtifacts',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      const pendingSessions = await db.findMany<UploadSessionRecord>({
        model: 'uploadSessions',
        where: [
          { field: 'fileId', operator: 'eq', value: fileId },
          { field: 'status', operator: 'ne', value: 'completed' },
        ],
        namespace,
      });

      for (const session of pendingSessions) {
        if (session.storageUploadId && storage.abortMultipartUpload) {
          try {
            await storage.abortMultipartUpload({
              key: session.storageKey,
              uploadId: session.storageUploadId,
            });
          } catch {
            // Best-effort abort for stale multipart uploads.
          }
        }

        const parts = await db.findMany<UploadPartRecord>({
          model: 'uploadParts',
          where: [{ field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId }],
          select: ['partNumber'],
          namespace,
        });

        if (session.uploadMode === 'proxy') {
          for (const part of parts) {
            try {
              await storage.deleteObject({ key: proxyPartKey(session.storageKey, part.partNumber) });
            } catch {
              // Best-effort cleanup for proxy temp parts.
            }
          }
        }

        await db.deleteMany({
          model: 'uploadParts',
          where: [{ field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId }],
          namespace,
        });
      }

      const versionBytesByStorageKey = new Map<string, number>();
      for (const version of versions) {
        const existing = versionBytesByStorageKey.get(version.storageKey) ?? 0;
        versionBytesByStorageKey.set(version.storageKey, Math.max(existing, version.size));
      }

      const candidateStorageKeys = new Set<string>();
      for (const version of versions) {
        candidateStorageKeys.add(version.storageKey);
      }
      for (const artifact of artifacts) {
        candidateStorageKeys.add(artifact.storageKey);
      }

      const storageKeysReferencedElsewhere = new Set<string>();
      if (candidateStorageKeys.size > 0) {
        const allVersions = await db.findMany<Pick<FileVersionRecord, 'fileId' | 'storageKey'>>({
          model: 'fileVersions',
          where: [],
          select: ['fileId', 'storageKey'],
          namespace,
        });

        for (const version of allVersions) {
          if (version.fileId !== fileId && candidateStorageKeys.has(version.storageKey)) {
            storageKeysReferencedElsewhere.add(version.storageKey);
          }
        }

        const allArtifacts = await db.findMany<Pick<FileArtifactRecord, 'fileId' | 'storageKey'>>({
          model: 'fileArtifacts',
          where: [],
          select: ['fileId', 'storageKey'],
          namespace,
        });

        for (const artifact of allArtifacts) {
          if (artifact.fileId !== fileId && candidateStorageKeys.has(artifact.storageKey)) {
            storageKeysReferencedElsewhere.add(artifact.storageKey);
          }
        }
      }

      await db.deleteMany({
        model: 'filePermissions',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      await db.deleteMany({
        model: 'fileShares',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      await db.deleteMany({
        model: 'fileArtifacts',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      await db.deleteMany({
        model: 'fileVersions',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      await db.deleteMany({
        model: 'uploadSessions',
        where: [
          { field: 'fileId', operator: 'eq', value: fileId },
          { field: 'status', operator: 'ne', value: 'completed' },
        ],
        namespace,
      });

      await db.delete({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      let totalBytesFreed = 0;
      for (const storageKey of candidateStorageKeys) {
        if (storageKeysReferencedElsewhere.has(storageKey)) {
          continue;
        }
        try {
          await storage.deleteObject({ key: storageKey });
          totalBytesFreed += versionBytesByStorageKey.get(storageKey) ?? 0;
        } catch {
          // Continue on storage errors (object may already be deleted)
        }
      }

      if (quota && totalBytesFreed > 0) {
        await quota.recordUsage({
          principalId: file.ownerId,
          tenantId: file.tenantId ?? undefined,
          bytes: -totalBytesFreed,
        });
      }

      events.emit('file:deleted', createFileDeletedEvent({
        fileId,
        ownerId: file.ownerId,
        tenantId: file.tenantId || undefined,
      }, ctx.requestId));

      logger?.info('File deleted', {
        fileId,
        ownerId: file.ownerId,
        tenantId: file.tenantId,
        requestId: ctx.requestId,
      });
    },

    async listVersions(fileId: string, ctx: FileProviderContext): Promise<{ versions: FileVersionRecord[] }> {
      await this.getFile(fileId, ctx);

      const versions = await db.findMany<FileVersionRecord>({
        model: 'fileVersions',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        orderBy: [{ field: 'createdAt', direction: 'desc' }],
        namespace,
      });

      return { versions };
    },

    async canWriteFile(fileId: string, ctx: FileProviderContext): Promise<boolean> {
      const file = await db.findOne<FileRecord>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      if (!file) {
        return true;
      }

      return authorizer.canWrite(file, ctx);
    },

    async getVersion(fileId: string, versionId: string, ctx: FileProviderContext): Promise<FileVersionRecord & { fileId: string }> {
      await this.getFile(fileId, ctx);
      const version = await getVersionChecked(fileId, versionId);
      return { ...version, fileId };
    },

    async getDownloadUrlWithBinding(fileId: string, versionId: string, ctx: FileProviderContext): Promise<{
      url: string;
      headers?: Record<string, string>;
    }> {
      return this.getDownloadUrl(fileId, versionId, ctx);
    },
  };
}

export type FileService = ReturnType<typeof createFileService>;

import type { Adapter, WhereClause } from '@superfunctions/db';
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

  return {
    async getFile(fileId: string, ctx: FileProviderContext): Promise<FileRecord> {
      const file = await db.findOne<FileRecord>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      if (!file) {
        throw errors.notFound('File');
      }

      const canRead = await authorizer.canRead(file, ctx);
      if (!canRead) {
        throw errors.forbidden();
      }

      return file;
    },

    async listFiles(ctx: FileProviderContext, options: { cursor?: string; limit?: number } = {}): Promise<{
      files: FileRecord[];
      nextCursor?: string;
    }> {
      const limit = options.limit || 20;

      // Fetch all files and filter by accessibility
      // A file is accessible if:
      // 1. Owned by the principal
      // 2. Visibility is 'public'
      // 3. Visibility is 'shared' and same tenant
      // 4. Principal has an explicit grant

      const allFiles = await db.findMany<FileRecord>({
        model: 'files',
        where: [],
        limit: 1000, // Fetch more to allow filtering
        namespace,
      });

      // Get all grants for this principal
      let grantedFileIds: Set<string> = new Set();
      if (ctx.principalId) {
        const grants = await db.findMany<{ fileId: string; canRead: boolean }>({
          model: 'filePermissions',
          where: [],
          namespace,
        });

        for (const grant of grants) {
          // Check if grant applies to this principal
          const grantRecord = grant as any;
          if (grantRecord.canRead) {
            if (grantRecord.principalId === ctx.principalId ||
                grantRecord.userId === ctx.principalId ||
                (grantRecord.tenantId && grantRecord.tenantId === ctx.tenantId)) {
              grantedFileIds.add(grantRecord.fileId);
            }
          }
        }
      }

      // Filter files based on accessibility
      const accessibleFiles = allFiles.filter(file => {
        // Owned by principal
        if (ctx.principalId && file.ownerId === ctx.principalId) return true;
        // Public visibility
        if (file.visibility === 'public') return true;
        // Shared visibility within same tenant
        if (file.visibility === 'shared' && file.tenantId && ctx.tenantId && file.tenantId === ctx.tenantId) return true;
        // Explicit grant
        if (grantedFileIds.has(file.fileId)) return true;
        return false;
      });

      const hasMore = accessibleFiles.length > limit;
      const resultFiles = hasMore ? accessibleFiles.slice(0, limit) : accessibleFiles;

      return {
        files: resultFiles,
        nextCursor: hasMore ? resultFiles[resultFiles.length - 1].fileId : undefined,
      };
    },

    async getDownloadUrl(fileId: string, versionId: string | undefined, ctx: FileProviderContext): Promise<{
      url: string;
      headers?: Record<string, string>;
    }> {
      const file = await db.findOne<FileRecord>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      if (!file) {
        throw errors.notFound('File');
      }

      const canRead = await authorizer.canRead(file, ctx);
      if (!canRead) {
        throw errors.forbidden();
      }

      const targetVersionId = versionId || file.currentVersionId;
      const version = await db.findOne<FileVersionRecord>({
        model: 'fileVersions',
        where: [{ field: 'versionId', operator: 'eq', value: targetVersionId }],
        namespace,
      });

      if (!version) {
        throw errors.notFound('Version');
      }

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
        const file = await db.findOne<FileRecord>({
            model: 'files',
            where: [{ field: 'fileId', operator: 'eq', value: fileId }],
            namespace,
        });

        if (!file) throw errors.notFound('File');

        const canRead = await authorizer.canRead(file, ctx);
        if (!canRead) throw errors.forbidden();

        const targetVersionId = versionId || file.currentVersionId;
        const version = await db.findOne<FileVersionRecord>({
            model: 'fileVersions',
            where: [{ field: 'versionId', operator: 'eq', value: targetVersionId }],
            namespace,
        });

        if (!version) throw errors.notFound('Version');
        if (versionId && version.fileId !== fileId) throw errors.notFound('Version');

        if (!storage.openDownloadStream) {
            throw new Error('Storage adapter does not support streaming');
        }

        const stream = await storage.openDownloadStream({ key: version.storageKey });
        
        return { 
            stream: stream as unknown as ReadableStream, // Cast assuming storage returns compatible stream
            contentType: version.mimeType,
            size: version.size
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

      let totalBytesFreed = 0;

      for (const version of versions) {
        try {
          await storage.deleteObject({ key: version.storageKey });
          totalBytesFreed += version.size;
        } catch {
          // Continue on storage errors (object may already be deleted)
        }
      }

      await db.deleteMany({
        model: 'fileVersions',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      await db.delete({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      if (quota && totalBytesFreed > 0) {
        await quota.recordUsage({
          principalId: ctx.principalId,
          tenantId: ctx.tenantId,
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

    async listVersions(fileId: string, ctx: FileProviderContext): Promise<{
      versions: FileVersionRecord[];
    }> {
      const file = await db.findOne<FileRecord>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      if (!file) {
        throw errors.notFound('File');
      }

      const canRead = await authorizer.canRead(file, ctx);
      if (!canRead) {
        throw errors.forbidden();
      }

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
      const file = await db.findOne<FileRecord>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      if (!file) {
        throw errors.notFound('File');
      }

      const canRead = await authorizer.canRead(file, ctx);
      if (!canRead) {
        throw errors.forbidden();
      }

      const version = await db.findOne<FileVersionRecord>({
        model: 'fileVersions',
        where: [{ field: 'versionId', operator: 'eq', value: versionId }],
        namespace,
      });

      if (!version) {
        throw errors.notFound('Version');
      }

      // Binding check: version must belong to the specified file
      if (version.fileId !== fileId) {
        throw errors.notFound('Version');
      }

      return { ...version, fileId };
    },

    async getDownloadUrlWithBinding(fileId: string, versionId: string, ctx: FileProviderContext): Promise<{
      url: string;
      headers?: Record<string, string>;
    }> {
      const file = await db.findOne<FileRecord>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      if (!file) {
        throw errors.notFound('File');
      }

      const canRead = await authorizer.canRead(file, ctx);
      if (!canRead) {
        throw errors.forbidden();
      }

      const version = await db.findOne<FileVersionRecord>({
        model: 'fileVersions',
        where: [{ field: 'versionId', operator: 'eq', value: versionId }],
        namespace,
      });

      if (!version) {
        throw errors.notFound('Version');
      }

      // Binding check: version must belong to the specified file
      if (version.fileId !== fileId) {
        throw errors.notFound('Version');
      }

      if (storage.capabilities.signedDownloadUrls && storage.signDownloadUrl) {
        const result = await storage.signDownloadUrl({
          key: version.storageKey,
          expiresInSeconds: signedUrlTtlSeconds,
        });
        return { url: result.url, headers: result.headers };
      }

      return { url: `/proxy/files/${fileId}/versions/${versionId}/download` };
    },
  };
}

export type FileService = ReturnType<typeof createFileService>;

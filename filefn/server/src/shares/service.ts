import type { Adapter } from '@superfunctions/db';
import type { StorageAdapter } from '@superfunctions/storage';
import type { FileProviderContext } from '@superfunctions/files';
import type { FileRecord, FileVersionRecord } from '../files/service.js';
import { createHash, randomBytes } from 'crypto';
import * as errors from '../errors.js';

export interface FileShareRecord {
  tokenHash: string;
  fileId: string;
  versionId: string | null;
  expiresAt: string | null;
  requiresAuth: boolean;
  maxDownloads: number | null;
  downloads: number;
  createdAt: string;
  revokedAt: string | null;
}

export interface SharesServiceConfig {
  db: Adapter;
  storage: StorageAdapter;
  namespace?: string;
  signedUrlTtlSeconds?: number;
}

export interface CreateShareLinkInput {
  fileId: string;
  versionId?: string;
  expiresAt?: string;
  requiresAuth?: boolean;
  maxDownloads?: number;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function createSharesService(config: SharesServiceConfig) {
  const { db, storage, namespace = 'filefn', signedUrlTtlSeconds = 900 } = config;

  async function getFile(fileId: string): Promise<FileRecord | null> {
    return db.findOne<FileRecord>({
      model: 'files',
      where: [{ field: 'fileId', operator: 'eq', value: fileId }],
      namespace,
    });
  }

  async function canShareFile(file: FileRecord, ctx: FileProviderContext): Promise<boolean> {
    return file.ownerId === ctx.principalId;
  }

  return {
    async createShareLink(
      input: CreateShareLinkInput,
      ctx: FileProviderContext
    ): Promise<{ token: string; expiresAt: string | null }> {
      const file = await getFile(input.fileId);
      if (!file) {
        throw errors.notFound('File');
      }

      const canShare = await canShareFile(file, ctx);
      if (!canShare) {
        throw errors.forbidden();
      }

      const token = generateToken();
      const tokenHash = hashToken(token);

      const share: FileShareRecord = {
        tokenHash,
        fileId: input.fileId,
        versionId: input.versionId || null,
        expiresAt: input.expiresAt || null,
        requiresAuth: input.requiresAuth ?? false,
        maxDownloads: input.maxDownloads ?? null,
        downloads: 0,
        createdAt: new Date().toISOString(),
        revokedAt: null,
      };

      await db.create({
        model: 'fileShares',
        data: share,
        namespace,
      });

      return { token, expiresAt: share.expiresAt };
    },

    async downloadViaShareLink(
      token: string,
      ctx: FileProviderContext & { isAuthenticated?: boolean }
    ): Promise<{ url: string; headers?: Record<string, string>; fileName: string; mimeType: string }> {
      const tokenHash = hashToken(token);

      const share = await db.findOne<FileShareRecord>({
        model: 'fileShares',
        where: [{ field: 'tokenHash', operator: 'eq', value: tokenHash }],
        namespace,
      });

      if (!share) {
        throw errors.shareNotFound();
      }

      if (share.revokedAt) {
        throw errors.shareRevoked();
      }

      const now = new Date().toISOString();
      if (share.expiresAt && share.expiresAt < now) {
        throw errors.shareExpired();
      }

      if (share.maxDownloads !== null && share.downloads >= share.maxDownloads) {
        throw errors.shareDownloadsExceeded();
      }

      if (share.requiresAuth && !ctx.isAuthenticated) {
        throw errors.authRequired();
      }

      const file = await getFile(share.fileId);
      if (!file) {
        throw errors.shareNotFound();
      }

      const versionId = share.versionId || file.currentVersionId;
      const version = await db.findOne<FileVersionRecord>({
        model: 'fileVersions',
        where: [{ field: 'versionId', operator: 'eq', value: versionId }],
        namespace,
      });

      if (!version) {
        throw errors.notFound('Version');
      }

      await db.update({
        model: 'fileShares',
        where: [{ field: 'tokenHash', operator: 'eq', value: tokenHash }],
        data: { downloads: share.downloads + 1 },
        namespace,
      });

      if (storage.capabilities.signedDownloadUrls && storage.signDownloadUrl) {
        const result = await storage.signDownloadUrl({
          key: version.storageKey,
          expiresInSeconds: signedUrlTtlSeconds,
        });
        return { url: result.url, headers: result.headers, fileName: file.name, mimeType: file.mimeType };
      }

      return { url: `proxy://${version.storageKey}`, fileName: file.name, mimeType: file.mimeType };
    },

    async revokeShareLink(fileId: string, token: string, ctx: FileProviderContext): Promise<void> {
      const file = await getFile(fileId);
      if (!file) {
        throw errors.notFound('File');
      }

      const canShare = await canShareFile(file, ctx);
      if (!canShare) {
        throw errors.forbidden();
      }

      const tokenHash = hashToken(token);

      const share = await db.findOne<FileShareRecord>({
        model: 'fileShares',
        where: [
          { field: 'tokenHash', operator: 'eq', value: tokenHash },
          { field: 'fileId', operator: 'eq', value: fileId },
        ],
        namespace,
      });

      if (!share) {
        throw errors.shareNotFound();
      }

      await db.update({
        model: 'fileShares',
        where: [{ field: 'tokenHash', operator: 'eq', value: tokenHash }],
        data: { revokedAt: new Date().toISOString() },
        namespace,
      });
    },

    async listShareLinks(fileId: string, ctx: FileProviderContext): Promise<Array<Omit<FileShareRecord, 'tokenHash'> & { tokenHashPrefix: string }>> {
      const file = await getFile(fileId);
      if (!file) {
        throw errors.notFound('File');
      }

      const canShare = await canShareFile(file, ctx);
      if (!canShare) {
        throw errors.forbidden();
      }

      const shares = await db.findMany<FileShareRecord>({
        model: 'fileShares',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      return shares.map(share => ({
        tokenHashPrefix: share.tokenHash.substring(0, 8),
        fileId: share.fileId,
        versionId: share.versionId,
        expiresAt: share.expiresAt,
        requiresAuth: share.requiresAuth,
        maxDownloads: share.maxDownloads,
        downloads: share.downloads,
        createdAt: share.createdAt,
        revokedAt: share.revokedAt,
      }));
    },
  };
}

export type SharesService = ReturnType<typeof createSharesService>;

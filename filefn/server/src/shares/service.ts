import type { Adapter } from '@superfunctions/db';
import { getStorageCapabilities, type StorageAdapter } from '@superfunctions/storage';
import type { FileProviderContext } from '@superfunctions/files';
import type { FileRecord, FileVersionRecord } from '../files/service.js';
import { resolveStorageTarget, type PolicyRegistry } from '../policies.js';
import { createHash, randomBytes } from 'crypto';
import * as errors from '../errors.js';
import { isGrantExpired } from '../authz/grant-expiry.js';

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

interface FilePermissionRecord {
  fileId: string;
  userId?: string | null;
  tenantId?: string | null;
  canShare?: boolean;
  expiresAt?: string | null;
}

export interface SharesServiceConfig {
  db: Adapter;
  storage: StorageAdapter;
  policies?: Pick<PolicyRegistry, 'get'>;
  namespace?: string;
  signedUrlTtlSeconds?: number;
  /** Host limits on share links; see `FileFnConfig.shares`. */
  options?: ShareLinkOptions;
}

export interface ShareLinkOptions {
  /** Every new link requires the downloader to be signed in. */
  requireAuth?: boolean;
  /**
   * Longest lifetime a link may have. A link created without `expiresAt` gets
   * this lifetime; a later `expiresAt` is refused.
   */
  maxTtlSeconds?: number;
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
  const { db, storage, policies, namespace = 'filefn', signedUrlTtlSeconds = 900, options = {} } = config;
  if (
    options.maxTtlSeconds !== undefined &&
    (!Number.isSafeInteger(options.maxTtlSeconds) || options.maxTtlSeconds < 1)
  ) {
    throw new Error('shares.maxTtlSeconds must be a positive integer');
  }

  function validateShareInput(input: CreateShareLinkInput): { expiresAt: string | null; maxDownloads: number | null; requiresAuth: boolean } {
    if (input.versionId !== undefined && input.versionId !== null && (typeof input.versionId !== 'string' || input.versionId.length === 0)) {
      throw errors.invalidRequest('versionId must be a version ID', { field: 'versionId' });
    }
    if (input.requiresAuth !== undefined && input.requiresAuth !== null && typeof input.requiresAuth !== 'boolean') {
      throw errors.invalidRequest('requiresAuth must be a boolean', { field: 'requiresAuth' });
    }
    let maxDownloads: number | null = null;
    if (input.maxDownloads !== undefined && input.maxDownloads !== null) {
      if (!Number.isSafeInteger(input.maxDownloads) || input.maxDownloads < 1) {
        throw errors.invalidRequest('maxDownloads must be a positive integer', { field: 'maxDownloads' });
      }
      maxDownloads = input.maxDownloads;
    }
    const now = Date.now();
    let expiresAtMs: number | null = null;
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      expiresAtMs = typeof input.expiresAt === 'string' ? Date.parse(input.expiresAt) : Number.NaN;
      if (!Number.isFinite(expiresAtMs)) {
        throw errors.invalidRequest('expiresAt must be an ISO 8601 date-time', { field: 'expiresAt' });
      }
      if (expiresAtMs <= now) {
        throw errors.invalidRequest('expiresAt must be in the future', { field: 'expiresAt' });
      }
    }
    if (options.maxTtlSeconds !== undefined) {
      const latest = now + options.maxTtlSeconds * 1000;
      if (expiresAtMs === null) {
        expiresAtMs = latest;
      } else if (expiresAtMs > latest) {
        throw errors.invalidRequest(`expiresAt may be at most ${options.maxTtlSeconds} seconds away`, {
          field: 'expiresAt',
          maxTtlSeconds: options.maxTtlSeconds,
        });
      }
    }
    return {
      expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
      maxDownloads,
      requiresAuth: options.requireAuth === true || input.requiresAuth === true,
    };
  }

  async function getFile(fileId: string): Promise<FileRecord | null> {
    return db.findOne<FileRecord>({
      model: 'files',
      where: [{ field: 'fileId', operator: 'eq', value: fileId }],
      namespace,
    });
  }

  async function canShareFile(file: FileRecord, ctx: FileProviderContext): Promise<boolean> {
    if (file.ownerId === ctx.principalId) {
      return true;
    }
    if (!ctx.principalId) {
      return false;
    }

    const grants = await db.findMany<FilePermissionRecord>({
      model: 'filePermissions',
      where: [{ field: 'fileId', operator: 'eq', value: file.fileId }],
      namespace,
    });

    return grants.some((grant) => {
      if (!grant?.canShare || isGrantExpired(grant.expiresAt)) {
        return false;
      }
      return grant.userId === ctx.principalId || (grant.tenantId && grant.tenantId === ctx.tenantId);
    });
  }

  async function readShare(tokenHash: string): Promise<FileShareRecord | null> {
    return db.findOne<FileShareRecord>({
      model: 'fileShares',
      where: [{ field: 'tokenHash', operator: 'eq', value: tokenHash }],
      namespace,
    });
  }

  function assertShareUsable(share: FileShareRecord, ctx: { isAuthenticated?: boolean }): void {
    if (share.revokedAt) {
      throw errors.shareRevoked();
    }
    // Compared as instants: a stored value that does not parse counts as expired.
    if (share.expiresAt) {
      const expiresAtMs = Date.parse(share.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        throw errors.shareExpired();
      }
    }
    if (share.maxDownloads !== null && share.maxDownloads !== undefined && share.downloads >= share.maxDownloads) {
      throw errors.shareDownloadsExceeded();
    }
    if (share.requiresAuth && !ctx.isAuthenticated) {
      throw errors.authRequired();
    }
  }

  /**
   * Counts one download before any byte or URL is handed out. The write is
   * conditional on the count read, so concurrent downloads can never exceed
   * `maxDownloads`; a lost race re-reads the link and checks it again.
   */
  async function reserveDownload(
    tokenHash: string,
    share: FileShareRecord,
    ctx: { isAuthenticated?: boolean },
  ): Promise<void> {
    let current = share;
    for (let attempt = 0; attempt < 20; attempt++) {
      assertShareUsable(current, ctx);
      let updated: unknown = null;
      try {
        updated = await db.update({
          model: 'fileShares',
          where: [
            { field: 'tokenHash', operator: 'eq', value: tokenHash },
            { field: 'downloads', operator: 'eq', value: current.downloads },
          ],
          data: { downloads: current.downloads + 1 },
          namespace,
        });
      } catch {
        updated = null;
      }
      if (updated) return;
      const reread = await readShare(tokenHash);
      if (!reread) throw errors.shareNotFound();
      current = reread;
    }
    throw new errors.FileFnError(
      errors.ErrorCodes.SHARE_DOWNLOADS_EXCEEDED,
      'Too many concurrent downloads of this share link; retry',
      409,
      { retryable: true },
    );
  }

  async function resolveDownload(
    token: string,
    ctx: FileProviderContext & { isAuthenticated?: boolean },
  ): Promise<{ tokenHash: string; share: FileShareRecord; file: FileRecord; version: FileVersionRecord }> {
    const tokenHash = hashToken(token);

    const share = await readShare(tokenHash);

    if (!share) {
      throw errors.shareNotFound();
    }

    assertShareUsable(share, ctx);

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

    if (!version || version.fileId !== file.fileId) {
      throw errors.notFound('Version');
    }

    return { tokenHash, share, file, version };
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

      const limits = validateShareInput(input);
      if (input.versionId) {
        const version = await db.findOne<FileVersionRecord>({
          model: 'fileVersions',
          where: [{ field: 'versionId', operator: 'eq', value: input.versionId }],
          namespace,
        });
        if (!version || version.fileId !== file.fileId) {
          throw errors.notFound('Version');
        }
      }

      const token = generateToken();
      const tokenHash = hashToken(token);

      const share: FileShareRecord = {
        tokenHash,
        fileId: input.fileId,
        versionId: input.versionId || null,
        expiresAt: limits.expiresAt,
        requiresAuth: limits.requiresAuth,
        maxDownloads: limits.maxDownloads,
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
      const { tokenHash, share, file, version } = await resolveDownload(token, ctx);
      const storageTarget = resolveStorageTarget(policies?.get(file.policy) ?? {});

      if (getStorageCapabilities(storage, storageTarget).signedDownloadUrls && storage.signDownloadUrl) {
        await reserveDownload(tokenHash, share, ctx);
        const result = await storage.signDownloadUrl({
          key: version.storageKey,
          target: storageTarget,
          expiresInSeconds: signedUrlTtlSeconds,
        });
        return { url: result.url, headers: result.headers, fileName: file.name, mimeType: file.mimeType };
      }

      return {
        url: `/proxy/share-links/${encodeURIComponent(token)}/download`,
        fileName: file.name,
        mimeType: file.mimeType,
      };
    },

    async getDownloadStreamViaShareLink(
      token: string,
      ctx: FileProviderContext & { isAuthenticated?: boolean },
    ): Promise<{ stream: ReadableStream; contentType: string; size: number; fileName: string; mimeType: string }> {
      const { tokenHash, share, file, version } = await resolveDownload(token, ctx);
      const storageTarget = resolveStorageTarget(policies?.get(file.policy) ?? {});

      if (!storage.openDownloadStream) {
        throw new Error('Storage adapter does not support streaming');
      }

      await reserveDownload(tokenHash, share, ctx);
      const stream = await storage.openDownloadStream({ key: version.storageKey, target: storageTarget });

      return {
        stream: stream as unknown as ReadableStream,
        contentType: version.mimeType,
        size: version.size,
        fileName: file.name,
        mimeType: file.mimeType,
      };
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

    async listShareLinks(
      fileId: string,
      ctx: FileProviderContext,
      page?: { limit?: number; offset?: number },
    ): Promise<Array<Omit<FileShareRecord, 'tokenHash'> & { tokenHashPrefix: string }>> {
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
        orderBy: [
          { field: 'createdAt', direction: 'desc' },
          { field: 'tokenHash', direction: 'desc' },
        ],
        limit: page?.limit,
        offset: page?.offset,
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

import type { Adapter } from '@superfunctions/db';
import { getStorageCapabilities, type StorageAdapter } from '@superfunctions/storage';
import type { FileProviderContext } from '@superfunctions/files';
import type { FileRecord, FileVersionRecord } from '../files/service.js';
import { resolveStorageTarget, type PolicyRegistry } from '../policies.js';
import { createHash, randomBytes } from 'crypto';
import { signedDownloadConstraints } from '../download-headers.js';
import * as errors from '../errors.js';
import { isGrantExpired, parseIsoInstant } from '../authz/grant-expiry.js';
import { isAnonymousContext, isFileOwner } from '../authz/ownership.js';

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
  role?: string | null;
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


/** Longest `shares.maxTtlSeconds` (100 years), so every expiry stays within years 0001-9999. */
const MAX_SHARE_TTL_SECONDS = 100 * 365 * 24 * 60 * 60;

// Share rows written before expiries were normalized hold the caller's text,
// which older servers compared as a string with the current UTC ISO time, so
// an offset was in effect ignored. The earlier of that reading and the parsed
// instant applies: no stored link outlives the deadline it had.
const TRAILING_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/;
function shareDeadline(expiresAt: string): number | null {
  const parsed = parseIsoInstant(expiresAt, 'utc');
  if (parsed === null) return null;
  const legacy = parseIsoInstant(expiresAt.replace(TRAILING_ZONE, ''), 'utc');
  return legacy === null ? parsed : Math.min(parsed, legacy);
}

/** Whether a share link's `expiresAt` has passed; a malformed value counts as expired. */
function isShareExpired(expiresAt: string | null | undefined): boolean {
  if (expiresAt === null || expiresAt === undefined || expiresAt === '') return false;
  const deadline = shareDeadline(expiresAt);
  return deadline === null || deadline <= Date.now();
}

export function createSharesService(config: SharesServiceConfig) {
  const { db, storage, policies, namespace = 'filefn', signedUrlTtlSeconds = 900, options = {} } = config;
  if (
    options.maxTtlSeconds !== undefined &&
    (!Number.isSafeInteger(options.maxTtlSeconds) || options.maxTtlSeconds < 1 || options.maxTtlSeconds > MAX_SHARE_TTL_SECONDS)
  ) {
    throw new Error(`shares.maxTtlSeconds must be a positive integer of at most ${MAX_SHARE_TTL_SECONDS}`);
  }

  function validateShareInput(input: CreateShareLinkInput): { expiresAt: string | null; maxDownloads: number | null; requiresAuth: boolean } {
    // An empty versionId means the current version, as it always has (and as
    // the Python server reads it).
    if (input.versionId !== undefined && input.versionId !== null && typeof input.versionId !== 'string') {
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
    // An empty string means no expiry, as it always has.
    if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== '') {
      expiresAtMs = parseIsoInstant(input.expiresAt, 'utc');
      if (expiresAtMs === null) {
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

  // `allowRoleGrants`: role grants count only for creating links; revoking or
  // listing keeps the owner/user/tenant rule.
  async function canShareFile(file: FileRecord, ctx: FileProviderContext, allowRoleGrants = false): Promise<boolean> {
    if (isFileOwner(file, ctx)) {
      return true;
    }
    if (isAnonymousContext(ctx)) {
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
      if (grant.userId === ctx.principalId || (grant.tenantId && grant.tenantId === ctx.tenantId)) return true;
      // A role grant, like an admin role, applies only within the file's tenant.
      if (!allowRoleGrants) return false;
      const roles = (ctx as { roles?: string[] }).roles;
      return Boolean(grant.role && roles?.includes(grant.role) && (file.tenantId || null) === (ctx.tenantId || null));
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
    // Compared as instants: a stored value that is not an ISO 8601 date-time counts as expired.
    if (isShareExpired(share.expiresAt)) {
      throw errors.shareExpired();
    }
    if (share.maxDownloads !== null && share.maxDownloads !== undefined && share.downloads >= share.maxDownloads) {
      throw errors.shareDownloadsExceeded();
    }
    if (share.requiresAuth && !ctx.isAuthenticated) {
      throw errors.authRequired();
    }
  }

  /**
   * Writes downloads = `to` only while the count is still `from`, and reports
   * whether this call's write landed. Adapters with RETURNING
   * report it through `update` (a row back means written; not-found means the
   * count moved). The others (Prisma, MySQL) read the row back after `update`
   * with the same filter, which fails after a successful write, so their
   * `updateMany` row count decides. Database errors propagate.
   */
  async function setDownloadsIf(tokenHash: string, from: number, to: number): Promise<boolean> {
    const where = [
      { field: 'tokenHash', operator: 'eq' as const, value: tokenHash },
      { field: 'downloads', operator: 'eq' as const, value: from },
    ];
    const data = { downloads: to };
    if (db.capabilities?.operations?.returning) {
      try {
        return Boolean(await db.update({ model: 'fileShares', where, data, namespace }));
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        const name = (error as { name?: unknown } | null)?.name;
        if (code === 'ADAPTER_NOT_FOUND' || name === 'NotFoundError') return false;
        throw error;
      }
    }
    return (await db.updateMany({ model: 'fileShares', where, data, namespace })) > 0;
  }

  /**
   * Counts one download and returns the count written. The write is
   * conditional on the count read, so concurrent downloads can never exceed
   * `maxDownloads`; a lost race re-reads the link and checks it again.
   */
  async function reserveDownload(
    tokenHash: string,
    share: FileShareRecord,
    ctx: { isAuthenticated?: boolean },
  ): Promise<number> {
    let current = share;
    for (let attempt = 0; attempt < 20; attempt++) {
      assertShareUsable(current, ctx);
      if (await setDownloadsIf(tokenHash, current.downloads, current.downloads + 1)) return current.downloads + 1;
      const reread = await readShare(tokenHash);
      if (!reread) throw errors.shareNotFound();
      current = reread;
    }
    // The last reread may show the link used up (or revoked) meanwhile: that is
    // the answer, not a retryable conflict.
    assertShareUsable(current, ctx);
    throw new errors.FileFnError(
      errors.ErrorCodes.SHARE_DOWNLOAD_CONFLICT,
      'Too many concurrent downloads of this share link; retry',
      409,
      { retryable: true },
    );
  }

  /**
   * Gives back one download this request counted but could not hand out: the
   * current count goes down by one with a conditional write, re-read and
   * retried when another download moved it in between, so the release happens
   * once whatever was counted since. Best effort: after repeated misses or a
   * database error the link keeps the extra count (fails closed).
   */
  async function releaseDownload(tokenHash: string, written: number): Promise<void> {
    let current = written;
    try {
      for (let attempt = 0; attempt < 20 && current > 0; attempt++) {
        if (await setDownloadsIf(tokenHash, current, current - 1)) return;
        const reread = await readShare(tokenHash);
        if (!reread) return;
        current = reread.downloads;
      }
    } catch {
      // Fails closed: the link keeps the extra count.
    }
  }

  /**
   * Signed URL lifetime, taken just before signing: the configured TTL, but
   * never past the link's own expiry. Null when less than a whole second is
   * left.
   */
  function signedUrlLifetime(share: FileShareRecord): number | null {
    const expiresAtMs = share.expiresAt ? shareDeadline(share.expiresAt) : null;
    if (expiresAtMs === null) return signedUrlTtlSeconds;
    const remaining = Math.floor((expiresAtMs - Date.now()) / 1000);
    return remaining < 1 ? null : Math.min(signedUrlTtlSeconds, remaining);
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

      const canShare = await canShareFile(file, ctx, true);
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

      const capabilities = getStorageCapabilities(storage, storageTarget);
      // Streaming is judged for the file's own storage target: a routed adapter
      // has openDownloadStream even when that target can only sign.
      const canStream = Boolean(storage.openDownloadStream) && capabilities.proxyStreamingDownload !== false;
      const canSign = Boolean(capabilities.signedDownloadUrls && storage.signDownloadUrl);
      // Under a second left: the checked proxy serves the link if it can.
      if (canSign && (signedUrlLifetime(share) !== null || !canStream)) {
        // Counted first, then signed with the lifetime left at that moment, so
        // the URL starts no earlier than the count and ends no later than the
        // link (plus the signer's own latency). A failed signing gives the
        // count back.
        const written = await reserveDownload(tokenHash, share, ctx);
        const lifetime = signedUrlLifetime(share);
        if (lifetime === null) {
          await releaseDownload(tokenHash, written);
          // Under a second left after counting: the proxy serves it if it can.
          if (!canStream) throw errors.shareExpired();
        } else {
          let result: Awaited<ReturnType<NonNullable<StorageAdapter['signDownloadUrl']>>>;
          try {
            result = await storage.signDownloadUrl!({
              key: version.storageKey,
              target: storageTarget,
              expiresInSeconds: lifetime,
              ...signedDownloadConstraints(version.mimeType),
            });
          } catch (error) {
            await releaseDownload(tokenHash, written);
            throw error;
          }
          // Revoked or expired while signing: the URL is withheld. A failed
          // read withholds it too, and gives the count back.
          let after: FileShareRecord | null;
          try {
            after = await readShare(tokenHash);
          } catch (error) {
            await releaseDownload(tokenHash, written);
            throw error;
          }
          if (!after || after.revokedAt || isShareExpired(after.expiresAt)) {
            await releaseDownload(tokenHash, written);
            if (!after) throw errors.shareNotFound();
            throw after.revokedAt ? errors.shareRevoked() : errors.shareExpired();
          }
          return { url: result.url, headers: result.headers, fileName: file.name, mimeType: file.mimeType };
        }
      }

      // Only a link that is still valid gets the proxy URL.
      if (isShareExpired(share.expiresAt)) throw errors.shareExpired();
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

      // Opened first and handed out only once the download is counted, and the
      // link is checked again after counting: one revoked or expired meanwhile
      // gives the count back and hands nothing out.
      const stream = await storage.openDownloadStream({ key: version.storageKey, target: storageTarget });
      try {
        const written = await reserveDownload(tokenHash, share, ctx);
        let after: FileShareRecord | null;
        try {
          after = await readShare(tokenHash);
        } catch (error) {
          await releaseDownload(tokenHash, written);
          throw error;
        }
        if (!after || after.revokedAt || isShareExpired(after.expiresAt)) {
          await releaseDownload(tokenHash, written);
          if (!after) throw errors.shareNotFound();
          throw after.revokedAt ? errors.shareRevoked() : errors.shareExpired();
        }
      } catch (error) {
        // Not awaited: a stream that never settles must not hold the error back.
        const unread = stream as unknown as { cancel?: () => unknown; destroy?: () => unknown };
        void Promise.resolve()
          .then(() => (unread.cancel ? unread.cancel() : unread.destroy?.()))
          .catch(() => {});
        throw error;
      }

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

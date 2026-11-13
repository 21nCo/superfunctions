import type { Adapter, WhereClause } from '@superfunctions/db';
import * as errors from '../errors.js';

/**
 * `uploadMode` of the record that holds a file's completion claim. The record
 * lives in `uploadSessions` (its `uploadSessionId` is unique, which is what
 * makes the claim exclusive) but is not an upload session: session lookups
 * skip it, `fileId` stays null so file deletion never removes it, and its
 * `status` is `aborted` so no upload operation can act on it.
 */
export const FILE_CLAIM_UPLOAD_MODE = 'file-claim';

const FILE_CLAIM_ID_PREFIX = 'fileclaim:';

export function fileClaimId(fileId: string): string {
  return `${FILE_CLAIM_ID_PREFIX}${fileId}`;
}

export function isFileClaimRecord(record: { uploadMode?: string | null } | null | undefined): boolean {
  return record?.uploadMode === FILE_CLAIM_UPLOAD_MODE;
}

/** A claim as stored. `completionVersionId` is the holder's token: the version it is completing. */
export interface FileClaimRecord {
  uploadSessionId: string;
  /** The claimed file ID. */
  fileName: string;
  ownerId: string;
  tenantId: string | null;
  expiresAt: string;
  completionVersionId: string | null;
  metadata?: { uploadSessionId?: string } | null;
}

export interface FileClaimHolder {
  uploadSessionId: string;
  ownerId: string;
  tenantId: string | null;
  policy: string;
  mimeType: string;
}

export interface FileClaimsConfig {
  db: Adapter;
  namespace: string;
  /** How long a claim stays valid without renewal. An expired claim may be taken over. */
  ttlSeconds: number;
  /** How long `acquire` waits for a live claim to be released before failing with FILEFN_FILE_BUSY. */
  waitMs: number;
}

/**
 * Runs an update and reports whether the row now matches `applied`, judged by
 * re-reading it rather than by the adapter's return value: adapters differ on
 * an update that matches no row (some return null, some throw). If the update
 * threw but the row still matches `expected`, the update was not a lost race,
 * so its error is rethrown.
 */
export async function updateAndVerify<T>(
  db: Adapter,
  params: { model: string; where: WhereClause[]; key: WhereClause[]; data: Record<string, unknown>; namespace: string },
  applied: (row: T) => boolean,
  expected: (row: T) => boolean,
): Promise<boolean> {
  let updateError: unknown;
  try {
    await db.update({ model: params.model, where: params.where, data: params.data, namespace: params.namespace });
  } catch (error) {
    updateError = error;
  }
  const row = await db.findOne<T>({ model: params.model, where: params.key, namespace: params.namespace });
  if (row && applied(row)) return true;
  if (updateError !== undefined && row && expected(row)) throw updateError;
  return false;
}

function isExpired(expiresAt: string): boolean {
  const ms = Date.parse(expiresAt);
  return Number.isNaN(ms) || ms <= Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Per-file completion claims. A completion holds its file's claim from before
 * it reads the file row until after it records its session, so at most one
 * completion of a file publishes bytes or writes its `files` row at a time:
 * ownership of a new ID is settled before any bytes are stored under it.
 *
 * A claim is a lease. The holder renews it before recording its version; one
 * that expires (its holder was interrupted) is recovered by the next acquirer
 * or by `cleanupExpired`, which keeps a version the holder committed and
 * deletes one it did not. A holder whose lease was taken over records nothing
 * (its renewal fails), but storage writes cannot be fenced: a publish stalled
 * past the lease could still overwrite a key it shares with the new holder, so
 * the TTL must exceed any completion's publish time.
 */
export function createFileClaims(config: FileClaimsConfig) {
  const { db, namespace, ttlSeconds, waitMs } = config;

  function claimKey(fileId: string): WhereClause[] {
    return [{ field: 'uploadSessionId', operator: 'eq', value: fileClaimId(fileId) }];
  }

  function heldBy(fileId: string, token: string): WhereClause[] {
    return [...claimKey(fileId), { field: 'completionVersionId', operator: 'eq', value: token }];
  }

  function newExpiry(): string {
    return new Date(Date.now() + ttlSeconds * 1000).toISOString();
  }

  function claimData(fileId: string, holder: FileClaimHolder, token: string): Record<string, unknown> {
    const now = new Date().toISOString();
    return {
      uploadSessionId: fileClaimId(fileId),
      status: 'aborted',
      policy: holder.policy,
      fileId: null,
      fileName: fileId,
      mimeType: holder.mimeType,
      size: 0,
      uploadMode: FILE_CLAIM_UPLOAD_MODE,
      chunkSizeBytes: 0,
      totalParts: 0,
      storageKey: fileClaimId(fileId),
      storageUploadId: null,
      ownerId: holder.ownerId,
      tenantId: holder.tenantId,
      metadata: { uploadSessionId: holder.uploadSessionId },
      idempotencyKey: null,
      idempotencyPayloadHash: null,
      completionVersionId: token,
      uploadSessionToken: null,
      uploadSessionTokenHash: null,
      expiresAt: newExpiry(),
      createdAt: now,
    };
  }

  async function findClaim(fileId: string): Promise<FileClaimRecord | null> {
    return db.findOne<FileClaimRecord>({ model: 'uploadSessions', where: claimKey(fileId), namespace });
  }

  /**
   * Settles what an interrupted holder left behind. Returns the holder's
   * version and session when it had committed the file row (its session is
   * then marked completed), otherwise deletes its uncommitted version row.
   */
  async function recover(claim: FileClaimRecord): Promise<{ versionId: string; uploadSessionId?: string } | null> {
    const fileId = claim.fileName;
    const token = claim.completionVersionId;
    const holderSessionId = claim.metadata?.uploadSessionId;
    if (!token) return null;

    const file = await db.findOne<{ currentVersionId: string }>({
      model: 'files',
      where: [{ field: 'fileId', operator: 'eq', value: fileId }],
      namespace,
    });
    if (file?.currentVersionId === token) {
      if (holderSessionId) {
        try {
          await db.update({
            model: 'uploadSessions',
            where: [
              { field: 'uploadSessionId', operator: 'eq', value: holderSessionId },
              { field: 'status', operator: 'ne', value: 'completed' },
            ],
            data: { status: 'completed', fileId, completionVersionId: token },
            namespace,
          });
        } catch {
          // Already completed, or gone with its file.
        }
      }
      return { versionId: token, uploadSessionId: holderSessionId };
    }

    const holderSession = holderSessionId
      ? await db.findOne<{ status: string; completionVersionId?: string | null }>({
          model: 'uploadSessions',
          where: [{ field: 'uploadSessionId', operator: 'eq', value: holderSessionId }],
          namespace,
        })
      : null;
    if (holderSession?.status === 'completed' && holderSession.completionVersionId === token) {
      return null;
    }
    try {
      await db.delete({
        model: 'fileVersions',
        where: [
          { field: 'versionId', operator: 'eq', value: token },
          { field: 'fileId', operator: 'eq', value: fileId },
        ],
        namespace,
      });
    } catch {
      // The holder stopped before recording a version.
    }
    return null;
  }

  /** Releases a claim held with `token`; never removes a claim someone else now holds. */
  async function release(fileId: string, token: string): Promise<void> {
    try {
      await db.delete({ model: 'uploadSessions', where: heldBy(fileId, token), namespace });
    } catch {
      // Best-effort: an unreleased claim expires and is recovered.
    }
  }

  return {
    /**
     * Takes `fileId`'s claim for `holder`, with `token` (the version the
     * holder is completing) as proof of holding it. Waits up to `waitMs` for a
     * live claim, then fails with 409 FILEFN_FILE_BUSY. Taking over an expired
     * claim first recovers it; the result reports a version its holder had
     * committed.
     */
    async acquire(
      fileId: string,
      holder: FileClaimHolder,
      token: string,
    ): Promise<{ recovered: { versionId: string; uploadSessionId?: string } | null }> {
      const deadline = Date.now() + waitMs;
      let delay = 20;
      let missedClaims = 0;
      for (;;) {
        const data = claimData(fileId, holder, token);
        let createError: unknown;
        try {
          await db.create({ model: 'uploadSessions', data, namespace });
          return { recovered: null };
        } catch (error) {
          createError = error;
        }

        const held = await findClaim(fileId);
        if (held && isExpired(held.expiresAt) && held.completionVersionId) {
          const staleToken = held.completionVersionId;
          const tookOver = await updateAndVerify<FileClaimRecord>(
            db,
            { model: 'uploadSessions', where: heldBy(fileId, staleToken), key: claimKey(fileId), data, namespace },
            (row) => row.completionVersionId === token,
            (row) => row.completionVersionId === staleToken,
          );
          if (tookOver) return { recovered: await recover(held) };
        }
        if (!held) {
          // Released between our insert and our read: try once more. A second
          // miss means the insert failed for another reason.
          missedClaims += 1;
          if (missedClaims > 1) throw createError;
          continue;
        }
        if (Date.now() >= deadline) throw errors.fileBusy(fileId);
        await sleep(delay);
        delay = Math.min(delay * 2, 200);
      }
    },

    /** Extends a held claim. Returns false when the claim is no longer held with `token`. */
    async renew(fileId: string, token: string): Promise<boolean> {
      const expiresAt = newExpiry();
      return updateAndVerify<FileClaimRecord>(
        db,
        { model: 'uploadSessions', where: heldBy(fileId, token), key: claimKey(fileId), data: { expiresAt }, namespace },
        (row) => row.completionVersionId === token && row.expiresAt === expiresAt,
        (row) => row.completionVersionId === token,
      );
    },

    release,

    /** Recovers and removes an expired claim found by expired-session cleanup. */
    async cleanupExpired(claim: FileClaimRecord): Promise<void> {
      if (!isExpired(claim.expiresAt)) return;
      const token = claim.completionVersionId;
      if (!token) {
        await db.delete({ model: 'uploadSessions', where: claimKey(claim.fileName), namespace });
        return;
      }
      // Re-read under the token so a claim taken over since is left alone.
      const current = await findClaim(claim.fileName);
      if (current?.completionVersionId !== token) return;
      await recover(current);
      await release(claim.fileName, token);
    },
  };
}

export type FileClaims = ReturnType<typeof createFileClaims>;

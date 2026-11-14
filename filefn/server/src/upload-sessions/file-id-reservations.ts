import type { Adapter } from '@superfunctions/db';
import { randomBytes } from 'crypto';

/**
 * `uploadMode` of a file ID reservation. A reservation records which
 * principal owns a client-chosen file ID that has no file yet. It is stored in
 * `uploadSessions` because that table's `uploadSessionId` is unique, which is
 * what makes the first reservation of an ID win; it is not an upload session:
 * session lookups skip it, its `status` is `completed` and it never expires,
 * so expired-session cleanup keeps it, and its `fileId` is null, so deleting
 * the file keeps it too. The ID stays with its first owner. An anonymous
 * caller claims an ID for one upload session only while that session's
 * completion creates the file; the claim is released once the file exists.
 */
export const FILE_ID_RESERVATION_MODE = 'file-id-reservation';

const RESERVATION_ID_PREFIX = 'fileid:';
const NEVER_EXPIRES = '9999-12-31T23:59:59.999Z';

export function fileIdReservationId(fileId: string): string {
  return `${RESERVATION_ID_PREFIX}${fileId}`;
}

export function isFileIdReservation(record: { uploadMode?: string | null } | null | undefined): boolean {
  return record?.uploadMode === FILE_ID_RESERVATION_MODE;
}

export interface FileIdOwner {
  ownerId: string;
  tenantId: string | null;
}

/** Who asks to create a file under an ID; an anonymous caller is known only by its upload session. */
export interface FileIdClaimant extends FileIdOwner {
  uploadSessionId?: string;
}

interface ReservationRecord extends FileIdOwner {
  /** Unique per inserted row, so a row can be removed on its own. */
  storageKey: string;
  /** The upload session holding an anonymous claim. */
  storageUploadId: string | null;
}

/** Whether `owner` is the named principal (in the same tenant) that `record` names. */
export function isNamedOwner(record: FileIdOwner, owner: FileIdOwner): boolean {
  return (
    owner.ownerId !== 'anonymous' &&
    record.ownerId === owner.ownerId &&
    (record.tenantId ?? null) === (owner.tenantId ?? null)
  );
}

/** Whether `claimant` holds `reservation`: as its named owner, or as the anonymous session that claimed it. */
export function holdsReservation(reservation: ReservationRecord, claimant: FileIdClaimant): boolean {
  if (claimant.ownerId !== 'anonymous') return isNamedOwner(reservation, claimant);
  return (
    reservation.ownerId === 'anonymous' &&
    !!claimant.uploadSessionId &&
    reservation.storageUploadId === claimant.uploadSessionId
  );
}

export function createFileIdReservations(config: { db: Adapter; namespace: string }) {
  const { db, namespace } = config;

  /** The reservation of `fileId`: its first row, should an adapter have let in more than one. */
  function find(fileId: string): Promise<ReservationRecord | null> {
    return db.findOne<ReservationRecord>({
      model: 'uploadSessions',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: fileIdReservationId(fileId) }],
      namespace,
    });
  }

  /** Removes one reservation row of `fileId`, the one `token` identifies. */
  async function release(fileId: string, token: string): Promise<void> {
    await db.deleteMany({
      model: 'uploadSessions',
      where: [
        { field: 'uploadSessionId', operator: 'eq', value: fileIdReservationId(fileId) },
        { field: 'storageKey', operator: 'eq', value: token },
      ],
      namespace,
    });
  }

  /**
   * An anonymous claim lapses once its session has ended or is gone (expired
   * sessions are deleted by cleanup, which releases their claims). Its session
   * exists before it claims, since it claims only on completion.
   */
  async function isLapsed(reservation: ReservationRecord): Promise<boolean> {
    if (reservation.ownerId !== 'anonymous' || !reservation.storageUploadId) return false;
    const session = await db.findOne<{ status: string }>({
      model: 'uploadSessions',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: reservation.storageUploadId }],
      namespace,
    });
    return !session || session.status === 'aborted' || session.status === 'completed';
  }

  return {
    find,
    release,

    /** Releases the reservation `token` made unless another init has relied on it since. */
    async releaseUnrelied(fileId: string, token: string): Promise<void> {
      await db.deleteMany({
        model: 'uploadSessions',
        where: [
          { field: 'uploadSessionId', operator: 'eq', value: fileIdReservationId(fileId) },
          { field: 'storageKey', operator: 'eq', value: token },
          { field: 'size', operator: 'eq', value: 0 },
        ],
        namespace,
      });
    },

    /** Whether someone other than `claimant` holds a live reservation of `fileId`. */
    async heldByOther(fileId: string, claimant: FileIdClaimant): Promise<boolean> {
      const reservation = await find(fileId);
      return !!reservation && !holdsReservation(reservation, claimant) && !(await isLapsed(reservation));
    },

    /**
     * Reserves `fileId` for `claimant` unless someone else holds it, and
     * reports whether `claimant` holds it afterwards. Two callers racing on one
     * ID both insert; the unique key lets exactly one in, and the other reads
     * the winner. A named owner calling again (a retried init) holds it
     * already. `token` is set only when this call inserted the reservation, so
     * the caller can release it if its upload never starts.
     */
    async reserve(fileId: string, claimant: FileIdClaimant, policy: string): Promise<{ held: boolean; token: string | null }> {
      let existing = await find(fileId);
      if (existing && !holdsReservation(existing, claimant) && (await isLapsed(existing))) {
        await release(fileId, existing.storageKey);
        existing = await find(fileId);
      }
      if (existing && holdsReservation(existing, claimant)) {
        // Mark it relied on, so the init that made it keeps it if that init
        // fails (see `releaseUnrelied`). If that init released it first, fall
        // through and reserve the ID again.
        await db.update({
          model: 'uploadSessions',
          where: [{ field: 'uploadSessionId', operator: 'eq', value: fileIdReservationId(fileId) }, { field: 'storageKey', operator: 'eq', value: existing.storageKey }],
          data: { size: 1 },
          namespace,
        });
        existing = await find(fileId);
      }
      if (existing) return { held: holdsReservation(existing, claimant), token: null };
      const token = `${fileIdReservationId(fileId)}/${randomBytes(12).toString('hex')}`;
      try {
        await db.create({
          model: 'uploadSessions',
          data: {
            uploadSessionId: fileIdReservationId(fileId),
            status: 'completed',
            policy,
            fileId: null,
            fileName: fileId,
            mimeType: 'application/octet-stream',
            size: 0,
            uploadMode: FILE_ID_RESERVATION_MODE,
            chunkSizeBytes: 0,
            totalParts: 0,
            storageKey: token,
            storageUploadId: claimant.ownerId === 'anonymous' ? claimant.uploadSessionId ?? null : null,
            ownerId: claimant.ownerId,
            tenantId: claimant.tenantId,
            metadata: null,
            idempotencyKey: null,
            idempotencyPayloadHash: null,
            completionVersionId: null,
            uploadSessionToken: null,
            uploadSessionTokenHash: null,
            expiresAt: NEVER_EXPIRES,
            createdAt: new Date().toISOString(),
          },
          namespace,
        });
      } catch (error) {
        const winner = await find(fileId);
        if (!winner) throw error;
        return { held: holdsReservation(winner, claimant), token: null };
      }
      // Read the reservation back rather than trusting the insert: on an
      // adapter that does not enforce the unique key, every racer reads the
      // same first row, and a later row is removed.
      const winner = await find(fileId);
      if (winner?.storageKey === token) return { held: true, token };
      await release(fileId, token);
      return { held: winner !== null && holdsReservation(winner, claimant), token: null };
    },

    /** Releases the claim an anonymous session holds on its file ID, if any. */
    async releaseClaimOf(session: FileIdClaimant & { fileId?: string | null }): Promise<void> {
      if (session.ownerId !== 'anonymous' || !session.fileId) return;
      const reservation = await find(session.fileId);
      if (reservation && holdsReservation(reservation, session)) await release(session.fileId, reservation.storageKey);
    },
  };
}

export type FileIdReservations = ReturnType<typeof createFileIdReservations>;

import type { Adapter } from '@superfunctions/db';
import { randomBytes } from 'node:crypto';

/**
 * `uploadMode` of a file ID reservation. A reservation records which
 * principal owns a client-chosen file ID that has no file yet. It is stored in
 * `uploadSessions` because that table's `uploadSessionId` is unique, which is
 * what makes the first reservation of an ID win; it is not an upload session:
 * session lookups skip it, its `status` is `completed`, so expired-session
 * cleanup keeps it, and its `fileId` is null, so deleting the file keeps it
 * too. Its `size` counts who relies on it, changed only by compare-and-set,
 * and it is deleted only when that count is 0. A named owner's inits rely on
 * it; one that fails stops relying, so a reservation every init of which
 * failed is removed, and one that any init started under is kept: the ID
 * stays with its first owner. An anonymous session's completion calls rely on
 * its claim while they run, so a failed completion leaves the ID free for a
 * retry while a sibling call still publishing keeps it. A call that never
 * finishes stops counting after `CLAIM_LEASE_MS` (the claim's `expiresAt`).
 */
export const FILE_ID_RESERVATION_MODE = 'file-id-reservation';

const RESERVATION_ID_PREFIX = 'fileid:';
const NEVER_EXPIRES = '9999-12-31T23:59:59.999Z';

/** How long an anonymous claim holds after a completion call last took it. */
export const CLAIM_LEASE_MS = 15 * 60 * 1000;

/** Attempts at settling a reservation before a contended one gives up. */
const MAX_ATTEMPTS = 8;

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
  /** How many inits, or running completion calls, rely on it. */
  size: number;
  expiresAt: string;
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

  /** An anonymous claim lapses once no completion call relies on it, or its lease ran out. A named reservation never lapses. */
  function isLapsed(reservation: ReservationRecord): boolean {
    if (reservation.ownerId !== 'anonymous') return false;
    return !(reservation.size > 0) || !(Date.parse(reservation.expiresAt) > Date.now());
  }

  /** Whether `claimant` holds `reservation` and it has not lapsed. */
  function holds(reservation: ReservationRecord | null, claimant: FileIdClaimant): boolean {
    return !!reservation && holdsReservation(reservation, claimant) && !isLapsed(reservation);
  }

  function where(fileId: string, reservation: ReservationRecord) {
    return [
      { field: 'uploadSessionId', operator: 'eq' as const, value: fileIdReservationId(fileId) },
      { field: 'storageKey', operator: 'eq' as const, value: reservation.storageKey },
      { field: 'size', operator: 'eq' as const, value: reservation.size },
    ];
  }

  function insert(fileId: string, claimant: FileIdClaimant, policy: string, token: string, expiresAt: string) {
    return db.create({
      model: 'uploadSessions',
      data: {
        uploadSessionId: fileIdReservationId(fileId),
        status: 'completed',
        policy,
        fileId: null,
        fileName: fileId,
        mimeType: 'application/octet-stream',
        size: 1,
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
        expiresAt,
        createdAt: new Date().toISOString(),
      },
      namespace,
    });
  }

  return {
    find,
    holds,

    /** Whether someone other than `claimant` holds a live reservation of `fileId`. */
    async heldByOther(fileId: string, claimant: FileIdClaimant): Promise<boolean> {
      const reservation = await find(fileId);
      return !!reservation && !holdsReservation(reservation, claimant) && !isLapsed(reservation);
    },

    /**
     * Makes `claimant` rely on the reservation of `fileId`, inserting it if
     * nobody holds it, and reports whether `claimant` holds it. Two callers
     * racing on one ID both insert; the unique key lets exactly one in, and
     * the other relies on the winner's row. A lapsed claim is replaced.
     * `token` names the row relied on, for `drop`.
     */
    async acquire(fileId: string, claimant: FileIdClaimant, policy: string): Promise<{ held: boolean; token: string | null }> {
      const expiresAt = claimant.ownerId === 'anonymous' ? new Date(Date.now() + CLAIM_LEASE_MS).toISOString() : NEVER_EXPIRES;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const existing = await find(fileId);
        if (existing && isLapsed(existing)) {
          await db.deleteMany({ model: 'uploadSessions', where: where(fileId, existing), namespace });
        } else if (existing) {
          if (!holdsReservation(existing, claimant)) return { held: false, token: null };
          const data = { size: existing.size + 1, expiresAt };
          if ((await db.updateMany({ model: 'uploadSessions', where: where(fileId, existing), data, namespace })) > 0) {
            return { held: true, token: existing.storageKey };
          }
        } else {
          const token = `${fileIdReservationId(fileId)}/${randomBytes(12).toString('hex')}`;
          try {
            await insert(fileId, claimant, policy, token, expiresAt);
          } catch (error) {
            if (!(await find(fileId))) throw error;
            continue;
          }
          // Read the reservation back rather than trusting the insert: on an
          // adapter that does not enforce the unique key, every racer reads
          // the same first row, and a later row is removed.
          if ((await find(fileId))?.storageKey === token) return { held: true, token };
          await release(fileId, token);
        }
      }
      throw new Error(`Could not settle the reservation of ${fileId}`);
    },

    /** Stops relying on the reservation `token` names, and removes it once nobody does. */
    async drop(fileId: string, token: string): Promise<void> {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const reservation = await find(fileId);
        if (reservation?.storageKey !== token) return;
        const changed = reservation.size > 1
          ? await db.updateMany({ model: 'uploadSessions', where: where(fileId, reservation), data: { size: reservation.size - 1 }, namespace })
          : await db.deleteMany({ model: 'uploadSessions', where: where(fileId, reservation), namespace });
        if (changed > 0) return;
      }
    },

    /** Removes the claim an anonymous session holds on its file ID, once the file exists. */
    async releaseClaimOf(session: FileIdClaimant & { fileId?: string | null }): Promise<void> {
      if (session.ownerId !== 'anonymous' || !session.fileId) return;
      const reservation = await find(session.fileId);
      if (reservation && holdsReservation(reservation, session)) await release(session.fileId, reservation.storageKey);
    },
  };
}

export type FileIdReservations = ReturnType<typeof createFileIdReservations>;

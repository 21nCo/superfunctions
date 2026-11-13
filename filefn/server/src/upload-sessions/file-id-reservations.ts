import type { Adapter } from '@superfunctions/db';

/**
 * `uploadMode` of a file ID reservation. A reservation records which
 * principal owns a client-chosen file ID that has no file yet. It is stored in
 * `uploadSessions` because that table's `uploadSessionId` is unique, which is
 * what makes the first reservation of an ID win; it is not an upload session:
 * session lookups skip it, its `status` is `completed` and it never expires,
 * so expired-session cleanup keeps it, and its `fileId` is null, so deleting
 * the file keeps it too. The ID stays with its first owner.
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

/**
 * Whether `owner` is the named principal (in the same tenant) that holds the
 * reservation. An anonymous caller never owns one: it cannot be told apart
 * from another anonymous caller.
 */
export function ownsReservation(reservation: FileIdOwner, owner: FileIdOwner): boolean {
  return (
    owner.ownerId !== 'anonymous' &&
    reservation.ownerId === owner.ownerId &&
    (reservation.tenantId ?? null) === (owner.tenantId ?? null)
  );
}

export function createFileIdReservations(config: { db: Adapter; namespace: string }) {
  const { db, namespace } = config;

  async function find(fileId: string): Promise<FileIdOwner | null> {
    return db.findOne<FileIdOwner>({
      model: 'uploadSessions',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: fileIdReservationId(fileId) }],
      namespace,
    });
  }

  return {
    find,

    /**
     * Reserves `fileId` for `owner` unless it is already reserved, and reports
     * whether `owner` holds the reservation afterwards. Two callers racing on
     * one ID both try to insert it; the unique key lets exactly one in, and
     * the other reads the winner. A repeated call by the owner (a retried
     * init) holds it already.
     */
    async reserve(fileId: string, owner: FileIdOwner, policy: string): Promise<boolean> {
      if (owner.ownerId === 'anonymous') return false;
      const existing = await find(fileId);
      if (existing) return ownsReservation(existing, owner);
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
            storageKey: fileIdReservationId(fileId),
            storageUploadId: null,
            ownerId: owner.ownerId,
            tenantId: owner.tenantId,
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
        return true;
      } catch (error) {
        const winner = await find(fileId);
        if (!winner) throw error;
        return ownsReservation(winner, owner);
      }
    },
  };
}

export type FileIdReservations = ReturnType<typeof createFileIdReservations>;

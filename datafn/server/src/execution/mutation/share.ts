import type { Adapter } from "@superfunctions/db";

type ShareableConfig = {
  levels: string[];
  default: "private" | "shared";
};

type ShareableEntry = {
  shareable: ShareableConfig;
};

function getShareableConfig(resolvedCapabilities: unknown[]): ShareableConfig | null {
  const entry = resolvedCapabilities.find(
    (capability): capability is ShareableEntry =>
      typeof capability === "object" &&
      capability !== null &&
      "shareable" in (capability as Record<string, unknown>),
  );
  return entry?.shareable ?? null;
}

function getPermissionsTableName(resource: string): string {
  return `__datafn_permissions_${resource}`;
}

function getPermissionEntryId(resourceId: string, userId: string): string {
  return `${resourceId}:${userId}`;
}

type OwnershipResult =
  | { ok: true; record: Record<string, unknown> }
  | { ok: false; code: string; message: string; path: string };

async function ensureOwnerAccess(
  db: Adapter,
  resource: string,
  recordId: string,
  namespace: string,
  actorId: string | undefined,
): Promise<OwnershipResult> {
  if (!actorId) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Authorization denied",
      path: "operation",
    };
  }

  const record = await db.findOne({
    model: resource,
    where: [{ field: "id", operator: "eq", value: recordId }],
    namespace,
  });

  if (!record) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `Record not found: ${recordId}`,
      path: "id",
    };
  }

  const creatorId = (record as Record<string, unknown>).createdBy;
  if (creatorId === actorId) {
    return { ok: true, record: record as Record<string, unknown> };
  }

  const permissionsTable = getPermissionsTableName(resource);
  const permissionsForRecord = await db.findMany({
    model: permissionsTable,
    where: [{ field: "resourceId", operator: "eq", value: recordId }],
    namespace,
  });
  const ownerPermission = permissionsForRecord.find(
    (entry) =>
      entry.userId === actorId &&
      entry.level === "owner",
  );

  if (!ownerPermission) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Authorization denied",
      path: "operation",
    };
  }

  return { ok: true, record: record as Record<string, unknown> };
}

export async function executeShare(
  db: Adapter,
  mutation: {
    resource: string;
    id: string;
    shareWith?: { userId?: string; level?: string };
  },
  resolvedCapabilities: unknown[],
  namespace: string,
  actorId?: string,
): Promise<
  | { ok: true; permissionRecord: Record<string, unknown> }
  | { ok: false; code: string; message: string; path: string }
> {
  const shareableConfig = getShareableConfig(resolvedCapabilities);
  if (!shareableConfig) {
    return {
      ok: false,
      code: "DFQL_UNSUPPORTED",
      message: "Unsupported DFQL feature: mutation.operation.share",
      path: "operation",
    };
  }

  const ownerCheck = await ensureOwnerAccess(
    db,
    mutation.resource,
    mutation.id,
    namespace,
    actorId,
  );
  if (!ownerCheck.ok) {
    return ownerCheck;
  }

  const shareUserId = mutation.shareWith?.userId;
  if (!shareUserId) {
    return {
      ok: false,
      code: "DFQL_INVALID",
      message: "Invalid DFQL: shareWith.userId must be string",
      path: "shareWith.userId",
    };
  }

  const requestedLevel = mutation.shareWith?.level ?? "viewer";
  if (!shareableConfig.levels.includes(requestedLevel)) {
    return {
      ok: false,
      code: "DFQL_INVALID",
      message: `Invalid DFQL: shareWith.level must be one of [${shareableConfig.levels.join(", ")}]`,
      path: "shareWith.level",
    };
  }

  const permissionsTable = getPermissionsTableName(mutation.resource);
  const now = Date.now();
  const permissionsForRecord = await db.findMany({
    model: permissionsTable,
    where: [{ field: "resourceId", operator: "eq", value: mutation.id }],
    namespace,
  });
  const existingPermission = permissionsForRecord.find(
    (entry) => entry.userId === shareUserId,
  );

  const permissionRecord = existingPermission
    ? {
        ...(existingPermission as Record<string, unknown>),
        level: requestedLevel,
        grantedBy: actorId ?? null,
        grantedAt: now,
      }
    : {
        id: getPermissionEntryId(mutation.id, shareUserId),
        resourceId: mutation.id,
        userId: shareUserId,
        level: requestedLevel,
        grantedBy: actorId ?? null,
        grantedAt: now,
      };

  if (existingPermission) {
    await db.update({
      model: permissionsTable,
      where: [{ field: "id", operator: "eq", value: permissionRecord.id }],
      data: {
        level: permissionRecord.level,
        grantedBy: permissionRecord.grantedBy,
        grantedAt: permissionRecord.grantedAt,
      },
      namespace,
    });
  } else {
    await db.create({
      model: permissionsTable,
      data: permissionRecord,
      namespace,
    });
  }

  return { ok: true, permissionRecord };
}

export async function executeUnshare(
  db: Adapter,
  mutation: {
    resource: string;
    id: string;
    shareWith?: { userId?: string };
  },
  resolvedCapabilities: unknown[],
  namespace: string,
  actorId?: string,
): Promise<
  | { ok: true; deleted: boolean; changeId: string }
  | { ok: false; code: string; message: string; path: string }
> {
  const shareableConfig = getShareableConfig(resolvedCapabilities);
  if (!shareableConfig) {
    return {
      ok: false,
      code: "DFQL_UNSUPPORTED",
      message: "Unsupported DFQL feature: mutation.operation.unshare",
      path: "operation",
    };
  }

  const ownerCheck = await ensureOwnerAccess(
    db,
    mutation.resource,
    mutation.id,
    namespace,
    actorId,
  );
  if (!ownerCheck.ok) {
    return ownerCheck;
  }

  const unshareUserId = mutation.shareWith?.userId;
  if (!unshareUserId) {
    return {
      ok: false,
      code: "DFQL_INVALID",
      message: "Invalid DFQL: shareWith.userId must be string",
      path: "shareWith.userId",
    };
  }

  const creatorId = ownerCheck.record.createdBy;
  if (creatorId === unshareUserId || (creatorId == null && actorId === unshareUserId)) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Cannot unshare the record creator",
      path: "shareWith.userId",
    };
  }

  const permissionsTable = getPermissionsTableName(mutation.resource);
  const permissionsForRecord = await db.findMany({
    model: permissionsTable,
    where: [{ field: "resourceId", operator: "eq", value: mutation.id }],
    namespace,
  });
  const existingPermission = permissionsForRecord.find(
    (entry) => entry.userId === unshareUserId,
  );

  if (!existingPermission) {
    return {
      ok: true,
      deleted: false,
      changeId: getPermissionEntryId(mutation.id, unshareUserId),
    };
  }

  await db.delete({
    model: permissionsTable,
    where: [{ field: "id", operator: "eq", value: (existingPermission as Record<string, unknown>).id }],
    namespace,
  });

  return {
    ok: true,
    deleted: true,
    changeId: String((existingPermission as Record<string, unknown>).id),
  };
}

export function getPermissionsTable(resource: string): string {
  return getPermissionsTableName(resource);
}

import type { Adapter } from '@superfunctions/db';
import type { FileProviderContext } from '@superfunctions/files';
import type { FileRecord } from '../files/service.js';
import type { FilePermissionRecord } from './authorizer.js';
import { randomUUID } from 'crypto';
import * as errors from '../errors.js';
import { parseIsoInstant } from './grant-expiry.js';
import { isFileOwner } from './ownership.js';

export interface GrantsServiceConfig {
  db: Adapter;
  namespace?: string;
  /**
   * Allow a grant to a tenant other than the file's own. Off by default: one
   * user could otherwise hand a file to every member of another tenant.
   */
  allowCrossTenantGrants?: boolean;
}

const MAX_GRANT_FIELD_LENGTH = 255;

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_GRANT_FIELD_LENGTH) {
    throw errors.invalidRequest(`${field} must be a string of at most ${MAX_GRANT_FIELD_LENGTH} characters`, { field });
  }
  return value;
}

function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw errors.invalidRequest(`${field} must be a boolean`, { field });
  }
  return value;
}

export interface CreateGrantInput {
  fileId: string;
  userId?: string;
  role?: string;
  tenantId?: string;
  canRead?: boolean;
  canWrite?: boolean;
  canDelete?: boolean;
  canShare?: boolean;
  expiresAt?: string;
}

export function createGrantsService(config: GrantsServiceConfig) {
  const { db, namespace = 'filefn', allowCrossTenantGrants = false } = config;

  async function getFile(fileId: string): Promise<FileRecord | null> {
    return db.findOne<FileRecord>({
      model: 'files',
      where: [{ field: 'fileId', operator: 'eq', value: fileId }],
      namespace,
    });
  }

  async function canManagePermissions(file: FileRecord, ctx: FileProviderContext): Promise<boolean> {
    return isFileOwner(file, ctx);
  }

  return {
    async createGrant(input: CreateGrantInput, ctx: FileProviderContext): Promise<FilePermissionRecord> {
      const file = await getFile(input.fileId);
      if (!file) {
        throw errors.notFound('File');
      }

      const canManage = await canManagePermissions(file, ctx);
      if (!canManage) {
        throw errors.forbidden();
      }

      const userId = optionalText(input.userId, 'userId');
      const role = optionalText(input.role, 'role');
      const tenantId = optionalText(input.tenantId, 'tenantId');
      if (!userId && !role && !tenantId) {
        throw new errors.FileFnError('FILEFN_INVALID_GRANT', 'Grant must specify userId, role, or tenantId', 400);
      }
      if (tenantId && tenantId !== (file.tenantId ?? null) && !allowCrossTenantGrants) {
        throw errors.forbidden({ fileId: input.fileId, operation: 'grant', reason: 'cross-tenant' });
      }
      let expiresAt: string | null = null;
      if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== '') {
        const expiresAtMs = parseIsoInstant(input.expiresAt);
        if (expiresAtMs === null) {
          throw errors.invalidRequest('expiresAt must be an ISO 8601 date-time', { field: 'expiresAt' });
        }
        if (expiresAtMs <= Date.now()) {
          throw errors.invalidRequest('expiresAt must be in the future', { field: 'expiresAt' });
        }
        expiresAt = new Date(expiresAtMs).toISOString();
      }

      const permission: FilePermissionRecord = {
        permissionId: randomUUID(),
        fileId: input.fileId,
        userId,
        role,
        tenantId,
        canRead: optionalBoolean(input.canRead, 'canRead', true),
        canWrite: optionalBoolean(input.canWrite, 'canWrite', false),
        canDelete: optionalBoolean(input.canDelete, 'canDelete', false),
        canShare: optionalBoolean(input.canShare, 'canShare', false),
        expiresAt,
        createdAt: new Date().toISOString(),
      };

      await db.create({
        model: 'filePermissions',
        data: permission,
        namespace,
      });

      return permission;
    },

    async listGrants(
      fileId: string,
      ctx: FileProviderContext,
      page?: { limit?: number; offset?: number },
    ): Promise<FilePermissionRecord[]> {
      const file = await getFile(fileId);
      if (!file) {
        throw errors.notFound('File');
      }

      const canManage = await canManagePermissions(file, ctx);
      if (!canManage) {
        throw errors.forbidden();
      }

      return db.findMany<FilePermissionRecord>({
        model: 'filePermissions',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        orderBy: [
          { field: 'createdAt', direction: 'desc' },
          { field: 'permissionId', direction: 'asc' },
        ],
        limit: page?.limit,
        offset: page?.offset,
        namespace,
      });
    },

    async revokeGrant(fileId: string, permissionId: string, ctx: FileProviderContext): Promise<void> {
      const file = await getFile(fileId);
      if (!file) {
        throw errors.notFound('File');
      }

      const canManage = await canManagePermissions(file, ctx);
      if (!canManage) {
        throw errors.forbidden();
      }

      const permission = await db.findOne<FilePermissionRecord>({
        model: 'filePermissions',
        where: [
          { field: 'permissionId', operator: 'eq', value: permissionId },
          { field: 'fileId', operator: 'eq', value: fileId },
        ],
        namespace,
      });

      if (!permission) {
        throw errors.permissionNotFound();
      }

      await db.delete({
        model: 'filePermissions',
        where: [{ field: 'permissionId', operator: 'eq', value: permissionId }],
        namespace,
      });
    },
  };
}

export type GrantsService = ReturnType<typeof createGrantsService>;

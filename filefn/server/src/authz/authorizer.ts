import type { Adapter } from '@superfunctions/db';
import { isGrantExpired } from './grant-expiry.js';
import type { FileProviderContext } from '@superfunctions/files';
import type { FileRecord, Authorizer } from '../files/service.js';
import { isAnonymousContext, isFileOwner } from './ownership.js';

export type AuthorizerStrategy = 'first-allow' | 'all-must-allow';

export interface ComposeAuthorizersOptions {
  strategy: AuthorizerStrategy;
}

/**
 * Compose multiple authorizers into a single authorizer.
 * 
 * @param authorizers - Array of authorizers to compose
 * @param options - Composition options including strategy
 * @returns A composed authorizer
 * 
 * Strategies:
 * - 'first-allow': Allow if ANY authorizer allows (OR logic)
 * - 'all-must-allow': Allow only if ALL authorizers allow (AND logic)
 */
export function composeAuthorizers(
  authorizers: Authorizer[],
  options?: ComposeAuthorizersOptions
): Authorizer {
  const strategy = options?.strategy ?? 'first-allow';

  if (authorizers.length === 0) {
    return {
      async canRead() { return false; },
      async canWrite() { return false; },
      async canDelete() { return false; },
    };
  }

  if (strategy === 'first-allow') {
    return {
      async canRead(file, ctx) {
        for (const auth of authorizers) {
          if (await auth.canRead(file, ctx)) return true;
        }
        return false;
      },
      async canWrite(file, ctx) {
        for (const auth of authorizers) {
          if (await auth.canWrite(file, ctx)) return true;
        }
        return false;
      },
      async canDelete(file, ctx) {
        for (const auth of authorizers) {
          if (await auth.canDelete(file, ctx)) return true;
        }
        return false;
      },
    };
  }

  return {
    async canRead(file, ctx) {
      for (const auth of authorizers) {
        if (!(await auth.canRead(file, ctx))) return false;
      }
      return true;
    },
    async canWrite(file, ctx) {
      for (const auth of authorizers) {
        if (!(await auth.canWrite(file, ctx))) return false;
      }
      return true;
    },
    async canDelete(file, ctx) {
      for (const auth of authorizers) {
        if (!(await auth.canDelete(file, ctx))) return false;
      }
      return true;
    },
  };
}

export interface FilePermissionRecord {
  permissionId: string;
  fileId: string;
  userId: string | null;
  role: string | null;
  tenantId: string | null;
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
  canShare: boolean;
  expiresAt: string | null;
  createdAt: string;
}

export interface DefaultAuthorizerConfig {
  db: Adapter;
  namespace?: string;
  adminRoles?: string[];
}

export interface DefaultAuthorizerContext extends FileProviderContext {
  roles?: string[];
}

export function createDefaultAuthorizer(config: DefaultAuthorizerConfig): Authorizer {
  const { db, namespace = 'filefn', adminRoles = ['admin'] } = config;

  // Roles are tenant-relative: a role (admin or a role grant) applies only to
  // files of the caller's own tenant. A file without a tenant counts only for
  // a caller without one, so a tenant's admin never reaches outside it.
  function inFileTenant(file: FileRecord, ctx: FileProviderContext): boolean {
    return (file.tenantId || null) === (ctx.tenantId || null);
  }

  // Roles count only for a signed-in caller: roles a host attaches to a guest
  // (no principal, or the reserved principal `anonymous`) are ignored, so a
  // guest reads only through visibility, a grant to `anonymous`, or a tenant grant.
  function rolesOf(ctx: DefaultAuthorizerContext): string[] {
    return isAnonymousContext(ctx) ? [] : (ctx.roles ?? []);
  }

  async function getApplicableGrants(
    file: FileRecord,
    ctx: DefaultAuthorizerContext
  ): Promise<FilePermissionRecord[]> {
    const grants = await db.findMany<FilePermissionRecord>({
      model: 'filePermissions',
      where: [{ field: 'fileId', operator: 'eq', value: file.fileId }],
      namespace,
    });

    return grants.filter(grant => {
      if (isGrantExpired(grant.expiresAt)) return false;

      if (grant.userId && grant.userId === ctx.principalId) return true;
      if (grant.role && rolesOf(ctx).includes(grant.role) && inFileTenant(file, ctx)) return true;
      if (grant.tenantId && grant.tenantId === ctx.tenantId) return true;

      return false;
    });
  }

  function isAdmin(file: FileRecord, ctx: DefaultAuthorizerContext): boolean {
    return inFileTenant(file, ctx) && rolesOf(ctx).some(role => adminRoles.includes(role));
  }

  function isOwner(file: FileRecord, ctx: FileProviderContext): boolean {
    return isFileOwner(file, ctx);
  }

  return {
    async canRead(file, ctx) {
      if (isOwner(file, ctx)) return true;
      if (isAdmin(file, ctx as DefaultAuthorizerContext)) return true;
      if (file.visibility === 'public') return true;
      if (file.visibility === 'shared' && file.tenantId && file.tenantId === ctx.tenantId) return true;

      const grants = await getApplicableGrants(file, ctx as DefaultAuthorizerContext);
      return grants.some(g => g.canRead);
    },

    async canWrite(file, ctx) {
      // A guest never writes, whatever roles the host gave the reserved
      // principal: anonymous uploads are owned by nobody (FILE-30 F-02).
      if (isAnonymousContext(ctx)) return false;
      if (isOwner(file, ctx)) return true;
      if (isAdmin(file, ctx as DefaultAuthorizerContext)) return true;

      const grants = await getApplicableGrants(file, ctx as DefaultAuthorizerContext);
      return grants.some(g => g.canWrite);
    },

    async canDelete(file, ctx) {
      if (isAnonymousContext(ctx)) return false;
      if (isOwner(file, ctx)) return true;
      if (isAdmin(file, ctx as DefaultAuthorizerContext)) return true;

      const grants = await getApplicableGrants(file, ctx as DefaultAuthorizerContext);
      return grants.some(g => g.canDelete);
    },
  };
}

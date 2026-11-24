import type { FileProviderContext } from '@superfunctions/files';

/** The principal ID FileFn gives every unauthenticated caller and every file they upload. */
export const ANONYMOUS_PRINCIPAL_ID = 'anonymous';

/** Whether the context is an unauthenticated caller (no principal, or the shared `anonymous` ID). */
export function isAnonymousContext(ctx: Pick<FileProviderContext, 'principalId'>): boolean {
  return !ctx.principalId || ctx.principalId === ANONYMOUS_PRINCIPAL_ID;
}

/**
 * Whether the caller owns the file. Every unauthenticated caller shares the
 * principal `anonymous`, so nobody owns a file uploaded anonymously: such a
 * file is readable only through its visibility, a grant or a share link, and
 * cannot be shared, granted, replaced or deleted by an unauthenticated caller.
 */
export function isFileOwner(file: { ownerId?: string | null }, ctx: Pick<FileProviderContext, 'principalId'>): boolean {
  if (isAnonymousContext(ctx)) {
    return false;
  }
  return Boolean(file.ownerId) && file.ownerId === ctx.principalId;
}

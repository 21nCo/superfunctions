import type { FileFnPrincipal } from './auth.js';

/**
 * Identifies an unauthenticated caller for rate limiting, for example from the
 * client IP the host's proxy reports. Without it every anonymous caller shares
 * one bucket per category, so one of them can use it up for everyone.
 */
export type RateLimitClientKey = (request: Request) => string | null | undefined | Promise<string | null | undefined>;

/**
 * The part of a rate-limit key after the category. Authenticated callers and
 * anonymous ones get disjoint keys, and each part is JSON-encoded, so no
 * principal, tenant or client key can produce another caller's key:
 * `user:["<tenant|null>","<principal>"]`, or `anon:["<tenant|null>","<client>"]` / `anon:["<tenant|null>"]`.
 */
export async function rateLimitSubject(
  principal: Pick<FileFnPrincipal, 'principalId' | 'tenantId'> | null | undefined,
  request: Request,
  clientKey?: RateLimitClientKey,
): Promise<string> {
  if (principal?.principalId && principal.principalId !== 'anonymous') {
    return `user:${JSON.stringify([principal.tenantId || null, principal.principalId])}`;
  }
  // The tenant the resolver named (if any) keeps tenants' anonymous traffic apart.
  const tenant = principal?.tenantId || null;
  const client = clientKey ? await clientKey(request) : undefined;
  return `anon:${JSON.stringify(client ? [tenant, client] : [tenant])}`;
}

/** One route category's limit: at most `maxRequests` per `windowSeconds`. */
export interface RateLimitCategory {
  windowSeconds: number;
  maxRequests: number;
}

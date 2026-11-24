import type { FileFnPrincipal } from './auth.js';

/**
 * Identifies an unauthenticated caller for rate limiting, for example from the
 * client IP the host's proxy reports. Without it every anonymous caller shares
 * one bucket per category, so one of them can use it up for everyone.
 */
export type RateLimitClientKey = (request: Request) => string | null | undefined | Promise<string | null | undefined>;

/** The part of a rate-limit key after the category: `<tenant|global>:<principal>`, or `global:anonymous[:<client>]`. */
export async function rateLimitSubject(
  principal: Pick<FileFnPrincipal, 'principalId' | 'tenantId'> | null | undefined,
  request: Request,
  clientKey?: RateLimitClientKey,
): Promise<string> {
  if (principal?.principalId && principal.principalId !== 'anonymous') {
    return `${principal.tenantId || 'global'}:${principal.principalId}`;
  }
  const client = clientKey ? await clientKey(request) : undefined;
  return client ? `global:anonymous:${client}` : 'global:anonymous';
}

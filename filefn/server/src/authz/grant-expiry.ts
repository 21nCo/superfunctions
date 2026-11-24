/**
 * Whether a grant's `expiresAt` has passed. A value that does not parse counts
 * as expired: a grant must never outlive its intended end because its date was
 * malformed.
 */
export function isGrantExpired(expiresAt: string | null | undefined): boolean {
  if (expiresAt === null || expiresAt === undefined || expiresAt === '') {
    return false;
  }
  const expiresAtMs = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAtMs)) {
    return true;
  }
  return expiresAtMs <= Date.now();
}

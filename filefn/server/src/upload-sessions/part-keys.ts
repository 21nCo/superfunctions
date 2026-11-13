/**
 * Storage key of a proxy-mode part. It includes the upload session ID, so two
 * sessions whose final object shares a key (a policy `storagePath` built from
 * the file ID, say) never write, read or delete each other's parts.
 */
export function proxyPartKey(storageKey: string, uploadSessionId: string, partNumber: number): string {
  return `${storageKey}.${uploadSessionId}.part${partNumber}`;
}

/**
 * Part key used before parts were scoped to their session. Sessions that
 * recorded parts before the upgrade still have them here; completion reads
 * from it only when the session-scoped part is missing, and cleanup removes
 * both.
 */
export function legacyProxyPartKey(storageKey: string, partNumber: number): string {
  return `${storageKey}.part${partNumber}`;
}

/** Every key a session's part may be stored under, current scheme first. */
export function proxyPartKeys(storageKey: string, uploadSessionId: string, partNumber: number): string[] {
  return [proxyPartKey(storageKey, uploadSessionId, partNumber), legacyProxyPartKey(storageKey, partNumber)];
}

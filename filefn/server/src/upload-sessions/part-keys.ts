/** What locates a proxy-mode part: its number, and the checksum it was recorded with. */
export interface ProxyPartRecord {
  partNumber: number;
  checksumSha256Base64?: string | null;
}

/**
 * Storage key of a proxy-mode part. A part records its checksum and is stored
 * under a key scoped to its upload session, so two sessions whose final object
 * shares a key (a policy `storagePath` built from the file ID, say) never
 * write, read or delete each other's parts. A part recorded without a checksum
 * was stored before parts were scoped, under the unscoped key; only that
 * session's own record leads to it.
 */
export function proxyPartKey(storageKey: string, uploadSessionId: string, part: ProxyPartRecord): string {
  return part.checksumSha256Base64
    ? scopedProxyPartKey(storageKey, uploadSessionId, part.partNumber)
    : `${storageKey}.part${part.partNumber}`;
}

/** Key a proxy-mode part is uploaded to now. */
export function scopedProxyPartKey(storageKey: string, uploadSessionId: string, partNumber: number): string {
  return `${storageKey}.${uploadSessionId}.part${partNumber}`;
}

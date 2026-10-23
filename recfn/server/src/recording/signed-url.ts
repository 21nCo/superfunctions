import type { StorageAdapter } from '../integrations/filefn.js';
import { createDownloadUrl } from '../integrations/filefn.js';

export interface SignedUrlOptions {
  expiresIn?: number;
  proxyUrl?: string;
}

export async function generateSignedUrl(
  storageRef: string,
  storage: StorageAdapter,
  options?: SignedUrlOptions,
): Promise<string> {
  return createDownloadUrl(storage, storageRef, {
    expiresIn: options?.expiresIn,
    proxyUrl: options?.proxyUrl,
  });
}

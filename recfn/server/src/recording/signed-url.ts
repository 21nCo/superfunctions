import type { StorageAdapter } from '../integrations/filefn.js';

export interface SignedUrlOptions {
  expiresIn?: number;
}

export async function generateSignedUrl(
  storageRef: string,
  storage: StorageAdapter,
  options?: SignedUrlOptions,
): Promise<string> {
  const expiresIn = options?.expiresIn ?? 3600;
  return storage.signedUrl(storageRef, expiresIn);
}

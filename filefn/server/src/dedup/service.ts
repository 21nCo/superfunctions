import type { Adapter } from '@superfunctions/db';
import { createHash } from 'node:crypto';

export interface DeduplicationServiceConfig {
  db: Adapter;
  namespace?: string;
  enabled?: boolean;
}

export interface FileVersionRecord {
  versionId: string;
  fileId: string;
  storageKey: string;
  mimeType: string;
  size: number;
  checksumSha256Base64?: string | null;
  tenantId?: string | null;
  createdAt: string;
}

export interface DeduplicationResult {
  isDuplicate: boolean;
  existingVersionId?: string;
  existingStorageKey?: string;
  checksumSha256Base64: string;
}

export function createDeduplicationService(config: DeduplicationServiceConfig) {
  const { db, namespace = 'filefn', enabled = true } = config;

  return {
    isEnabled(): boolean {
      return enabled;
    },

    /**
     * Computes SHA-256 hash of the provided data.
     * Returns base64-encoded hash.
     */
    computeHash(data: Uint8Array): string {
      const hash = createHash('sha256');
      hash.update(data);
      return hash.digest('base64');
    },

    /**
     * Computes SHA-256 hash from a readable stream.
     * Returns base64-encoded hash.
     */
    async computeHashFromStream(stream: ReadableStream<Uint8Array>): Promise<string> {
      const hash = createHash('sha256');
      const reader = stream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            hash.update(value);
          }
        }
      } finally {
        reader.releaseLock();
      }

      return hash.digest('base64');
    },

    /**
     * Checks if a version with the given hash already exists in the same tenant.
     * Returns deduplication result with existing version info if found.
     */
    async checkForDuplicate(
      checksumSha256Base64: string,
      tenantId: string | null
    ): Promise<DeduplicationResult> {
      if (!enabled) {
        return {
          isDuplicate: false,
          checksumSha256Base64,
        };
      }

      const whereConditions: Array<{
        field: string;
        operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in' | 'contains' | 'starts_with' | 'ends_with';
        value: any;
      }> = [{ field: 'checksumSha256Base64', operator: 'eq', value: checksumSha256Base64 }];

      if (tenantId !== null) {
        whereConditions.push({ field: 'tenantId', operator: 'eq', value: tenantId });
      } else {
        whereConditions.push({ field: 'tenantId', operator: 'eq', value: null });
      }

      const existingVersion = await db.findOne<FileVersionRecord>({
        model: 'fileVersions',
        where: whereConditions,
        namespace,
      });

      if (existingVersion) {
        return {
          isDuplicate: true,
          existingVersionId: existingVersion.versionId,
          existingStorageKey: existingVersion.storageKey,
          checksumSha256Base64,
        };
      }

      return {
        isDuplicate: false,
        checksumSha256Base64,
      };
    },

    /**
     * Computes hash from stored content and checks for duplicates.
     * This is used during upload completion.
     */
    async computeAndCheckDuplicate(
      storageKey: string,
      tenantId: string | null,
      storage: { openDownloadStream?: (input: { key: string }) => Promise<ReadableStream<Uint8Array>> }
    ): Promise<DeduplicationResult> {
      if (!enabled) {
        return {
          isDuplicate: false,
          checksumSha256Base64: '',
        };
      }

      if (!storage.openDownloadStream) {
        throw new Error('Storage adapter does not support streaming downloads required for deduplication');
      }

      const stream = await storage.openDownloadStream({ key: storageKey });
      const checksumSha256Base64 = await this.computeHashFromStream(stream);

      return this.checkForDuplicate(checksumSha256Base64, tenantId);
    },

    /**
     * Verifies that a hash matches the content at the given storage key.
     * Used for integrity verification.
     */
    async verifyHash(
      storageKey: string,
      expectedHash: string,
      storage: { openDownloadStream?: (input: { key: string }) => Promise<ReadableStream<Uint8Array>> }
    ): Promise<boolean> {
      if (!storage.openDownloadStream) {
        return false;
      }

      const stream = await storage.openDownloadStream({ key: storageKey });
      const actualHash = await this.computeHashFromStream(stream);

      return actualHash === expectedHash;
    },
  };
}

export type DeduplicationService = ReturnType<typeof createDeduplicationService>;

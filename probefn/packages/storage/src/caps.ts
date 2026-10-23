import { createProbefnError } from '@probefn/contracts/errors';

export interface StorageCaps {
  maxArtifactBytes: number;
  maxEventsPerSink: number;
  /** Shared accounting database file limit; excludes journals and browser scratch. */
  maxAccountingDatabaseBytes?: number;
  /** Persistent native ownership slots across sessions and runs (2..65536). */
  maxOwnershipSlots?: number;
}

export interface EventCapPolicy {
  maxEventsPerSink: number;
  strategy: 'rollover' | 'error';
}

export const DEFAULT_ACCOUNTING_DATABASE_BYTES = 16 * 1024 * 1024;

export const DEFAULT_STORAGE_CAPS: StorageCaps = {
  maxArtifactBytes: 2 * 1024 * 1024 * 1024,
  maxAccountingDatabaseBytes: DEFAULT_ACCOUNTING_DATABASE_BYTES,
  maxEventsPerSink: 50_000,
};

export class ArtifactCapTracker {
  // Cumulative attempted payload budget, not exact disk usage (overwrites are charged again).
  private totalBytesWritten = 0;
  private reservedBytes = 0;

  public constructor(private readonly maxBytes: number = DEFAULT_STORAGE_CAPS.maxArtifactBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('Artifact byte cap must be a non-negative safe integer.');
  }

  public getTotalBytesWritten(): number {
    return this.totalBytesWritten;
  }

  public assertCanWrite(nextBytes: number, targetPath: string): void {
    if (!Number.isSafeInteger(nextBytes) || nextBytes < 0) {
      throw createProbefnError({
        code: 'E_STORAGE_WRITE_FAILED',
        message: `Refusing to write a invalid byte count for ${targetPath}.`,
        retryable: false,
        details: {
          targetPath,
          nextBytes,
        },
      });
    }

    if (this.totalBytesWritten + this.reservedBytes + nextBytes > this.maxBytes) {
      throw createProbefnError({
        code: 'E_STORAGE_CAP_EXCEEDED',
        message: `Artifact cap exceeded before ${targetPath} could be committed.`,
        retryable: false,
        details: {
          targetPath,
          maxArtifactBytes: this.maxBytes,
          attemptedTotalBytes: this.totalBytesWritten + this.reservedBytes + nextBytes,
        },
      });
    }
  }

  /** Reserve synchronously before any asynchronous write. Settle exactly once. */
  public reserve(bytes: number, targetPath: string): { commit(): void; release(): void } {
    this.assertCanWrite(bytes, targetPath);
    this.reservedBytes += bytes;
    let settled = false;
    return {
      commit: () => {
        if (settled) return;
        settled = true;
        this.reservedBytes -= bytes;
        this.totalBytesWritten += bytes;
      },
      release: () => {
        if (settled) return;
        settled = true;
        this.reservedBytes -= bytes;
      },
    };
  }

  /** Legacy accounting; asynchronous writers must use reserve() instead. */
  public recordWrite(bytesWritten: number): void {
    this.totalBytesWritten += bytesWritten;
  }
}

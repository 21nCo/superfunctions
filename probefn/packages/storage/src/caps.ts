import { createProbefnError } from '@probefn/contracts/errors';

export interface StorageCaps {
  maxArtifactBytes: number;
  maxEventsPerSink: number;
}

export interface EventCapPolicy {
  maxEventsPerSink: number;
  strategy: 'rollover' | 'error';
}

export const DEFAULT_STORAGE_CAPS: StorageCaps = {
  maxArtifactBytes: 2 * 1024 * 1024 * 1024,
  maxEventsPerSink: 50_000,
};

export class ArtifactCapTracker {
  private totalBytesWritten = 0;

  public constructor(private readonly maxBytes: number = DEFAULT_STORAGE_CAPS.maxArtifactBytes) {}

  public getTotalBytesWritten(): number {
    return this.totalBytesWritten;
  }

  public assertCanWrite(nextBytes: number, targetPath: string): void {
    if (nextBytes < 0) {
      throw createProbefnError({
        code: 'E_STORAGE_WRITE_FAILED',
        message: `Refusing to write a negative byte count for ${targetPath}.`,
        retryable: false,
        details: {
          targetPath,
          nextBytes,
        },
      });
    }

    if (this.totalBytesWritten + nextBytes > this.maxBytes) {
      throw createProbefnError({
        code: 'E_STORAGE_CAP_EXCEEDED',
        message: `Artifact cap exceeded before ${targetPath} could be committed.`,
        retryable: false,
        details: {
          targetPath,
          maxArtifactBytes: this.maxBytes,
          attemptedTotalBytes: this.totalBytesWritten + nextBytes,
        },
      });
    }
  }

  public recordWrite(bytesWritten: number): void {
    this.totalBytesWritten += bytesWritten;
  }
}

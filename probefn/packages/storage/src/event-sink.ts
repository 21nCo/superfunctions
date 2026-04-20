import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { createProbefnError } from '@probefn/contracts/errors';
import type { JsonObject, JsonValue } from '@probefn/contracts/envelopes';
import { ArtifactCapTracker, DEFAULT_STORAGE_CAPS, type EventCapPolicy } from './caps.js';
import { assertRepositoryRelativePath } from './manifest-writer.js';
import { redactSensitiveData } from './redaction.js';

export interface AppendEventResult {
  relativePath: string;
  warning?: string;
  eventCount: number;
  sinkIndex: number;
}

export interface EventSinkOptions {
  repoRoot: string;
  relativeDirectory: string;
  baseName: string;
  capTracker: ArtifactCapTracker;
  policy?: Partial<EventCapPolicy>;
}

export class NdjsonEventSink {
  private readonly repoRoot: string;
  private readonly relativeDirectory: string;
  private readonly baseName: string;
  private readonly capTracker: ArtifactCapTracker;
  private readonly maxEventsPerSink: number;
  private readonly strategy: EventCapPolicy['strategy'];
  private eventCount = 0;
  private sinkIndex = 1;

  public constructor(options: EventSinkOptions) {
    this.repoRoot = options.repoRoot;
    this.relativeDirectory = assertRepositoryRelativePath(options.relativeDirectory);
    this.baseName = options.baseName;
    this.capTracker = options.capTracker;
    this.maxEventsPerSink = options.policy?.maxEventsPerSink ?? DEFAULT_STORAGE_CAPS.maxEventsPerSink;
    this.strategy = options.policy?.strategy ?? 'rollover';
  }

  public getCurrentRelativePath(): string {
    return path.posix.join(this.relativeDirectory, formatSinkName(this.baseName, this.sinkIndex));
  }

  public async append(event: JsonValue | JsonObject | object): Promise<AppendEventResult> {
    let warning: string | undefined;

    if (this.eventCount >= this.maxEventsPerSink) {
      if (this.strategy === 'error') {
        throw createProbefnError({
          code: 'E_STORAGE_CAP_EXCEEDED',
          message: `Event cap exceeded for ${this.getCurrentRelativePath()}.`,
          retryable: false,
          details: {
            path: this.getCurrentRelativePath(),
            maxEventsPerSink: this.maxEventsPerSink,
          },
        });
      }

      this.sinkIndex += 1;
      this.eventCount = 0;
      warning = `Event cap reached; rollover sink ${formatSinkName(this.baseName, this.sinkIndex)} created.`;
    }

    const relativePath = this.getCurrentRelativePath();
    const absolutePath = path.resolve(this.repoRoot, relativePath);
    const redactedEvent = redactSensitiveData(event).value;
    const payload = `${JSON.stringify(redactedEvent)}\n`;
    const payloadBytes = Buffer.byteLength(payload);

    this.capTracker.assertCanWrite(payloadBytes, relativePath);

    try {
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await appendFile(absolutePath, payload, 'utf8');
      this.capTracker.recordWrite(payloadBytes);
      this.eventCount += 1;
      return {
        relativePath,
        ...(warning ? { warning } : {}),
        eventCount: this.eventCount,
        sinkIndex: this.sinkIndex,
      };
    } catch (error) {
      throw createProbefnError({
        code: 'E_STORAGE_WRITE_FAILED',
        message: `Could not append to event sink ${relativePath}.`,
        retryable: false,
        details: {
          path: relativePath,
        },
        cause: error,
      });
    }
  }
}

function formatSinkName(baseName: string, sinkIndex: number): string {
  return sinkIndex === 1
    ? `${baseName}.ndjson`
    : `${baseName}-${String(sinkIndex).padStart(4, '0')}.ndjson`;
}

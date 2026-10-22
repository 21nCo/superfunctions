import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { createProbefnError } from '@probefn/contracts/errors';
import type { JsonObject, JsonValue } from '@probefn/contracts/envelopes';
import { ArtifactCapTracker, DEFAULT_STORAGE_CAPS, type EventCapPolicy } from './caps.js';
import { assertArtifactIdentifier, assertRepositoryRelativePath } from './manifest-writer.js';
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
  appendPersisted?: (payload: string, policy: EventCapPolicy) => Promise<AppendEventResult>;
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
  private appendQueue: Promise<void> = Promise.resolve();
  private appendFailure: unknown;
  private readonly appendPersisted?: EventSinkOptions['appendPersisted'];

  public constructor(options: EventSinkOptions) {
    assertArtifactIdentifier(options.baseName, 'Event sink name');
    this.repoRoot = options.repoRoot;
    this.relativeDirectory = assertRepositoryRelativePath(options.relativeDirectory);
    this.baseName = options.baseName;
    this.capTracker = options.capTracker;
    this.appendPersisted = options.appendPersisted;
    this.maxEventsPerSink = options.policy?.maxEventsPerSink ?? DEFAULT_STORAGE_CAPS.maxEventsPerSink;
    this.strategy = options.policy?.strategy ?? 'rollover';
    if (!Number.isSafeInteger(this.maxEventsPerSink) || this.maxEventsPerSink < 1) throw new TypeError('Event cap must be a positive safe integer.');
  }

  public getCurrentRelativePath(): string {
    return path.posix.join(this.relativeDirectory, formatSinkName(this.baseName, this.sinkIndex));
  }

  public async append(event: JsonValue | JsonObject | object): Promise<AppendEventResult> {
    // Snapshot the payload when called, before waiting behind another append.
    const payload = `${JSON.stringify(redactSensitiveData(event).value)}\n`;
    const operation = this.appendQueue.then(() => this.appendPayload(payload));
    this.appendQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async appendPayload(payload: string): Promise<AppendEventResult> {
    if (this.appendFailure) throw this.appendFailure;
    if (this.appendPersisted) {
      const result = await this.appendPersisted(payload, { maxEventsPerSink: this.maxEventsPerSink, strategy: this.strategy });
      this.sinkIndex = result.sinkIndex; this.eventCount = result.eventCount;
      return result;
    }
    const rollover = this.eventCount >= this.maxEventsPerSink;
    if (rollover && this.strategy === 'error') {
      throw createProbefnError({
        code: 'E_STORAGE_CAP_EXCEEDED',
        message: `Event cap exceeded for ${this.getCurrentRelativePath()}.`,
        retryable: false,
        details: { path: this.getCurrentRelativePath(), maxEventsPerSink: this.maxEventsPerSink },
      });
    }
    const nextIndex = this.sinkIndex + (rollover ? 1 : 0);
    const relativePath = path.posix.join(this.relativeDirectory, formatSinkName(this.baseName, nextIndex));
    const absolutePath = path.resolve(this.repoRoot, relativePath);
    const reservation = this.capTracker.reserve(Buffer.byteLength(payload), relativePath);
    let appendStarted = false;
    try {
      await mkdir(path.dirname(absolutePath), { recursive: true });
      appendStarted = true;
      await appendFile(absolutePath, payload, 'utf8');
      reservation.commit();
      this.sinkIndex = nextIndex;
      this.eventCount = (rollover ? 0 : this.eventCount) + 1;
      return {
        relativePath,
        ...(rollover ? { warning: `Event cap reached; rollover sink ${formatSinkName(this.baseName, nextIndex)} created.` } : {}),
        eventCount: this.eventCount,
        sinkIndex: this.sinkIndex,
      };
    } catch (error) {
      const failure = createProbefnError({
        code: 'E_STORAGE_WRITE_FAILED',
        message: `Could not append to event sink ${relativePath}.`,
        retryable: false,
        details: { path: relativePath },
        cause: error,
      });
      if (appendStarted) {
        // An append can fail after writing a prefix. Charge the whole reservation and
        // stop this sink so a later event cannot silently extend a malformed NDJSON line.
        reservation.commit();
        this.appendFailure = failure;
      } else reservation.release();
      throw failure;
    }
  }
}

function formatSinkName(baseName: string, sinkIndex: number): string {
  return sinkIndex === 1
    ? `${baseName}.ndjson`
    : `${baseName}-${String(sinkIndex).padStart(4, '0')}.ndjson`;
}

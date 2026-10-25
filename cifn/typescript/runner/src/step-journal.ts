import { constants, openSync, closeSync, fstatSync, readSync, mkdirSync, chmodSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MAX_STEP_EVENTS, MAX_STEP_JOURNAL_BYTES, stepEventDigest, validateStepEvent, type ClaimIdentity, type ReportedStepStatus, type StepEvent } from '@cifn/control-plane';

export class StepStatusReportingError extends Error {
  constructor() { super('Step status could not be durably reported; execution requires reconciliation'); }
}
interface Snapshot { version: 1; identity: ClaimIdentity; events: StepEvent[] }
const location = (directory: string, identity: ClaimIdentity) => join(directory, 'steps', createHash('sha256').update(identity.dispatchId).digest('hex') + '.json');
function read(path: string, identity: ClaimIdentity): Snapshot | undefined {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new StepStatusReportingError(); }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_STEP_JOURNAL_BYTES) throw new StepStatusReportingError();
    const buffer = Buffer.alloc(MAX_STEP_JOURNAL_BYTES + 1); let length = 0;
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count; }
    if (length > MAX_STEP_JOURNAL_BYTES) throw new StepStatusReportingError();
    const value = JSON.parse(buffer.toString('utf8', 0, length)) as Snapshot;
    const fields = ['claimToken', 'dispatchId', 'executionId', 'runId', 'runnerId'] as const;
    if (!value || value.version !== 1 || !value.identity || Object.keys(value).sort().join(',') !== 'events,identity,version' || Object.keys(value.identity).sort().join(',') !== fields.join(',') ||
      !fields.every(field => typeof identity[field] === 'string' && identity[field].length > 0 && value.identity[field] === identity[field]) ||
      !Array.isArray(value.events) || value.events.length > MAX_STEP_EVENTS || !value.events.every((event, index) => validateStepEvent(event) && event.sequence === index)) throw new StepStatusReportingError();
    return value;
  } catch { throw new StepStatusReportingError(); } finally { closeSync(fd); }
}
type Send = (event: StepEvent) => Promise<{ nextSequence: number }>;
async function deliver(snapshot: Snapshot, send: Send, start = 0): Promise<number> {
  let cursor = start;
  while (cursor < snapshot.events.length) {
    const receipt = await send(snapshot.events[cursor]);
    if (!receipt || !Number.isSafeInteger(receipt.nextSequence) || receipt.nextSequence <= cursor || receipt.nextSequence > MAX_STEP_EVENTS) throw new StepStatusReportingError();
    cursor = receipt.nextSequence;
  }
  return cursor;
}
/** Restart readers never overwrite owner state, ACKs or execution results. */
export async function replayStepSnapshot(directory: string, identity: ClaimIdentity, send: Send): Promise<void> {
  const snapshot = read(location(directory, identity), identity);
  if (snapshot) await deliver(snapshot, send);
}
/** One execution owner, already fenced by ClaimJournal.markStarted, appends immutable events. */
export class StepJournal {
  private readonly path: string;
  private readonly value: Snapshot;
  private acknowledged = 0;
  constructor(private directory: string, identity: ClaimIdentity) {
    this.path = location(directory, identity);
    this.directory = join(directory, 'steps');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700);
    const { runId, dispatchId, runnerId, claimToken, executionId } = identity;
    this.value = read(this.path, identity) ?? { version: 1, identity: { runId, dispatchId, runnerId, claimToken, executionId }, events: [] };
  }
  append(stepKey: string, status: ReportedStepStatus): void {
    const event = { sequence: this.value.events.length, stepKey, status };
    const packet = { ...event, digest: stepEventDigest(event) };
    if (!validateStepEvent(packet)) throw new StepStatusReportingError();
    const next = { ...this.value, events: [...this.value.events, packet] };
    const bytes = JSON.stringify(next);
    if (Buffer.byteLength(bytes) > MAX_STEP_JOURNAL_BYTES) throw new StepStatusReportingError();
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.path);
      const directory = openSync(this.directory, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
      this.value.events = next.events;
    } catch { throw new StepStatusReportingError(); }
    finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new StepStatusReportingError(); } }
  }
  async deliver(send: Send): Promise<void> { this.acknowledged = await deliver(this.value, send, this.acknowledged); }
}

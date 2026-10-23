import { mkdirSync, chmodSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, existsSync, unlinkSync, readdirSync, statSync, fstatSync, readSync, constants } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createLogger } from '@logfn/core';
import { LOG_BATCH_BYTES, LOG_JOB_BYTES, LOG_MAX_EVENTS, LOG_RETENTION_MS, logDigest, validateLogPacket, type ClaimIdentity, type LogPacket, type RunnerLogEvent } from '@cifn/control-plane';
import type { LogFnClient, LogEntry } from './reporting/logfn-client.js';
interface Spool { version: 1; identity: ClaimIdentity; expiresAt: number; packets: LogPacket[]; acknowledged: number; bytes: number; count: number; status: 'pending' | 'complete' | 'truncated' | 'failed' | 'expired' }
function readSpool(path: string): Spool {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let value: Spool;
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 3 * LOG_JOB_BYTES) throw new Error('Log spool exceeds its size bound');
      const buffer = Buffer.alloc(3 * LOG_JOB_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > 3 * LOG_JOB_BYTES) throw new Error('Log spool exceeds its size bound');
      try { value = JSON.parse(buffer.toString('utf8', 0, length)) as Spool; }
      catch { throw new Error('Log spool requires repair'); }
    } finally { closeSync(fd); }
    if (!value || typeof value !== 'object') throw new Error('Log spool requires repair');
    if (value.version !== 1 || !Array.isArray(value.packets) || value.packets.length > LOG_MAX_EVENTS + 1 || !value.packets.every((packet, index) => validateLogPacket(packet) && packet.sequence === index && (!packet.terminal || index === value.packets.length - 1)) ||
      !Number.isSafeInteger(value.acknowledged) || value.acknowledged < 0 || value.acknowledged > value.packets.length ||
      !Number.isFinite(value.expiresAt) || !['pending', 'complete', 'truncated', 'failed', 'expired'].includes(value.status)) throw new Error('Log spool requires repair');
    const bytes = value.packets.reduce((total, packet) => total + Buffer.byteLength(JSON.stringify(packet.events)), 0);
    const count = value.packets.reduce((total, packet) => total + packet.events.length, 0);
    if (bytes !== value.bytes || count !== value.count || bytes > LOG_JOB_BYTES || count > LOG_MAX_EVENTS) throw new Error('Log spool requires repair');
    return value;
  }

function spoolPath(directory: string, identity: ClaimIdentity): string {
  return join(directory, 'logs', createHash('sha256').update(identity.dispatchId).digest('hex') + '.json');
}
function sameIdentity(actual: ClaimIdentity, expected: ClaimIdentity): boolean {
  const fields = ['claimToken', 'dispatchId', 'executionId', 'runId', 'runnerId'] as const;
  return !!actual && typeof actual === 'object' && Object.keys(actual).sort().join(',') === fields.join(',') &&
    fields.every(field => typeof expected[field] === 'string' && expected[field].length > 0 && actual[field] === expected[field]);
}
/** Replay one immutable checkpoint without taking over, writing acknowledgements, or sealing it. */
export async function replayStartedLogSnapshot(directory: string, identity: ClaimIdentity,
  send: (packet: LogPacket) => Promise<{ status: string; nextSequence: number; expiresAt: number }>): Promise<void> {
  let snapshot: Spool;
  try { snapshot = readSpool(spoolPath(directory, identity)); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return; throw cause; }
  if (!sameIdentity(snapshot.identity, identity)) throw new Error('Log spool identity conflict');
  if (snapshot.status === 'expired') return;
  let cursor = snapshot.acknowledged;
  while (cursor < snapshot.packets.length && Date.now() < snapshot.expiresAt) {
    const packet = snapshot.packets[cursor];
    // Execution remains uncertain. Only its owner may publish a terminal packet.
    if (packet.terminal) return;
    const receipt = await send(packet);
    if (!['pending', 'complete', 'truncated', 'failed', 'expired'].includes(receipt.status) ||
      !Number.isFinite(receipt.expiresAt) || !Number.isSafeInteger(receipt.nextSequence) ||
      receipt.nextSequence < 0 || receipt.nextSequence > LOG_MAX_EVENTS + 1) throw new Error('Invalid log acknowledgement');
    if (receipt.status === 'expired') return;
    if (receipt.nextSequence <= packet.sequence) throw new Error('Invalid log acknowledgement');
    // A live writer can have advanced the receiver beyond this snapshot; never overwrite its ACK.
    cursor = receipt.nextSequence;
  }
}

/** Redacted LogFn events only. Atomic private checkpoints never persist shell environments or unredacted output. */
export class LogSpool implements LogFnClient {
  private path: string;
  private value: Spool;
  private directory: string;
  private logger: ReturnType<typeof createLogger>;
  private events: RunnerLogEvent[] = [];
  constructor(directory: string, identity: ClaimIdentity, retentionMs = LOG_RETENTION_MS) {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 1 || retentionMs > 30 * 86400000) throw new Error('Invalid log retention');
    this.directory = join(directory, 'logs'); mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700);
    const stem = createHash('sha256').update(identity.dispatchId).digest('hex') + '.json';
    this.path = join(this.directory, stem);
    for (const name of readdirSync(this.directory)) if (name.startsWith(stem + '.') && name.endsWith('.tmp')) {
      const temporary = join(this.directory, name);
      try { if (Date.now() - statSync(temporary).mtimeMs >= retentionMs) unlinkSync(temporary); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
    }
    this.value = existsSync(this.path) ? this.read() : { version: 1, identity, expiresAt: Date.now() + retentionMs, packets: [], acknowledged: 0, bytes: 0, count: 0, status: 'pending' };
    if (JSON.stringify(this.value.identity) !== JSON.stringify(identity)) throw new Error('Log spool identity conflict');
    this.logger = createLogger({ name: 'cifn', level: 'info', redaction: { allowlist: ['/ctx/stepKey'] },
      onError: () => { this.value.status = 'failed'; },
      sinks: [batch => { for (const event of batch) {
        if (event.ctx?._truncated) this.value.status = 'truncated';
        this.events.push({ ts: event.ts, level: 'info', name: 'cifn', msg: event.msg, version: event.version, ctx: { stepKey: String(event.ctx?.stepKey ?? '__job__') } });
      } }],
    });
    this.save();
  }
  private read(): Spool { return readSpool(this.path); }
  private save() {
    if (Date.now() >= this.value.expiresAt) { this.value.status = 'expired'; this.value.packets = []; this.value.bytes = 0; this.value.count = 0; this.value.acknowledged = 0; }
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      try { writeFileSync(fd, JSON.stringify(this.value)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.path);
      const directory = openSync(this.directory, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private add(events: RunnerLogEvent[], terminal?: 'complete' | 'truncated' | 'failed') {
    const packet = { sequence: this.value.packets.length, events, ...(terminal ? { terminal } : {}) };
    this.value.packets.push({ ...packet, digest: logDigest(packet) });
    this.value.bytes += Buffer.byteLength(JSON.stringify(events)); this.value.count += events.length;
  }
  append(entry: LogEntry): void { this.appendLines(entry.runId, entry.jobKey, entry.stepKey, [entry.line]); }
  appendLines(_runId: string, _jobKey: string, stepKey: string, lines: string[]): void {
    if (this.value.status !== 'pending') return;
    this.events = [];
    // Redaction is performed by Runner on complete lines before this sink. Split only afterward.
    for (const line of lines) {
      let piece = '';
      for (const char of line) {
        if (Buffer.byteLength(piece + char) > 4096) { this.logger.info(piece, { stepKey }); piece = ''; }
        piece += char;
      }
      this.logger.info(piece, { stepKey });
    }
    let batch: RunnerLogEvent[] = [];
    for (const event of this.events) {
      if (this.value.bytes + Buffer.byteLength(JSON.stringify([...batch, event])) + 2 > LOG_JOB_BYTES || this.value.count + batch.length + 1 > LOG_MAX_EVENTS) { this.value.status = 'truncated'; break; }
      if (batch.length === 128 || Buffer.byteLength(JSON.stringify([...batch, event])) > LOG_BATCH_BYTES) { this.add(batch); batch = []; }
      batch.push(event);
    }
    if (batch.length) this.add(batch);
    this.events = [];
    try { this.save(); } catch { this.value.status = 'failed'; }
  }
  markFailed(): void { this.value.status = 'failed'; try { this.save(); } catch { /* Keep failure explicit in memory for final journal. */ } }
  markTruncated(): void { if (this.value.status === 'pending') { this.value.status = 'truncated'; try { this.save(); } catch { this.value.status = 'failed'; } } }
  outcome(): 'complete' | 'truncated' | 'failed' { return this.value.status === 'truncated' ? 'truncated' : this.value.status === 'failed' || this.value.status === 'expired' ? 'failed' : 'complete'; }
  seal(status: 'complete' | 'failed' = 'complete'): void {
    if (this.value.packets[this.value.packets.length - 1]?.terminal || this.value.status === 'expired') return;
    const terminal = this.value.status === 'pending' ? status : this.value.status === 'complete' ? 'complete' : this.value.status;
    this.value.status = terminal; this.add([], terminal); this.save();
  }
  async deliver(send: (packet: LogPacket) => Promise<{ status: string; nextSequence: number; expiresAt: number }>): Promise<void> {
    if (this.value.status === 'expired') return;
    if (Date.now() >= this.value.expiresAt) {
      this.value.packets = []; this.value.bytes = 0; this.value.count = 0; this.value.acknowledged = 0; this.value.status = 'expired'; this.save(); return;
    }
    while (this.value.acknowledged < this.value.packets.length) {
      const packet = this.value.packets[this.value.acknowledged];
      const receipt = await send(packet);
      if (receipt.status === 'expired') { this.value.packets = []; this.value.bytes = 0; this.value.count = 0; this.value.acknowledged = 0; this.value.status = 'expired'; this.save(); return; }
      if (!Number.isSafeInteger(receipt.nextSequence) || receipt.nextSequence <= packet.sequence || receipt.nextSequence > this.value.packets.length) throw new Error('Invalid log acknowledgement');
      this.value.acknowledged = receipt.nextSequence; this.save();
    }
  }
  getLines(): LogEntry[] { return []; }
  getAllLines(): LogEntry[] { return []; }
}

import { createHash } from 'node:crypto';
/** Bounds apply to serialized UTF-8 events, independently of execution status. */
export const LOG_BATCH_BYTES = 64 * 1024;
export const LOG_JOB_BYTES = 1024 * 1024;
export const LOG_MAX_EVENTS = 4096;
export const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export type LogTransferStatus = 'pending' | 'complete' | 'truncated' | 'failed' | 'expired';
/** Actual LogFn envelope subset used by Ci's private durable sink. */
export interface RunnerLogEvent { ts: string; level: 'info'; name: 'cifn'; msg: string; version: string; ctx: { stepKey: string } }
export interface LogPacket { sequence: number; events: RunnerLogEvent[]; terminal?: 'complete' | 'truncated' | 'failed'; digest: string }
export interface LogLedger { status: LogTransferStatus; expiresAt: number; bytes: number; eventCount: number; packets: LogPacket[] }
export function logDigest(value: Omit<LogPacket, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify({ sequence: value.sequence, events: value.events, ...(value.terminal ? { terminal: value.terminal } : {}) })).digest('hex');
}
export function validateLogPacket(value: unknown): value is LogPacket {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as LogPacket;
  if (Object.keys(p).some(key => !['sequence', 'events', 'terminal', 'digest'].includes(key)) ||
    !Number.isSafeInteger(p.sequence) || p.sequence < 0 || p.sequence > LOG_MAX_EVENTS ||
    typeof p.digest !== 'string' || !/^[a-f0-9]{64}$/.test(p.digest) || !Array.isArray(p.events) || p.events.length > 128 ||
    (p.terminal !== undefined && !['complete', 'truncated', 'failed'].includes(p.terminal)) || (!p.terminal && p.events.length === 0)) return false;
  for (const event of p.events) {
    if (!event || typeof event !== 'object' || Object.keys(event).sort().join(',') !== 'ctx,level,msg,name,ts,version' ||
      typeof event.ts !== 'string' || !Number.isFinite(Date.parse(event.ts)) || event.ts.length > 32 || event.level !== 'info' || event.name !== 'cifn' ||
      typeof event.msg !== 'string' || Buffer.byteLength(event.msg) > 8192 || typeof event.version !== 'string' || event.version.length > 16 ||
      !event.ctx || typeof event.ctx !== 'object' || Object.keys(event.ctx).join(',') !== 'stepKey' || typeof event.ctx.stepKey !== 'string' || event.ctx.stepKey.length > 128) return false;
  }
  return Buffer.byteLength(JSON.stringify(p.events)) <= LOG_BATCH_BYTES && p.digest === logDigest(p);
}

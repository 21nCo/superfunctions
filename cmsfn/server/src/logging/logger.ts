/** Metadata-only operational logging. No request bodies, credentials or upstream errors. */
import { randomUUID } from 'node:crypto';
import type { CmsfnEnvelope } from 'cmsfn';

export interface LogMutationInput { action: string; dataset?: string; docId?: string; body?: unknown; }
export interface LogAuthInput { action: string; subject?: string; token?: string; password?: string; }
export type LogSink = (level: string, message: string, meta: Record<string, unknown>) => void;
export interface CmsfnLoggerConfig { sink?: LogSink; }
export interface OperationContext { dataset?: string; roleId?: string; releaseId?: string; subject?: string; documentCount?: number; origin?: 'manual' | 'scheduled'; }
export type OperationAction = 'roles.upsert' | 'roles.delete' | 'preview.token' | 'releases.publish' | 'session.login' | 'session.logout';
export interface Operation { context: OperationContext; finish: (result: CmsfnEnvelope<unknown>) => void; }
const textKeys = new Set(['action', 'dataset', 'docId', 'subject', 'roleId', 'releaseId', 'operationId', 'timestamp', 'phase', 'outcome', 'origin', 'code']);
const countKeys = new Set(['documentCount', 'publishedCount', 'failedCount', 'pendingCount']);
const codes = new Set(['AUTH_REQUIRED','PERMISSION_DENIED','VALIDATION_FAILED','PAYLOAD_TOO_LARGE','RATE_LIMITED','NOT_FOUND','CONFLICT','PREVIEW_NOT_CONFIGURED','CONTENTFN_UNAVAILABLE','INTERNAL_ERROR']);
function safeMeta(input: object): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (textKeys.has(key) && typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 512 && !/[\u0000-\u001f\u007f]/.test(value)) output[key] = value;
    if (countKeys.has(key) && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000) output[key] = value;
  }
  return output;
}
const defaultSink: LogSink = (level, message, meta) => {
  const line = JSON.stringify({ level, message, ...meta });
  if (level === 'error') console.error(line); else console.log(line);
};
export function createLogger(config: CmsfnLoggerConfig = {}) {
  const sink = config.sink ?? defaultSink;
  let failures = 0, pending = 0;
  function emit(message: string, input: object): void {
    // A stalled host sink cannot accumulate an unbounded queue inside CMS.
    if (pending >= 128) { failures++; return; }
    try {
      const result: unknown = sink('info', message, safeMeta(input));
      if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result && typeof result.then === 'function') {
        pending++;
        void Promise.resolve(result).catch(() => { failures++; }).finally(() => { pending--; });
      }
    } catch { failures++; }
  }
  return {
    status: () => ({ failures, pending }),
    logMutation: (input: LogMutationInput) => emit('mutation', input),
    logAuth: (input: LogAuthInput) => emit('auth', input),
    operation(action: OperationAction, context: OperationContext = {}): Operation {
      const operationId = randomUUID();
      emit('cmsfn.operation', { ...context, action, operationId, timestamp: new Date().toISOString(), phase: 'attempt' });
      let finished = false;
      return { context, finish(result) {
        if (finished) return;
        finished = true;
        const counts: Record<string, number> = {};
        let outcome = result.ok ? 'succeeded' : 'failed';
        if (result.ok && result.result && typeof result.result === 'object') {
          const value = result.result as Record<string, unknown>;
          if (Array.isArray(value.published)) counts.publishedCount = value.published.length;
          if (Array.isArray(value.failures)) { counts.failedCount = value.failures.length; if (value.failures.length) outcome = Array.isArray(value.published) && value.published.length ? 'partial' : 'failed'; }
          if (value.execution && typeof value.execution === 'object') {
            const execution = value.execution as Record<string, unknown>;
            if (Array.isArray(execution.pending)) counts.pendingCount = execution.pending.length;
            outcome = execution.state === 'uncertain' ? 'uncertain' : 'pending';
          }
        }
        emit('cmsfn.operation', { ...context, ...counts, action, operationId, timestamp: new Date().toISOString(), phase: 'result', outcome,
          ...(!result.ok ? { code: codes.has(result.error.code) ? result.error.code : 'INTERNAL_ERROR' } : {}) });
      } };
    },
  };
}
export type CmsfnLogger = ReturnType<typeof createLogger>;

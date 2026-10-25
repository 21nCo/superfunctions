import { createHash } from 'node:crypto';
export const MAX_STEP_EVENTS = 200;
export const MAX_STEP_JOURNAL_BYTES = 128 * 1024;
export type ReportedStepStatus = 'running' | 'success' | 'failure' | 'skipped';
export interface StepEvent { sequence: number; stepKey: string; status: ReportedStepStatus; digest: string }
export function stepEventDigest(event: Omit<StepEvent, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify({ sequence: event.sequence, stepKey: event.stepKey, status: event.status })).digest('hex');
}
export function validateStepEvent(value: unknown): value is StepEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as StepEvent;
  return Object.keys(event).sort().join(',') === 'digest,sequence,status,stepKey' && Number.isSafeInteger(event.sequence) && event.sequence >= 0 && event.sequence < MAX_STEP_EVENTS &&
    typeof event.stepKey === 'string' && /^step-(?:[0-9]|[1-9][0-9])$/.test(event.stepKey) &&
    ['running', 'success', 'failure', 'skipped'].includes(event.status) && typeof event.digest === 'string' && event.digest === stepEventDigest(event);
}

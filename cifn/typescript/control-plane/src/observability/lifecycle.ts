import { createHash } from 'node:crypto';
import { redactSecrets } from '../secrets/redact.js';
import type { Run } from '../pipeline/types.js';

export const LIFECYCLE_MAX_EVENTS = 25_000;
export const LIFECYCLE_MAX_BYTES = 8 * 1024 * 1024;
export interface LifecycleEvent {
  id: string; sequence: number; timestamp: string;
  type: 'run.created' | 'run.status_changed' | 'job.started' | 'job.completed' | 'step.started' | 'step.completed';
  runId: string; jobKey?: string; stepKey?: string; status: string;
}
export interface LifecycleRecord {
  event: LifecycleEvent;
  state: 'pending' | 'sending' | 'delivered' | 'unknown';
  claim?: { token: string; expiresAt: number };
  completedAt?: number;
}
export interface LifecycleLedger { version: 1; nextSequence: number; records: LifecycleRecord[] }
export function emptyLifecycle(): LifecycleLedger { return { version: 1, nextSequence: 0, records: [] }; }
/** Only fixed status/identity fields enter telemetry; pipeline names, scripts, metadata and secrets do not. */
export function captureLifecycle(namespace: string, ledger: LifecycleLedger, before: Run | undefined, after: Run, secretValues: string[]): void {
  const timestamp = new Date().toISOString();
  const additions: Array<Omit<LifecycleEvent, 'id' | 'sequence'>> = [];
  const add = (type: LifecycleEvent['type'], status: string, jobKey?: string, stepKey?: string) => {
    if (!['queued', 'running', 'success', 'failure', 'skipped', 'cancelled'].includes(status)) throw new Error('Invalid lifecycle status');
    additions.push({
    type, status, runId: after.id, timestamp, ...(jobKey === undefined ? {} : { jobKey: redactSecrets([jobKey], secretValues)[0] }), ...(stepKey === undefined ? {} : { stepKey: redactSecrets([stepKey], secretValues)[0] }),
    });
  };
  if (!before) add('run.created', after.status);
  else {
    if (before.status !== after.status) add('run.status_changed', after.status);
    for (const job of after.jobs) {
      const previous = before.jobs.find(item => item.jobKey === job.jobKey);
      if (previous?.status !== job.status && job.status !== 'pending') add(job.status === 'running' ? 'job.started' : 'job.completed', job.status, job.jobKey);
      for (const step of job.steps) {
        if (previous?.steps.find(item => item.stepKey === step.stepKey)?.status !== step.status && step.status !== 'pending') {
          add(step.status === 'running' ? 'step.started' : 'step.completed', step.status, job.jobKey, step.stepKey);
        }
      }
    }
  }
  if (!additions.length) return;
  // Parents start first; terminal children precede terminal parents in one committed transition.
  const order = (event: Omit<LifecycleEvent, 'id' | 'sequence'>) => event.type === 'run.created' ? 0 : event.type === 'run.status_changed' ? (event.status === 'running' || event.status === 'queued' ? 1 : 6) : event.type === 'job.started' ? 2 : event.type === 'step.started' ? 3 : event.type === 'step.completed' ? 4 : 5;
  additions.sort((a, b) => order(a) - order(b));
  for (const event of additions) {
    const sequence = ledger.nextSequence++;
    const id = createHash('sha256').update(JSON.stringify([namespace, after.id, sequence])).digest('hex');
    ledger.records.push({ event: { ...event, id, sequence }, state: 'pending' });
  }
  // Reserve bounded receipt/claim metadata so maintenance remains possible at capacity.
  if (ledger.records.length > LIFECYCLE_MAX_EVENTS || Buffer.byteLength(JSON.stringify(ledger)) + ledger.records.length * 256 > LIFECYCLE_MAX_BYTES) {
    throw new Error('CiFn lifecycle retention capacity reached; maintenance is required before accepting the transition');
  }
}

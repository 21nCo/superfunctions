import { createHash } from 'node:crypto';
import { validateCompletion, type JobCompletion } from './types.js';
import type { RunStatus, JobStatus, StepStatus } from '../pipeline/types.js';

export interface ExecutionEvidence {
  kind: 'observed-owner-exit' | 'durable-exit-receipt' | 'operator-investigation';
  referenceId: string; digest: string; observedAt: number;
}
export type ExecutionDecision = {
  decisionId: string; expectedFingerprint: string; executionId: string; actorId: string;
  ownerStopped: true; evidence: ExecutionEvidence;
} & ({ action: 'complete'; result: JobCompletion } | { action: 'cancel-stopped' });
export interface ExecutionAdjudication {
  version: 1; digest: string; acceptedAt: string; decision: ExecutionDecision;
}
export interface ExecutionInspection {
  fingerprint: string; runId: string; jobKey: string; runStatus: RunStatus; jobStatus: JobStatus;
  dispatchState: string; runnerId: string; executionId?: string; acknowledgedAt?: string; stoppedAt?: string;
  steps: Array<{ stepKey: string; status: StepStatus }>;
  adjudication?: ExecutionAdjudication;
}
const opaque = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
/** Evidence is a trusted operator assertion, not an automatic process-liveness proof. */
export function canonicalDecision(value: ExecutionDecision): ExecutionDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== (value.action === 'complete' ? 'action,actorId,decisionId,evidence,executionId,expectedFingerprint,ownerStopped,result' : 'action,actorId,decisionId,evidence,executionId,expectedFingerprint,ownerStopped') ||
    !['complete', 'cancel-stopped'].includes(value.action) || value.ownerStopped !== true || !opaque(value.decisionId) || !opaque(value.actorId) ||
    typeof value.executionId !== 'string' || value.executionId.length < 1 || value.executionId.length > 512 || !hash(value.expectedFingerprint)) throw new Error('Invalid execution adjudication');
  const e = value.evidence;
  if (!e || Object.keys(e).sort().join(',') !== 'digest,kind,observedAt,referenceId' ||
    !['observed-owner-exit', 'durable-exit-receipt', 'operator-investigation'].includes(e.kind) || !opaque(e.referenceId) || !hash(e.digest) ||
    !Number.isSafeInteger(e.observedAt) || e.observedAt < 0) throw new Error('Invalid execution evidence');
  if (value.action === 'complete' && (!validateCompletion(value.result) || value.result.steps.some(step => !/^step-(?:[0-9]|[1-9][0-9])$/.test(step.stepKey)))) throw new Error('Invalid execution result');
  const base = { decisionId: value.decisionId, expectedFingerprint: value.expectedFingerprint, executionId: value.executionId,
    actorId: value.actorId, ownerStopped: true as const, evidence: { kind: e.kind, referenceId: e.referenceId, digest: e.digest, observedAt: e.observedAt } };
  return value.action === 'complete' ? { ...base, action: 'complete', result: { status: value.result.status, steps: value.result.steps.map(step => ({ stepKey: step.stepKey, status: step.status })) } } : { ...base, action: 'cancel-stopped' };
}
export function executionDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

import type { ControlPlaneStore } from '../store/store.js';
import type { CreateRunInput } from '../store/memory-store.js';
import type { Run } from '../pipeline/types.js';
import type { JobPayload } from '../queue/flowfn-client.js';

export interface PreparedRun {
  input: CreateRunInput;
  jobs: Array<Omit<JobPayload, 'runId'>>;
  secretValues: string[];
}
export interface DispatchIntent {
  stepEvents?: import('./step-events.js').StepEvent[];
  id: string;
  payload: JobPayload;
  state: 'blocked' | 'ready' | 'claimed' | 'completed';
  nextDeliveryAt: number;
  publication?: { token: string; expiresAt: number };
  claim?: { token: string; runnerId: string; claimedAt: string; protocolVersion?: 1; executionId?: string; acknowledgedAt?: string; stoppedAt?: string };
  blockedByFailure?: boolean;
  completion?: { digest: string; result: JobCompletion };
}
export interface DispatchDelivery { dispatchId: string; publicationToken: string; payload: JobPayload }
export interface DispatchStore extends ControlPlaneStore {
  createPreparedRun(prepared: PreparedRun): Promise<Run>;
  listDispatchRuns(cursor?: string): Promise<{ runIds: string[]; nextCursor?: string }>;
  leaseDispatches(runId: string, now: number, leaseMs: number): Promise<DispatchDelivery[]>;
  finishPublication(runId: string, dispatchId: string, token: string, nextDeliveryAt: number): Promise<void>;
  claimDispatch(runId: string, dispatchId: string, runnerId: string, labels: string[]): Promise<JobPayload | undefined>;
}
export function isDispatchStore(store: ControlPlaneStore): store is DispatchStore {
  const candidate = store as Partial<DispatchStore>;
  return ['createPreparedRun', 'listDispatchRuns', 'leaseDispatches', 'finishPublication', 'claimDispatch']
    .every(name => typeof candidate[name as keyof DispatchStore] === 'function');
}

export interface JobCompletion {
  status: 'success' | 'failure' | 'skipped';
  steps: Array<{ stepKey: string; status: 'success' | 'failure' | 'skipped' }>;
}
export interface ClaimIdentity { runId: string; dispatchId: string; runnerId: string; claimToken: string; executionId: string }
export class ClaimConflictError extends Error { constructor() { super('Claim identity or completion conflicts with durable state'); } }
export function validateCompletion(value: unknown): value is JobCompletion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Partial<JobCompletion>;
  const terminal = ['success', 'failure', 'skipped'];
  return Object.keys(value).every(key => key === 'status' || key === 'steps') && typeof result.status === 'string' && terminal.includes(result.status)
    && Array.isArray(result.steps) && result.steps.length <= 100 && result.steps.every(step => step && typeof step === 'object'
      && Object.keys(step).every(key => key === 'stepKey' || key === 'status') && typeof step.stepKey === 'string' && terminal.includes(step.status));
}

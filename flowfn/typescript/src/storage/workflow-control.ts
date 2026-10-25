import type { WorkflowExecution } from '../workflow/types.js';

/** All state changes use an expected revision; leases use the provider clock. */
export interface WorkflowMutation {
  expectedRevision: number | null;
  state?: WorkflowExecution;
  token?: string;
  acquire?: number;
  renew?: number;
  release?: boolean;
}

export function validateWorkflowMutation(change: WorkflowMutation, id: string): void {
  if (change.state && change.state.id !== id) throw new Error('Workflow checkpoint ID mismatch');
  if (change.expectedRevision !== null && (!Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 0)) throw new Error('Invalid workflow revision');
  for (const duration of [change.acquire, change.renew])
    if (duration !== undefined && (!Number.isSafeInteger(duration) || duration <= 0)) throw new Error('Invalid workflow lease duration');
  if ([change.acquire !== undefined, change.renew !== undefined, change.release === true].filter(Boolean).length > 1) throw new Error('Conflicting workflow lease operations');
  if ((change.acquire !== undefined || change.renew !== undefined || change.release) && !change.token) throw new Error('Workflow lease token required');
}

/** Synchronous transition used under the memory/SQL provider's atomic boundary. */
export function mutateWorkflow(current: WorkflowExecution | null, change: WorkflowMutation, now: number): WorkflowExecution | null {
  if ((current ? current.revision ?? 0 : null) !== change.expectedRevision) return null;
  if (!current && !change.state) return null;
  if (current && change.state && current.workflowId !== change.state.workflowId) return null;
  const lease = current?.lease;
  if (change.acquire !== undefined) {
    if (lease && lease.expiresAt > now) return null;
  } else if (lease) {
    if (lease.token !== change.token || lease.expiresAt <= now) return null;
  } else if (change.token) return null;
  const next = structuredClone(change.state ?? current!);
  next.revision = (current?.revision ?? 0) + 1;
  delete next.lease;
  if (change.acquire !== undefined || change.renew !== undefined)
    next.lease = { token: change.token!, expiresAt: now + (change.acquire ?? change.renew!) };
  else if (lease && !change.release) next.lease = structuredClone(lease);
  return next;
}

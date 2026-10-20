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
  id: string;
  payload: JobPayload;
  state: 'ready' | 'claimed';
  nextDeliveryAt: number;
  publication?: { token: string; expiresAt: number };
  claim?: { token: string; runnerId: string; claimedAt: string };
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

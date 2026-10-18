import type {
  DLQManager,
  EventLog,
  FlowFn,
  Job,
  JobOptions,
  JobStatus,
  JobStorage,
  QueueStats,
  Worker,
} from "@flowfn/core";
import type { AdminOperationContext } from "@superfunctions/admin";

export type FlowFnAdminJson<T> = T extends Date
  ? string
  : T extends readonly (infer TItem)[]
    ? FlowFnAdminJson<TItem>[]
    : T extends object
      ? {
          [TKey in keyof T as T[TKey] extends (...args: never[]) => unknown
            ? never
            : TKey]: FlowFnAdminJson<T[TKey]>;
        }
      : T;

export interface FlowFnAdminQueue {
  id: string;
  name: string;
  stats: QueueStats;
}

export type FlowFnAdminJob = FlowFnAdminJson<Omit<Job<unknown>, 'lease' | 'deduplicationId'>> & { queue: string };

export interface FlowFnAdminWorker {
  id: string;
  queues: readonly string[];
}

export type FlowFnAdminDeadLetter = FlowFnAdminJob & {
  originalQueue: string;
  dlqReason: string;
  dlqTimestamp: number;
  errors: string[];
};

export interface FlowFnAdminEvent {
  id: string;
  type: string;
  aggregateId: string;
  aggregateType: string;
  data: unknown;
  metadata?: Record<string, unknown>;
  timestamp: number;
  version: number;
}

export interface FlowFnListQueuesInput {
  cursor?: string;
  limit?: number;
  offset?: number;
}
export interface FlowFnGetQueueInput {
  id: string;
}
export interface FlowFnQueueListOutput {
  items: FlowFnAdminQueue[];
  nextCursor: string | null;
}
export interface FlowFnQueueOutput {
  item: FlowFnAdminQueue;
}

export interface FlowFnListJobsInput {
  queue: string;
  status?: JobStatus;
  cursor?: string;
  limit?: number;
  offset?: number;
}
export interface FlowFnGetJobInput {
  queue: string;
  id: string;
}
export interface FlowFnEnqueueJobInput {
  queue: string;
  name: string;
  data: unknown;
  options?: JobOptions;
}
export interface FlowFnJobListOutput {
  items: FlowFnAdminJob[];
  nextCursor: string | null;
}
export interface FlowFnJobOutput {
  item: FlowFnAdminJob;
}

export interface FlowFnListWorkersInput {
  cursor?: string;
  limit?: number;
  offset?: number;
}
export interface FlowFnGetWorkerInput {
  id: string;
}
export interface FlowFnWorkerActionInput {
  id: string;
}
export interface FlowFnWorkerListOutput {
  items: FlowFnAdminWorker[];
  nextCursor: string | null;
}
export interface FlowFnWorkerOutput {
  item: FlowFnAdminWorker;
}

export interface FlowFnListDeadLettersInput {
  queue?: string;
  cursor?: string;
  limit?: number;
  offset?: number;
}
export interface FlowFnGetDeadLetterInput {
  id: string;
}
export interface FlowFnRedriveDeadLetterInput {
  id: string;
}
export interface FlowFnDeleteDeadLetterInput {
  id: string;
  reason: string;
}
export interface FlowFnCleanDeadLettersInput {
  maxAgeMs: number;
  reason: string;
}
export interface FlowFnDeadLetterListOutput {
  items: FlowFnAdminDeadLetter[];
  nextCursor: string | null;
}
export interface FlowFnDeadLetterOutput {
  item: FlowFnAdminDeadLetter;
}
export interface FlowFnRedriveDeadLetterOutput {
  accepted: true;
  item: FlowFnAdminJob;
}
export interface FlowFnDeleteDeadLetterOutput {
  accepted: true;
  id: string;
}
export interface FlowFnCleanDeadLettersOutput {
  accepted: true;
  removed: number;
}

export interface FlowFnListEventsInput {
  aggregateId?: string;
  aggregateType?: string;
  types?: string[];
  fromVersion?: number;
  toVersion?: number;
  fromTimestamp?: number;
  toTimestamp?: number;
  cursor?: string;
  limit?: number;
  offset?: number;
}
export interface FlowFnEventListOutput {
  items: FlowFnAdminEvent[];
  nextCursor: string | null;
}

export interface FlowFnQueueActionInput {
  id: string;
}
export interface FlowFnAcceptedOutput {
  accepted: true;
}

export interface FlowFnAdminService {
  listQueues(
    input: FlowFnListQueuesInput,
    context: AdminOperationContext,
  ): Promise<FlowFnQueueListOutput>;
  getQueue(
    input: FlowFnGetQueueInput,
    context: AdminOperationContext,
  ): Promise<FlowFnQueueOutput>;
  pauseQueue(
    input: FlowFnQueueActionInput,
    context: AdminOperationContext,
  ): Promise<FlowFnAcceptedOutput>;
  resumeQueue(
    input: FlowFnQueueActionInput,
    context: AdminOperationContext,
  ): Promise<FlowFnAcceptedOutput>;
  listJobs(
    input: FlowFnListJobsInput,
    context: AdminOperationContext,
  ): Promise<FlowFnJobListOutput>;
  getJob(
    input: FlowFnGetJobInput,
    context: AdminOperationContext,
  ): Promise<FlowFnJobOutput>;
  enqueueJob(
    input: FlowFnEnqueueJobInput,
    context: AdminOperationContext,
  ): Promise<FlowFnJobOutput>;
  listWorkers(
    input: FlowFnListWorkersInput,
    context: AdminOperationContext,
  ): Promise<FlowFnWorkerListOutput>;
  getWorker(
    input: FlowFnGetWorkerInput,
    context: AdminOperationContext,
  ): Promise<FlowFnWorkerOutput>;
  runWorker(
    input: FlowFnWorkerActionInput,
    context: AdminOperationContext,
  ): Promise<FlowFnAcceptedOutput>;
  closeWorker(
    input: FlowFnWorkerActionInput,
    context: AdminOperationContext,
  ): Promise<FlowFnAcceptedOutput>;
  listDeadLetters(
    input: FlowFnListDeadLettersInput,
    context: AdminOperationContext,
  ): Promise<FlowFnDeadLetterListOutput>;
  getDeadLetter(
    input: FlowFnGetDeadLetterInput,
    context: AdminOperationContext,
  ): Promise<FlowFnDeadLetterOutput>;
  redriveDeadLetter(
    input: FlowFnRedriveDeadLetterInput,
    context: AdminOperationContext,
  ): Promise<FlowFnRedriveDeadLetterOutput>;
  deleteDeadLetter(
    input: FlowFnDeleteDeadLetterInput,
    context: AdminOperationContext,
  ): Promise<FlowFnDeleteDeadLetterOutput>;
  cleanDeadLetters(
    input: FlowFnCleanDeadLettersInput,
    context: AdminOperationContext,
  ): Promise<FlowFnCleanDeadLettersOutput>;
  listEvents(
    input: FlowFnListEventsInput,
    context: AdminOperationContext,
  ): Promise<FlowFnEventListOutput>;
}

export interface FlowFnAdminWorkerBinding {
  /** Stable deployment identifier for this concrete Worker instance. */
  id: string;
  worker: Worker;
  /** Queue names supplied when the Worker was constructed. */
  queues: readonly string[];
}

export interface FlowFnDomainAdminServiceOptions {
  /** Environment-owned FlowFn instance created with createFlow(). */
  flow: FlowFn;
  /** Actual job storage used by the mounted FlowFn deployment. */
  jobs: JobStorage;
  /** Actual dead-letter manager used by the mounted deployment. */
  dlq: DLQManager;
  /** Actual durable/event-sourcing log used by the mounted deployment. */
  events: EventLog;
  /** Concrete public Worker instances that may be operated. */
  workers?: readonly FlowFnAdminWorkerBinding[];
  installationId: string;
  region?: string;
  workspaceId: string;
  projectId: string;
  environmentId: string;
  namespace: string;
}

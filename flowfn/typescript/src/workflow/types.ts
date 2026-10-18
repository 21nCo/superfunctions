import type { ShutdownOptions } from '../core/shutdown.js';
export interface WorkflowContext<T = any> {
  signal: AbortSignal;
  workflowId: string;
  executionId: string;
  input: T;
  state: Record<string, any>;
  metadata: Record<string, any>;

  set(key: string, value: any): void;
  get(key: string): any;
  sleep(ms: number): Promise<void>;
  waitForEvent(event: string, timeout?: number): Promise<any>;
}

export interface Workflow<T = any> {
  id: string;
  name: string;

  execute(input: T): Promise<WorkflowExecution>;
  getExecution(executionId: string): Promise<WorkflowExecution>;
  listExecutions(options?: ListOptions): Promise<WorkflowExecution[]>;

  cancelExecution(executionId: string): Promise<void>;
  retryExecution(executionId: string): Promise<WorkflowExecution>;
  resumeExecution(executionId: string): Promise<WorkflowExecution>;
  recoverExecutions(): Promise<number>;
  startRecovery(options?: { interval?: number }): Promise<void>;
  signalEvent(executionId: string, event: string, data?: any): Promise<void>;
  approveExecution(
    executionId: string,
    decision: ApprovalDecision,
  ): Promise<void>;
  waitForCompletion(executionId: string): Promise<WorkflowExecution>;
  close(options?: ShutdownOptions): Promise<void>;

  getExecutionHistory(executionId: string): Promise<WorkflowEvent[]>;
  getMetrics(): Promise<WorkflowMetrics>;
}

export interface ApprovalDecision {
  approved: boolean;
  reviewedBy: string;
  approver?: string;
  reason?: string;
  notes?: string;
}

export interface WorkflowWait {
  kind: "event" | "approval" | "delay";
  key: string;
  name?: string;
  deadline?: number;
  data?: any;
}

export interface WorkflowExecution {
  revision?: number;
  lease?: { token: string; expiresAt: number };
  id: string;
  workflowId: string;
  status: ExecutionStatus;
  input: any;
  output?: any;
  waiting?: WorkflowWait;
  waitingFor?: WorkflowWait[];
  compensationErrors?: Array<{ step: string; message: string }>;
  error?: any;
  state?: Record<string, any>;
  startedAt: number;
  completedAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export type ExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkflowEvent {
  timestamp: number;
  type: string;
  step?: string;
  data?: any;
}

export interface WorkflowMetrics {
  totalExecutions: number;
  successRate: number;
  avgDuration: number;
}

export interface ListOptions {
  status?: ExecutionStatus;
  limit?: number;
  offset?: number;
}

export type StepHandler<T, R> = (
  ctx: WorkflowContext<T>,
  ...args: any[]
) => Promise<R>;
export type ErrorHandler<T> = (
  ctx: WorkflowContext<T>,
  error: Error,
) => Promise<void>;
export type CompensateHandler<T> = (ctx: WorkflowContext<T>) => Promise<void>;

export interface BranchOptions<T> {
  condition: (ctx: WorkflowContext<T>) => boolean | Promise<boolean>;
  then: WorkflowBuilder<T>;
  else?: WorkflowBuilder<T>;
}

export interface SagaDefinition<T> {
  execute: StepHandler<T, any>;
  compensate: CompensateHandler<T>;
}

export interface ApprovalOptions<T> {
  timeout: number;
  data?: (ctx: WorkflowContext<T>) => any;
  onTimeout?: (ctx: WorkflowContext<T>) => Promise<void>;
}

export interface EventOptions {
  timeout?: number;
}

export type Duration = {
  ms?: number;
  seconds?: number;
  minutes?: number;
  hours?: number;
  days?: number;
};

export interface WorkflowBuilder<T = any> {
  /** Bump when callback behavior changes; structural changes are detected automatically. */
  version(version: string): WorkflowBuilder<T>;
  ownership(options: { leaseDuration: number }): WorkflowBuilder<T>;
  input<I>(): WorkflowBuilder<I>;

  step<R>(name: string, handler: StepHandler<T, R>): WorkflowBuilder<T>;
  parallel(steps: StepHandler<T, any>[]): WorkflowBuilder<T>;
  branch(options: BranchOptions<T>): WorkflowBuilder<T>;

  saga(name: string, saga: SagaDefinition<T>): WorkflowBuilder<T>;

  delay(duration: Duration): WorkflowBuilder<T>;
  delayUntil(
    condition: (ctx: WorkflowContext<T>) => number,
  ): WorkflowBuilder<T>;

  waitForApproval(
    approver: string,
    options: ApprovalOptions<T>,
  ): WorkflowBuilder<T>;
  waitForEvent(event: string, options?: EventOptions): WorkflowBuilder<T>;

  onError(step: string, handler: ErrorHandler<T>): WorkflowBuilder<T>;
  compensate(step: string, handler: CompensateHandler<T>): WorkflowBuilder<T>;

  build(): Workflow<T>;
}

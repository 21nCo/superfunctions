import {
  Workflow,
  WorkflowBuilder,
  WorkflowContext,
  WorkflowExecution,
  StepHandler,
  ErrorHandler,
  CompensateHandler,
  BranchOptions,
  SagaDefinition,
  ApprovalOptions,
  EventOptions,
  Duration,
  WorkflowEvent,
  WorkflowMetrics,
  ListOptions,
} from "./types.js";
import { v4 as uuidv4 } from "uuid";
import { FlowAdapter } from "../adapters/base.js";
import {
  MemoryWorkflowStorage,
  WorkflowStorage,
} from "../storage/workflow-storage.js";
import { MemoryEventLog, EventLog } from "../storage/event-log.js";

type StepDefinition = {
  type:
    | "step"
    | "parallel"
    | "branch"
    | "saga"
    | "delay"
    | "delayUntil"
    | "wait";
  name?: string;
  handler?: Function;
  compensate?: Function;
  options?: any;
  steps?: StepDefinition[]; // for parallel/branch-then
  elseSteps?: StepDefinition[]; // for branch-else
  condition?: (
    ctx: WorkflowContext<any>
  ) => boolean | Promise<boolean> | number;
};

export class WorkflowBuilderImpl<T = any> implements WorkflowBuilder<T> {
  public steps: StepDefinition[] = [];
  private name: string;
  private adapter: FlowAdapter;

  constructor(name: string, adapter: FlowAdapter) {
    this.name = name;
    this.adapter = adapter;
  }

  input<I>(): WorkflowBuilder<I> {
    return this as unknown as WorkflowBuilder<I>;
  }

  step<R>(name: string, handler: StepHandler<T, R>): WorkflowBuilder<T> {
    this.steps.push({ type: "step", name, handler });
    return this;
  }

  parallel(steps: StepHandler<T, any>[]): WorkflowBuilder<T> {
    this.steps.push({
      type: "parallel",
      steps: steps.map((h, i) => ({
        type: "step",
        name: `parallel-${i}`,
        handler: h,
      })),
    });
    return this;
  }

  branch(options: BranchOptions<T>): WorkflowBuilder<T> {
    const thenSteps = (options.then as unknown as WorkflowBuilderImpl<T>).steps;
    const elseSteps = options.else
      ? (options.else as unknown as WorkflowBuilderImpl<T>).steps
      : undefined;

    this.steps.push({
      type: "branch",
      condition: options.condition,
      steps: thenSteps,
      elseSteps: elseSteps,
    });
    return this;
  }

  saga(name: string, saga: SagaDefinition<T>): WorkflowBuilder<T> {
    this.steps.push({
      type: "saga",
      name,
      handler: saga.execute,
      compensate: saga.compensate,
    });
    return this;
  }

  delay(duration: Duration): WorkflowBuilder<T> {
    this.steps.push({ type: "delay", options: duration });
    return this;
  }

  delayUntil(
    condition: (ctx: WorkflowContext<T>) => number
  ): WorkflowBuilder<T> {
    this.steps.push({ type: "delayUntil", condition });
    return this;
  }

  waitForApproval(
    approver: string,
    options: ApprovalOptions<T>
  ): WorkflowBuilder<T> {
    this.steps.push({
      type: "wait",
      name: "approval",
      options: { approver, ...options },
    });
    return this;
  }

  waitForEvent(event: string, options?: EventOptions): WorkflowBuilder<T> {
    this.steps.push({
      type: "wait",
      name: "event",
      options: { event, ...options },
    });
    return this;
  }

  onError(step: string, handler: ErrorHandler<T>): WorkflowBuilder<T> {
    const s = this.steps.find((s) => s.name === step);
    if (s) {
      // Attach error handler
    }
    return this;
  }

  compensate(step: string, handler: CompensateHandler<T>): WorkflowBuilder<T> {
    const s = this.steps.find((s) => s.name === step);
    if (s) {
      s.compensate = handler;
    }
    return this;
  }

  build(): Workflow<T> {
    return new WorkflowImpl(this.name, this.steps, this.adapter);
  }
}

export class WorkflowImpl<T = any> implements Workflow<T> {
  id: string;
  name: string;
  private steps: StepDefinition[];
  private adapter: FlowAdapter;
  private storage: WorkflowStorage;
  private eventLog: EventLog;
  private executionCount = 0;
  private successCount = 0;
  private totalDuration = 0;

  constructor(name: string, steps: StepDefinition[], adapter: FlowAdapter) {
    this.id = uuidv4();
    this.name = name;
    this.steps = steps;
    this.adapter = adapter;
    this.storage = new MemoryWorkflowStorage();
    this.eventLog = new MemoryEventLog();
  }

  async execute(input: T): Promise<WorkflowExecution> {
    const executionId = uuidv4();
    const execution: WorkflowExecution = {
      id: executionId,
      workflowId: this.id,
      status: "running",
      input,
      state: {},
      startedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Save initial state
    await this.storage.save(this.id, execution);
    await this.logEvent(executionId, "execution.started", { input });

    this.runExecution(execution).catch(console.error);

    return execution;
  }

  private async runExecution(execution: WorkflowExecution) {
    const context: WorkflowContext<T> = {
      workflowId: this.id,
      executionId: execution.id,
      input: execution.input,
      state: execution.state || {},
      metadata: {},
      set: (k, v) => {
        context.state[k] = v;
        this.storage
          .updateState(execution.id, context.state)
          .catch(console.error);
      },
      get: (k) => context.state[k],
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      waitForEvent: async (event, timeout) => {
        // Simplified wait: sleep for now
        // In real system, this suspends workflow until external signal
        await new Promise((r) => setTimeout(r, timeout || 100));
      },
    };

    const executedSagas: StepDefinition[] = [];

    try {
      await this.executeSteps(this.steps, context, executedSagas);
      execution.status = "completed";
      execution.output = context.state;
      execution.completedAt = Date.now();

      await this.logEvent(execution.id, "execution.completed", {
        output: execution.output,
      });
      this.executionCount++;
      this.successCount++;
      this.totalDuration += execution.completedAt - execution.startedAt;
    } catch (error) {
      execution.status = "failed";
      execution.error = error;
      execution.completedAt = Date.now();

      await this.logEvent(execution.id, "execution.failed", {
        error: (error as Error).message,
      });
      await this.compensate(executedSagas, context);
      this.executionCount++;
      this.totalDuration += execution.completedAt - execution.startedAt;
    }

    // Update storage with final state
    await this.storage.save(this.id, execution);
    await this.adapter.saveWorkflowState(execution.id, execution);
  }

  private async logEvent(
    executionId: string,
    type: string,
    data: any
  ): Promise<void> {
    await this.eventLog.append({
      type,
      aggregateId: executionId,
      aggregateType: "workflow_execution",
      data,
    });
  }

  private async executeSteps(
    steps: StepDefinition[],
    context: WorkflowContext<T>,
    executedSagas: StepDefinition[]
  ) {
    for (const step of steps) {
      if (step.type === "step" && step.handler) {
        await this.logEvent(context.executionId, "step.started", {
          step: step.name,
        });
        await step.handler(context);
        await this.logEvent(context.executionId, "step.completed", {
          step: step.name,
        });
      } else if (step.type === "saga" && step.handler) {
        await this.logEvent(context.executionId, "saga.started", {
          step: step.name,
        });
        await step.handler(context);
        executedSagas.push(step);
        await this.logEvent(context.executionId, "saga.completed", {
          step: step.name,
        });
      } else if (step.type === "parallel" && step.steps) {
        await this.logEvent(context.executionId, "parallel.started", {
          count: step.steps.length,
        });
        await Promise.all(
          step.steps.map((s) =>
            s.handler ? s.handler(context) : Promise.resolve()
          )
        );
        await this.logEvent(context.executionId, "parallel.completed", {});
      } else if (step.type === "branch" && step.condition) {
        const conditionMet = await (step.condition as any)(context);
        if (conditionMet && step.steps) {
          await this.executeSteps(step.steps, context, executedSagas);
        } else if (!conditionMet && step.elseSteps) {
          await this.executeSteps(step.elseSteps, context, executedSagas);
        }
      } else if (step.type === "delay") {
        const ms = step.options?.ms || 0;
        await new Promise((r) => setTimeout(r, ms));
      } else if (step.type === "delayUntil" && step.condition) {
        const targetTime = await (step.condition as any)(context);
        if (typeof targetTime === "number") {
          const now = Date.now();
          const delay = Math.max(0, targetTime - now);
          if (delay > 0) {
            // For long delays, we should suspend execution.
            // Here we just sleep.
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      } else if (step.type === "wait") {
        // waitForApproval / waitForEvent
        // Need a mechanism to suspend/resume
        // Currently implementing as simple sleep/mock
        if (step.options?.timeout) {
          await new Promise((r) => setTimeout(r, step.options.timeout));
        }
      }
    }
  }

  private async compensate(
    executedSagas: StepDefinition[],
    context: WorkflowContext<T>
  ) {
    for (let i = executedSagas.length - 1; i >= 0; i--) {
      const step = executedSagas[i];
      if (step.compensate) {
        try {
          await step.compensate(context);
        } catch (err) {
          console.error(`Compensation failed for step ${step.name}`, err);
        }
      }
    }
  }

  async getExecution(executionId: string): Promise<WorkflowExecution> {
    const execution = await this.storage.get(executionId);
    if (!execution) {
      // Fallback to adapter
      const adapterExecution =
        await this.adapter.loadWorkflowState(executionId);
      if (!adapterExecution) {
        throw new Error(`Execution ${executionId} not found`);
      }
      return adapterExecution;
    }
    return execution;
  }

  async listExecutions(options?: ListOptions): Promise<WorkflowExecution[]> {
    return this.storage.list(this.id, options);
  }

  async cancelExecution(executionId: string): Promise<void> {
    const execution = await this.storage.get(executionId);
    if (!execution) {
      throw new Error(`Execution ${executionId} not found`);
    }

    if (
      execution.status === "completed" ||
      execution.status === "failed" ||
      execution.status === "cancelled"
    ) {
      throw new Error(`Cannot cancel execution in ${execution.status} state`);
    }

    await this.storage.updateStatus(executionId, "cancelled");
    await this.logEvent(executionId, "execution.cancelled", {});
  }

  async retryExecution(executionId: string): Promise<WorkflowExecution> {
    const execution = await this.storage.get(executionId);
    if (!execution) {
      throw new Error(`Execution ${executionId} not found`);
    }

    if (execution.status !== "failed") {
      throw new Error(
        `Can only retry failed executions, current status: ${execution.status}`
      );
    }

    // Create new execution with same input
    return this.execute(execution.input);
  }

  async getExecutionHistory(executionId: string): Promise<WorkflowEvent[]> {
    const events = await this.eventLog.getAggregateEvents(executionId);
    return events.map((e) => ({
      timestamp: e.timestamp,
      type: e.type,
      step: e.data.step,
      data: e.data,
    }));
  }

  async getMetrics(): Promise<WorkflowMetrics> {
    const successRate =
      this.executionCount > 0
        ? (this.successCount / this.executionCount) * 100
        : 0;
    const avgDuration =
      this.executionCount > 0 ? this.totalDuration / this.executionCount : 0;

    return {
      totalExecutions: this.executionCount,
      successRate,
      avgDuration,
    };
  }
}

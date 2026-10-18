import { boundedShutdown, shutdownTimeout, type ShutdownOptions } from '../core/shutdown.js';
import { OperationObserver } from '../instrumentation.js';
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
import { randomUUID as uuidv4, createHash } from "node:crypto";
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
  onError?: ErrorHandler<any>;
  compensate?: Function;
  options?: any;
  steps?: StepDefinition[]; // for parallel/branch-then
  elseSteps?: StepDefinition[]; // for branch-else
  condition?: (
    ctx: WorkflowContext<any>,
  ) => boolean | Promise<boolean> | number;
};

export class WorkflowBuilderImpl<T = any> implements WorkflowBuilder<T> {
  private definitionVersion = '1';
  version(version: string): WorkflowBuilder<T> {
    if (!version.trim()) throw new Error('Workflow version is required');
    this.definitionVersion = version;
    return this;
  }
  private leaseDuration = 30_000;
  ownership(options: { leaseDuration: number }): WorkflowBuilder<T> {
    if (!Number.isSafeInteger(options.leaseDuration) || options.leaseDuration <= 0) throw new Error('Invalid workflow lease duration');
    this.leaseDuration = options.leaseDuration;
    return this;
  }
  public steps: StepDefinition[] = [];
  private name: string;
  private adapter: FlowAdapter;

  constructor(
    name: string,
    adapter: FlowAdapter,
    private onBuild?: (workflow: WorkflowImpl<T>) => void,
    private scope = "",
    private onEvent?: (event: string, data: any) => void,
    private observer = new OperationObserver(),
  ) {
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
    condition: (ctx: WorkflowContext<T>) => number,
  ): WorkflowBuilder<T> {
    this.steps.push({ type: "delayUntil", condition });
    return this;
  }

  waitForApproval(
    approver: string,
    options: ApprovalOptions<T>,
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
    if (!s) throw new Error(`Unknown step: ${step}`);
    s.onError = handler;
    return this;
  }

  compensate(step: string, handler: CompensateHandler<T>): WorkflowBuilder<T> {
    const s = this.steps.find((s) => s.name === step);
    if (!s) throw new Error(`Unknown step: ${step}`);
    s.compensate = handler;
    return this;
  }

  build(): Workflow<T> {
    const workflow = new WorkflowImpl<T>(
      this.name,
      this.steps,
      this.adapter,
      this.scope,
      this.onEvent,
      this.leaseDuration,
      this.definitionVersion,
      this.observer,
    );
    this.onBuild?.(workflow);
    return workflow;
  }
}

interface Checkpoint extends WorkflowExecution {
  definitionHash: string;
  receivedSignals: string[];
  journal: Record<
    string,
    { output?: any; branch?: boolean; completed: boolean }
  >;
  compensations: string[];
  compensated: string[];
  history: WorkflowEvent[];
  inbox: Array<{ name: string; data: any }>;
  waits: Record<string, import("./types.js").WorkflowWait>;
  waitResults: Record<string, any>;
}
interface Runtime {
  record: Checkpoint;
  controller: AbortController;
  task?: Promise<void>;
  writes: Promise<void>;
  signals: Promise<void>;
  wakes: Set<() => void>;
  settling: boolean;
  token: string;
  lost: boolean;
  leaseLost: AbortController;
  deadline: number;
  timer?: ReturnType<typeof setInterval>;
}
export class WorkflowCancelledError extends Error {
  constructor() {
    super("Workflow cancelled");
    this.name = "WorkflowCancelledError";
  }
}
export class WorkflowOwnershipError extends Error {
  constructor() { super('Workflow execution is owned or changed'); this.name = 'WorkflowOwnershipError'; }
}
export class WorkflowTimeoutError extends Error {
  constructor(name: string) {
    super(`Workflow wait timed out: ${name}`);
    this.name = "WorkflowTimeoutError";
  }
}
const clone = <V>(value: V): V => structuredClone(value);
const terminal = (status: string) =>
  ["completed", "failed", "cancelled"].includes(status);
const durationMs = (value: Duration): number => {
  const factors: Record<string, number> = {
    ms: 1,
    seconds: 1000,
    minutes: 60000,
    hours: 3600000,
    days: 86400000,
  };
  let total = 0;
  for (const [key, amount] of Object.entries(value)) {
    if (
      !(key in factors) ||
      typeof amount !== "number" ||
      !Number.isFinite(amount) ||
      amount < 0
    )
      throw new Error("Duration must contain nonnegative finite units");
    total += amount * factors[key];
  }
  if (!Number.isSafeInteger(total))
    throw new Error("Duration must resolve to safe integer milliseconds");
  return total;
};

export class WorkflowImpl<T = any> implements Workflow<T> {
  readonly id: string;
  readonly name: string;
  private steps: StepDefinition[];
  private active = new Map<string, Runtime>();
  private tasks = new Map<string, Promise<void>>();
  private known = new Map<string, Checkpoint>();
  private definitions = new Map<string, StepDefinition>();
  private closed = false;
  private closing?: Promise<void>;
  private catalogWrites: Promise<void> = Promise.resolve();
  private definitionHash: string;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private recoveryTask?: Promise<number>;
  constructor(
    name: string,
    steps: StepDefinition[],
    private adapter: FlowAdapter,
    scope = "",
    private onEvent?: (event: string, data: any) => void,
    private leaseDuration = 30_000,
    definitionVersion = '1',
    private observer = new OperationObserver(),
  ) {
    if (!name) throw new Error("Workflow name is required");
    this.name = name;
    this.id = createHash("sha256")
      .update(JSON.stringify([scope, name]))
      .digest("hex");
    const copy = (items: StepDefinition[], prefix = ""): StepDefinition[] =>
      items.map((step, index) => {
        const key = `${prefix}${index}`;
        const result = {
          ...step,
          options: step.options ? { ...step.options } : undefined,
          steps: step.steps ? copy(step.steps, `${key}.then.`) : undefined,
          elseSteps: step.elseSteps
            ? copy(step.elseSteps, `${key}.else.`)
            : undefined,
        };
        this.definitions.set(key, result);
        return result;
      });
    this.steps = copy(steps);
    this.definitionHash = createHash('sha256').update(JSON.stringify([definitionVersion, this.steps], (_key, value) => typeof value === 'function' ? '[callback]' : value)).digest('hex');
  }
  private ensureOpen() {
    if (this.closed) throw new Error("Workflow is closed");
  }
  private event(record: Checkpoint, type: string, data: any = {}) {
    record.history.push({
      timestamp: Date.now(),
      type,
      step: data.step,
      data: clone(data),
    });
    if (type.startsWith("execution.")) {
      try {
        this.onEvent?.(type.replace("execution.", "workflow:"), {
          workflowId: this.id,
          workflowName: this.name,
          executionId: record.id,
          ...clone(data),
        });
      } catch {
        /* Observers cannot change workflow control flow. */
      }
    }
  }
  private persist(runtime: Runtime): Promise<void> {
    if (runtime.lost) return Promise.reject(new Error('Workflow lease lost'));
    runtime.record.updatedAt = Date.now();
    const snapshot = clone(runtime.record);
    runtime.writes = runtime.writes.then(async () => {
      if (runtime.lost) throw new Error('Workflow lease lost');
      const saved = await this.adapter.mutateWorkflowState!(snapshot.id, {
        expectedRevision: runtime.record.revision ?? 0,
        state: snapshot, token: runtime.token,
        release: snapshot.completedAt !== undefined,
      });
      if (!saved) { this.loseOwnership(runtime); throw new Error('Workflow lease lost'); }
      runtime.record.revision = saved.revision;
      runtime.record.lease = saved.lease;
    });
    return new Promise<void>((resolve, reject) => {
      const lost = () => reject(new Error('Workflow lease lost'));
      runtime.leaseLost.signal.addEventListener('abort', lost, { once: true });
      runtime.writes.then(resolve, reject).finally(() => runtime.leaseLost.signal.removeEventListener('abort', lost));
    });
  }
  private loseOwnership(runtime: Runtime): void {
    runtime.lost = true;
    if (runtime.timer) clearInterval(runtime.timer);
    runtime.leaseLost.abort();
    runtime.controller.abort();
  }
  private async acquire(runtime: Runtime, fresh: boolean): Promise<void> {
    if (!this.adapter.mutateWorkflowState) throw new Error('Adapter must support atomic workflow ownership');
    const started = performance.now();
    const saved = await this.adapter.mutateWorkflowState(runtime.record.id, {
      expectedRevision: fresh ? null : runtime.record.revision ?? 0,
      state: runtime.record, token: runtime.token, acquire: this.leaseDuration,
    });
    if (!saved) throw new WorkflowOwnershipError();
    runtime.record.revision = saved.revision;
    runtime.record.lease = saved.lease;
    runtime.deadline = started + this.leaseDuration;
    let pending = false;
    runtime.timer = setInterval(() => {
      if (runtime.lost) return;
      if (performance.now() >= runtime.deadline) { this.loseOwnership(runtime); return; }
      if (pending) return;
      pending = true;
      const renewal = runtime.writes.then(async () => {
        if (runtime.lost) return;
        const started = performance.now();
        const saved = await this.adapter.mutateWorkflowState!(runtime.record.id, {
          expectedRevision: runtime.record.revision ?? 0, token: runtime.token, renew: this.leaseDuration,
        });
        if (!saved) { this.loseOwnership(runtime); return; }
        runtime.record.revision = saved.revision;
        runtime.record.lease = saved.lease;
        runtime.deadline = started + this.leaseDuration;
      });
      runtime.writes = renewal.catch(() => undefined);
      void renewal.finally(() => { pending = false; }).catch(() => undefined);
    }, Math.min(2147483647, Math.max(1, Math.floor(this.leaseDuration / 3))));
  }
  private runtime(record: Checkpoint): Runtime {
    const runtime: Runtime = {
      record,
      controller: new AbortController(),
      writes: Promise.resolve(),
      signals: Promise.resolve(),
      settling: false,
      wakes: new Set(),
      token: uuidv4(), lost: false, deadline: 0, leaseLost: new AbortController(),
    };
    this.active.set(record.id, runtime);
    this.known.set(record.id, record);
    return runtime;
  }
  async execute(input: T): Promise<WorkflowExecution> {
    this.ensureOpen();
    const record: Checkpoint = {
      id: uuidv4(),
      definitionHash: this.definitionHash,
      receivedSignals: [],
      workflowId: this.id,
      status: "running",
      input: clone(input),
      state: {},
      startedAt: Date.now(),
      createdAt: Date.now(),
      journal: {},
      compensations: [],
      compensated: [],
      history: [],
      inbox: [],
      waits: {},
      waitResults: {},
    };
    const runtime = this.runtime(record);
    this.event(record, "execution.started");
    try {
      await this.acquire(runtime, true);
      await this.indexExecution(record.id);
      this.ensureOpen();
    } catch (error) {
      this.loseOwnership(runtime);
      if (runtime.timer) clearInterval(runtime.timer);
      this.active.delete(record.id);
      this.known.delete(record.id);
      throw error;
    }
    runtime.task = this.run(runtime);
    this.tasks.set(record.id, runtime.task);
    // Retain failures for waitForCompletion without unhandled background rejection.
    void runtime.task.catch(() => undefined);
    return this.publicRecord(record);
  }
  private publicRecord(record: Checkpoint): WorkflowExecution {
    const {
      journal,
      compensations,
      compensated,
      history,
      inbox,
      waits,
      waitResults,
      receivedSignals,
      ...publicRecord
    } = record;
    return clone(publicRecord);
  }
  private check(runtime: Runtime) {
    if (runtime.controller.signal.aborted) throw new WorkflowCancelledError();
  }
  private async sleep(runtime: Runtime, deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      this.check(runtime);
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          runtime.controller.signal.removeEventListener("abort", onAbort);
          reject(new WorkflowCancelledError());
        };
        const timer = setTimeout(
          () => {
            runtime.controller.signal.removeEventListener("abort", onAbort);
            resolve();
          },
          Math.min(deadline - Date.now(), 2147483647),
        );
        runtime.controller.signal.addEventListener("abort", onAbort, {
          once: true,
        });
      });
    }
    this.check(runtime);
  }
  private async wait(
    runtime: Runtime,
    kind: "event" | "approval",
    name: string,
    key: string,
    timeout?: number,
    data?: any,
  ): Promise<any> {
    this.check(runtime);
    if (!name) throw new Error("Wait name is required");
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0))
      throw new Error("Wait timeout must be nonnegative");
    const record = runtime.record;
    if (Object.prototype.hasOwnProperty.call(record.waitResults, key))
      return clone(record.waitResults[key]);
    record.waits[key] ??= {
      kind,
      key,
      name,
      deadline: timeout === undefined ? undefined : Date.now() + timeout,
      data: clone(data),
    };
    this.syncWaits(record);
    this.event(record, `${kind}.waiting`, { name, data });
    await this.persist(runtime);
    for (;;) {
      this.check(runtime);
      await this.receiveSignals(runtime);
      this.check(runtime);
      const deadline = record.waits[key].deadline;
      if (deadline !== undefined && Date.now() >= deadline) {
        delete record.waits[key];
        this.syncWaits(record);
        this.event(record, `${kind}.timeout`, { name });
        await this.persist(runtime);
        throw new WorkflowTimeoutError(name);
      }
      const index = record.inbox.findIndex(
        (item) => item.name === `${kind}:${name}`,
      );
      if (index >= 0) {
        const [item] = record.inbox.splice(index, 1);
        record.waitResults[key] = clone(item.data);
        delete record.waits[key];
        this.syncWaits(record);
        this.event(record, `${kind}.received`, { name, data: item.data });
        await this.persist(runtime);
        return clone(item.data);
      }
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          runtime.controller.signal.removeEventListener("abort", abort);
          runtime.wakes.delete(wake);
        };
        const wake = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(new WorkflowCancelledError());
        };
        runtime.wakes.add(wake);
        runtime.controller.signal.addEventListener("abort", abort, {
          once: true,
        });
        timer = setTimeout(wake, deadline === undefined ? 100 : Math.min(100, Math.max(0, deadline - Date.now())));
      });
    }
  }
  private syncWaits(record: Checkpoint): void {
    record.waitingFor = Object.values(record.waits);
    record.waiting = record.waitingFor[0];
  }
  private async run(runtime: Runtime): Promise<void> {
    const record = runtime.record;
    const context: WorkflowContext<T> = {
      signal: runtime.controller.signal,
      workflowId: this.id,
      executionId: record.id,
      input: clone(record.input),
      state: record.state!,
      metadata: {},
      set: (key, value) => {
        this.check(runtime);
        record.state![key] = clone(value);
      },
      get: (key) => record.state![key],
      sleep: async (ms) => {
        const deadline = Date.now() + durationMs({ ms });
        await this.persist(runtime);
        await this.sleep(runtime, deadline);
      },
      waitForEvent: (name, timeout) =>
        this.wait(runtime, "event", name, `context:${name}`, timeout),
    };
    try {
      if (record.status === "failed")
        throw new Error(record.error?.message ?? "Recovered failed execution");
      if (record.status === "cancelled") runtime.controller.abort();
      const result = await this.executeSteps(this.steps, context, runtime);
      this.check(runtime);
      record.output =
        result === undefined ? clone(record.state) : clone(result);
      record.status = "completed";
      this.event(record, "execution.completed", { output: record.output });
    } catch (error) {
      if (runtime.lost) throw new Error('Workflow lease lost');
      runtime.settling = true;
      record.status = runtime.controller.signal.aborted
        ? "cancelled"
        : "failed";
      record.error = {
        name: (error as Error)?.name ?? "Error",
        message: (error as Error)?.message ?? String(error),
      };
      this.event(record, `execution.${record.status}`, { error: record.error });
      // Compensation runs after in-flight parallel handlers have settled. It has a fresh signal.
      const rollbackContext = {
        ...context,
        signal: new AbortController().signal,
        set: (key: string, value: any) => {
          record.state![key] = clone(value);
        },
        sleep: (ms: number) =>
          new Promise<void>((resolve) =>
            setTimeout(resolve, durationMs({ ms })),
          ),
      };
      for (const key of [...record.compensations].reverse()) {
        if (record.compensated.includes(key)) continue;
        const step = this.definitions.get(key)!;
        try {
          await this.observer.run('flowfn.workflow.compensate', { 'flowfn.workflow': this.name, 'flowfn.execution.id': record.id, 'flowfn.step': step.name ?? key }, () => step.compensate?.(rollbackContext));
          record.compensated.push(key);
          this.event(record, "compensation.completed", { step: step.name });
        } catch (failure) {
          const detail = {
            step: step.name ?? key,
            message: (failure as Error)?.message ?? String(failure),
          };
          (record.compensationErrors ??= []).push(detail);
          this.event(record, "compensation.failed", detail);
        }
        await this.persist(runtime);
      }
    } finally {
      if (runtime.lost) {
        if (runtime.timer) clearInterval(runtime.timer);
        this.active.delete(record.id);
        throw new Error('Workflow lease lost');
      }
      runtime.settling = true;
      record.waits = {};
      this.syncWaits(record);
      record.completedAt = Date.now();
      try {
        await this.persist(runtime);
      } finally {
        if (runtime.timer) clearInterval(runtime.timer);
        this.active.delete(record.id);
      }
    }
  }
  private async executeSteps(
    steps: StepDefinition[],
    context: WorkflowContext<T>,
    runtime: Runtime,
    prefix = "",
    previous?: any,
  ): Promise<any> {
    const record = runtime.record;
    for (const [index, step] of steps.entries()) {
      this.check(runtime);
      const key = `${prefix}${index}`,
        saved = record.journal[key];
      if (saved?.completed) {
        previous = clone(saved.output);
        continue;
      }
      let output: any = previous;
      this.event(record, "step.started", { step: step.name ?? step.type });
      await this.persist(runtime);
      try {
        await this.observer.run('flowfn.workflow.step', { 'flowfn.workflow': this.name, 'flowfn.execution.id': record.id, 'flowfn.step': step.name ?? step.type }, async () => {
        if ((step.type === "step" || step.type === "saga") && step.handler) {
          let waitIndex = 0;
          const stepContext = {
            ...context,
            waitForEvent: (name: string, timeout?: number) =>
              this.wait(
                runtime,
                "event",
                name,
                `${key}:context:${waitIndex++}`,
                timeout,
              ),
          };
          output = await step.handler(stepContext, previous);
          // A handler may finish a side effect after cancellation; record it before rollback.
          if (step.compensate && !record.compensations.includes(key))
            record.compensations.push(key);
        } else if (step.type === "parallel") {
          const settled = await Promise.allSettled(
            (step.steps ?? []).map((child, childIndex) =>
              this.executeSteps(
                [child],
                context,
                runtime,
                `${key}.then.${childIndex}.`,
                previous,
              ),
            ),
          );
          const failed = settled.find((item) => item.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
          output = settled.map(
            (item) => (item as PromiseFulfilledResult<any>).value,
          );
        } else if (step.type === "branch") {
          const condition =
            saved?.branch ?? Boolean(await step.condition!(context));
          record.journal[key] = { completed: false, branch: condition };
          await this.persist(runtime);
          output = await this.executeSteps(
            condition ? (step.steps ?? []) : (step.elseSteps ?? []),
            context,
            runtime,
            `${key}.${condition ? "then" : "else"}.`,
            previous,
          );
        } else if (step.type === "delay" || step.type === "delayUntil") {
          const deadline = record.waits[key]
            ? record.waits[key].deadline!
            : step.type === "delay"
              ? Date.now() + durationMs(step.options)
              : Number(await step.condition!(context));
          if (!Number.isFinite(deadline))
            throw new Error("delayUntil must return a finite timestamp");
          record.waits[key] = { kind: "delay", key, deadline };
          this.syncWaits(record);
          await this.persist(runtime);
          await this.sleep(runtime, deadline);
          delete record.waits[key];
          this.syncWaits(record);
        } else if (step.type === "wait") {
          if (step.name === "approval") {
            try {
              output = await this.wait(
                runtime,
                "approval",
                step.options.approver,
                key,
                step.options.timeout,
                step.options.data?.(context),
              );
            } catch (error) {
              if (error instanceof WorkflowTimeoutError)
                await step.options.onTimeout?.(context);
              throw error;
            }
          } else
            output = await this.wait(
              runtime,
              "event",
              step.options.event,
              key,
              step.options.timeout,
            );
        }
        record.journal[key] = {
          ...record.journal[key],
          completed: true,
          output: clone(output),
        };
        this.event(record, "step.completed", { step: step.name ?? step.type });
        await this.persist(runtime);
        this.check(runtime);
        });
      } catch (error) {
        if (runtime.lost) throw new Error('Workflow lease lost');
        this.event(record, "step.failed", {
          step: step.name ?? step.type,
          error: (error as Error)?.message ?? String(error),
        });
        if (!(error instanceof WorkflowCancelledError)) {
          try {
            await step.onError?.(context, error as Error);
          } catch (handlerError) {
            this.event(record, "error-handler.failed", {
              step: step.name,
              error: String(handlerError),
            });
          }
        }
        throw error;
      }
      previous = output;
    }
    return previous;
  }
  private async load(executionId: string): Promise<Checkpoint> {
    const active = this.active.get(executionId);
    if (active) return active.record;
    const record = (await this.adapter.loadWorkflowState(
      executionId,
    )) as Checkpoint | null;
    if (!record || record.workflowId !== this.id)
      throw new Error(
        `Execution ${executionId} not found in workflow ${this.name}`,
      );
    const owned = clone(record);
    this.known.set(executionId, owned);
    return owned;
  }
  async getExecution(executionId: string): Promise<WorkflowExecution> {
    return this.publicRecord(await this.load(executionId));
  }
  private async indexExecution(executionId: string): Promise<void> {
    const operation = this.catalogWrites.then(async () => {
      const key = `${this.id}:catalog`;
      for (;;) {
      const existing = await this.adapter.loadWorkflowState(key);
      const ids: string[] = existing?.state?.executionIds ?? [];
      if (!ids.includes(executionId)) ids.push(executionId);
      const saved = await this.adapter.mutateWorkflowState!(key, { expectedRevision: existing ? existing.revision ?? 0 : null, state: {
        id: key,
        workflowId: this.id,
        status: "completed",
        input: null,
        startedAt: 0,
        state: { executionIds: ids },
      }});
      if (saved) break;
      }
    });
    this.catalogWrites = operation.catch(() => undefined);
    await operation;
  }
  private async loadCatalog(): Promise<void> {
    await this.catalogWrites;
    const catalog = await this.adapter.loadWorkflowState(`${this.id}:catalog`);
    for (const id of catalog?.state?.executionIds ?? []) await this.load(id);
  }
  async listExecutions(
    options: ListOptions = {},
  ): Promise<WorkflowExecution[]> {
    await this.loadCatalog();
    for (const value of [options.limit, options.offset])
      if (value !== undefined && (!Number.isInteger(value) || value < 0))
        throw new Error("Pagination must use nonnegative integers");
    return [...this.known.values()]
      .filter((record) => !options.status || record.status === options.status)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(
        options.offset ?? 0,
        (options.offset ?? 0) + (options.limit ?? this.known.size),
      )
      .map((record) => this.publicRecord(record));
  }
  private async sendSignal(record: Checkpoint, name: string, data: any, unique = false): Promise<void> {
    if (!this.adapter.mutateWorkflowState) throw new Error('Adapter must support atomic workflow signals');
    const key = `${record.id}:inbox`;
    const message = { id: uuidv4(), name, data: clone(data) };
    for (;;) {
      const inbox = await this.adapter.loadWorkflowState(key);
      const messages: Array<typeof message> = inbox?.state?.messages ?? [];
      if (messages.length + record.inbox.length >= 1024) throw new Error('Execution event inbox is full');
      if (unique && messages.some(item => item.name === name)) throw new Error('Approval already supplied');
      const saved = await this.adapter.mutateWorkflowState(key, { expectedRevision: inbox ? inbox.revision ?? 0 : null, state: {
        id: key, workflowId: this.id, status: 'running', input: null, startedAt: record.startedAt, state: { messages: [...messages, message] },
      } });
      if (saved) return;
    }
  }
  private receiveSignals(runtime: Runtime): Promise<void> {
    runtime.signals = runtime.signals.then(() => this.receiveSignalsOwned(runtime));
    return runtime.signals;
  }
  private async receiveSignalsOwned(runtime: Runtime): Promise<void> {
    const key = `${runtime.record.id}:inbox`;
    for (;;) {
      const inbox = await this.adapter.loadWorkflowState(key);
      const messages: Array<{ id: string; name: string; data: any }> = inbox?.state?.messages ?? [];
      if (!messages.length) return;
      const record = runtime.record;
      record.receivedSignals ??= [];
      const incoming = messages.filter(item => !record.receivedSignals.includes(item.id));
      if (incoming.length) {
        record.inbox.push(...incoming.map(({ name, data }) => ({ name, data: clone(data) })));
        record.receivedSignals.push(...incoming.map(item => item.id));
        // Checkpoint receipt before acknowledging the inbox so crashes cannot lose signals.
        await this.persist(runtime);
      }
      const saved = await this.adapter.mutateWorkflowState!(key, { expectedRevision: inbox!.revision!, state: { ...inbox!, state: { messages: [] } } });
      if (saved) return;
    }
  }
  async signalEvent(
    executionId: string,
    event: string,
    data?: any,
  ): Promise<void> {
    if (!event) throw new Error("Event name is required");
    const record = await this.load(executionId);
    const runtime = this.active.get(executionId);
    if (terminal(record.status) || runtime?.settling)
      throw new Error("Execution is not active");
    await this.sendSignal(record, `event:${event}`, data);
    if (runtime) await this.receiveSignals(runtime);
    for (const wake of [...runtime?.wakes ?? []]) wake();
  }
  async approveExecution(
    executionId: string,
    decision: import("./types.js").ApprovalDecision,
  ): Promise<void> {
    const record = await this.load(executionId);
    const runtime = this.active.get(executionId);
    const pending = Object.values(record.waits ?? {}).filter(
      (wait) =>
        wait.kind === "approval" &&
        (decision.approver === undefined || wait.name === decision.approver),
    );
    if (pending.length > 1) throw new Error("Approval role is ambiguous");
    const waiting = pending[0];
    if (
      runtime?.settling ||
      waiting?.kind !== "approval" ||
      terminal(record.status)
    )
      throw new Error(
        "Execution is not waiting for approval or approval role does not match",
      );
    if (
      typeof decision.approved !== "boolean" ||
      typeof decision.reviewedBy !== "string" ||
      !decision.reviewedBy.trim()
    )
      throw new Error(
        "Approval requires a boolean decision and reviewer identity",
      );
    if (decision.approver !== undefined && decision.approver !== waiting.name)
      throw new Error("Approval role does not match");
    if (waiting.deadline !== undefined && Date.now() >= waiting.deadline)
      throw new Error("Approval deadline has expired");
    if (
      record.inbox.some(
        (item) => item.name === `approval:${waiting.name}`,
      )
    )
      throw new Error("Approval already supplied");
    await this.sendSignal(record, `approval:${waiting.name}`, decision, true);
    if (runtime) await this.receiveSignals(runtime);
    for (const wake of [...runtime?.wakes ?? []]) wake();
  }
  async cancelExecution(executionId: string): Promise<void> {
    const runtime = this.active.get(executionId);
    if (!runtime || terminal(runtime.record.status) || runtime.settling)
      throw new Error("Cannot cancel an inactive execution");
    runtime.record.status = "cancelled";
    runtime.controller.abort();
    await this.persist(runtime);
  }
  async retryExecution(executionId: string): Promise<WorkflowExecution> {
    const record = await this.load(executionId);
    if (record.status !== "failed")
      throw new Error("Can only retry failed executions");
    return this.execute(record.input);
  }
  async resumeExecution(executionId: string): Promise<WorkflowExecution> {
    this.ensureOpen();
    if (this.active.has(executionId))
      throw new WorkflowOwnershipError();
    const record = await this.load(executionId);
    if (this.active.has(executionId)) throw new WorkflowOwnershipError();
    if (!record.journal || !record.waits || !record.waitResults)
      throw new Error("Execution predates recoverable workflow checkpoints");
    if (record.definitionHash !== this.definitionHash) throw new Error('Workflow definition differs from checkpoint');
    if (record.completedAt !== undefined)
      throw new Error("Cannot resume terminal execution");
    const runtime = this.runtime(record);
    try {
      await this.acquire(runtime, false);
      this.event(record, "execution.resumed");
      await this.persist(runtime);
      this.ensureOpen();
    } catch (error) {
      this.loseOwnership(runtime);
      if (runtime.timer) clearInterval(runtime.timer);
      this.active.delete(record.id);
      this.known.delete(record.id);
      throw error;
    }
    runtime.task = this.run(runtime);
    this.tasks.set(record.id, runtime.task);
    void runtime.task.catch(() => undefined);
    return this.publicRecord(record);
  }
  async waitForCompletion(executionId: string): Promise<WorkflowExecution> {
    for (;;) {
      await this.tasks.get(executionId);
      const execution = await this.getExecution(executionId);
      if (execution.completedAt !== undefined) return execution;
      this.ensureOpen();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  async recoverExecutions(): Promise<number> {
    this.ensureOpen();
    await this.loadCatalog();
    let recovered = 0;
    for (const record of [...this.known.values()]) {
      if (this.closed) break;
      if (record.completedAt !== undefined || this.active.has(record.id)) continue;
      try { await this.resumeExecution(record.id); recovered++; }
      catch (error) { if (!(error instanceof WorkflowOwnershipError)) throw error; }
    }
    return recovered;
  }
  async startRecovery(options: { interval?: number } = {}): Promise<void> {
    this.ensureOpen();
    const interval = options.interval ?? 1000;
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > 2147483647) throw new Error('Invalid recovery interval');
    if (this.recoveryTimer || this.recoveryTask) throw new Error('Recovery is already running');
    const run = async () => {
      this.recoveryTask = this.recoverExecutions();
      try { await this.recoveryTask; }
      finally {
        this.recoveryTask = undefined;
        if (!this.closed) this.recoveryTimer = setTimeout(() => { void run().catch(error => {
          try { this.onEvent?.('workflow:recovery-error', { workflowId: this.id, message: String(error) }); } catch { /* Observers cannot interrupt recovery. */ }
        }); }, interval);
      }
    };
    await run();
  }
  async getExecutionHistory(executionId: string): Promise<WorkflowEvent[]> {
    return clone((await this.load(executionId)).history ?? []);
  }
  async getMetrics(): Promise<WorkflowMetrics> {
    await this.loadCatalog();
    const done = [...this.known.values()].filter(
      (record) => record.completedAt !== undefined,
    );
    return {
      totalExecutions: this.known.size,
      successRate: done.length
        ? (done.filter((record) => record.status === "completed").length /
            done.length) *
          100
        : 0,
      avgDuration: done.length
        ? done.reduce(
            (sum, record) => sum + record.completedAt! - record.startedAt,
            0,
          ) / done.length
        : 0,
    };
  }
  close(options: ShutdownOptions = {}): Promise<void> {
    const timeout = shutdownTimeout(options);
    if (this.closing) return this.closing;
    this.closed = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    for (const runtime of this.active.values()) runtime.controller.abort();
    const work = (async () => {
      await this.recoveryTask?.catch(() => undefined);
      const runtimes = [...this.active.values()];
      for (const runtime of runtimes) runtime.controller.abort();
      await Promise.all(runtimes.map(runtime => runtime.task));
    })();
    return this.closing = boundedShutdown(work, timeout, `Workflow ${this.name}`, () => {
      for (const runtime of this.active.values()) this.loseOwnership(runtime);
      this.active.clear();
      this.tasks.clear();
    });
  }
}

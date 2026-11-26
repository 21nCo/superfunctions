import type { ExecutionCoordinator } from './execution-coordinator.js';
import type {
  Workflow,
  WorkflowContext,
  WorkflowExecution,
  WorkflowStats,
  ListWorkflowsOptions,
  WorkflowStep,
  WorkflowAction,
  WorkflowCondition,
  WorkflowErrorHandlerFn,
  WorkflowRuntimeRegistry,
} from '../types/workflow.js';
import { WorkflowStatus, WorkflowExecutionStatus } from '../types/workflow.js';
import type { Logger } from '../types/action.js';
import { WorkflowStorage } from '../storage/workflow-storage.js';
import {
  WebhookHandler,
  WebhookHandlerError,
  isBindingId,
  webhookBindingRevoked,
} from '../webhooks/webhook-handler.js';
import type { ScopedTriggerHandler, WebhookWorkflowBinding } from '../types/trigger.js';

interface PersistedWorkflowState {
  idempotencyKey?: string;
  completedStepIds: string[];
  retriable: boolean;
  resumed: boolean;
  failedStepId?: string;
  errorCode?: string;
}

interface WorkflowTriggerScope {
  provider: string;
  event: string;
  scope: WebhookWorkflowBinding;
}

interface WorkflowTriggerBinding extends WorkflowTriggerScope {
  handler: ScopedTriggerHandler;
}

interface WorkflowExecutionAdmission extends WorkflowTriggerScope {
  bindingIsCurrent(): Promise<boolean>;
  revoked: AbortSignal;
}

class WorkflowBindingChanged extends Error {}

export class WorkflowEngineError extends Error {
  readonly code:
    | 'WORKFLOW_TRIGGER_UNREGISTER_FAILED'
    | 'WORKFLOW_DURABILITY_UNSUPPORTED'
    | 'WORKFLOW_DEFINITION_INVALID';
  readonly status: number;
  readonly retryable = false;
  readonly details: Record<string, unknown>;

  constructor(
    code:
      | 'WORKFLOW_TRIGGER_UNREGISTER_FAILED'
      | 'WORKFLOW_DURABILITY_UNSUPPORTED'
      | 'WORKFLOW_DEFINITION_INVALID',
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'WorkflowEngineError';
    this.code = code;
    this.status = 409;
    this.details = details;
  }
}

export class WorkflowEngine {
  private readonly triggerBindings = new Map<string, WorkflowTriggerBinding>();
  private readonly skippedUnboundTriggers = new Set<string>();
  private readonly executionLocks = new Map<string, Promise<void>>();
  private readonly persistedFailures = new WeakSet<Error>();

  constructor(
    private workflowStorage: WorkflowStorage,
    private webhookHandler: WebhookHandler,
    private logger: Logger,
    private runtime: WorkflowRuntimeRegistry = {},
    private coordinator?: ExecutionCoordinator
  ) {}

  async create(workflow: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'>): Promise<Workflow> {
    assertUniqueWorkflowStepIds(workflow.definition.steps);
    const created = await this.workflowStorage.create(workflow);

    if (workflow.status === WorkflowStatus.Enabled) {
      this.registerTrigger(created);
    }

    this.logger.info(`Workflow created: ${created.name}`, { workflowId: created.id });
    return created;
  }

  async get(id: string): Promise<Workflow | null> {
    return this.workflowStorage.get(id);
  }

  async list(options?: ListWorkflowsOptions): Promise<Workflow[]> {
    return this.workflowStorage.list(options?.userId, options?.status);
  }

  async rehydrateEnabledTriggers(): Promise<{ registered: number; failed: number }> {
    const workflows = await this.workflowStorage.list(undefined, WorkflowStatus.Enabled);
    let registered = 0;
    let failed = 0;

    for (const workflow of workflows) {
      try {
        if (this.registerTrigger(workflow)) {
          registered += 1;
        }
      } catch (error) {
        failed += 1;
        this.logger.error('Workflow trigger rehydration failed', {
          workflowId: workflow.id,
          errorCode: 'WORKFLOW_TRIGGER_REHYDRATION_FAILED',
        });
      }
    }

    return { registered, failed };
  }

  async enable(id: string): Promise<void> {
    const workflow = await this.workflowStorage.get(id);
    if (!workflow) {
      throw new Error(`Workflow ${id} not found`);
    }
    assertUniqueWorkflowStepIds(workflow.definition.steps);

    const updated = await this.workflowStorage.update(id, { status: WorkflowStatus.Enabled });
    this.registerTrigger(updated);

    this.logger.info(`Workflow enabled: ${workflow.name}`, { workflowId: id });
  }

  async disable(id: string): Promise<void> {
    const workflow = await this.workflowStorage.get(id);
    if (!workflow) {
      throw new Error(`Workflow ${id} not found`);
    }

    const updated = await this.workflowStorage.update(id, { status: WorkflowStatus.Disabled });
    this.unregisterTrigger(updated);

    this.logger.info(`Workflow disabled: ${workflow.name}`, { workflowId: id });
  }

  async delete(id: string): Promise<void> {
    const workflow = await this.workflowStorage.get(id);
    if (workflow && (workflow.status === WorkflowStatus.Enabled || this.triggerBindings.has(id))) {
      this.unregisterTrigger(workflow);
    }
    await this.workflowStorage.delete(id);
    this.skippedUnboundTriggers.delete(id);
    this.logger.info(`Workflow deleted`, { workflowId: id });
  }

  async execute(workflowId: string, triggerPayload: any): Promise<WorkflowExecution> {
    return this.runExecution(workflowId, triggerPayload);
  }

  private async runExecution(
    workflowId: string,
    triggerPayload: any,
    admission?: WorkflowExecutionAdmission
  ): Promise<WorkflowExecution> {
    if (this.coordinator) {
      const key = this.resolveIdempotencyKey(triggerPayload);
      if (!key) throw new Error("WORKFLOW_IDEMPOTENCY_KEY_REQUIRED");
      return this.coordinator.run(
        JSON.stringify([workflowId, key]),
        () => this.executeLocal(workflowId, triggerPayload, admission),
        {
          classifyFailure: (error) =>
            error instanceof WorkflowBindingChanged || error instanceof WebhookHandlerError ||
            (error instanceof Error && this.persistedFailures.has(error)) ? 'known' : 'uncertain',
        },
      );
    }
    return this.executeLocal(workflowId, triggerPayload, admission);
  }

  private async executeLocal(
    workflowId: string,
    triggerPayload: any,
    admission?: WorkflowExecutionAdmission
  ): Promise<WorkflowExecution> {
    const idempotencyKey = this.resolveIdempotencyKey(triggerPayload);
    const lockKey = idempotencyKey ? `${workflowId}:${idempotencyKey}` : undefined;
    const previousExecution = lockKey
      ? this.executionLocks.get(lockKey) ?? Promise.resolve()
      : Promise.resolve();
    let releaseExecutionLock: (() => void) | undefined;
    let queueTail: Promise<void> | undefined;
    if (lockKey) {
      const current = new Promise<void>((resolve) => {
        releaseExecutionLock = resolve;
      });
      queueTail = previousExecution.catch(() => {}).then(() => current);
      this.executionLocks.set(lockKey, queueTail);
    }

    await previousExecution.catch(() => {});

    try {
      let workflow = await this.workflowStorage.get(workflowId);
      assertWorkflowBindingActive(admission?.revoked);
      if (admission && !matchesWorkflowAdmission(workflow, admission)) {
        throw new WorkflowBindingChanged();
      }

      if (!workflow) {
        throw new Error(`Workflow ${workflowId} not found`);
      }
      if (workflow.status !== WorkflowStatus.Enabled) {
        throw new Error(`Workflow ${workflowId} is not enabled`);
      }
      assertUniqueWorkflowStepIds(workflow.definition.steps);

      const existingExecution = idempotencyKey
        ? await this.workflowStorage.findExecutionByIdempotencyKey(workflowId, idempotencyKey)
        : null;

      if (admission) {
        if (!(await admission.bindingIsCurrent())) {
          throw webhookBindingRevoked();
        }
        // Read the workflow after the asynchronous registry and execution checks.
        const current = await this.workflowStorage.get(workflowId);
        assertWorkflowBindingActive(admission.revoked);
        if (!matchesWorkflowAdmission(current, admission)) {
          throw new WorkflowBindingChanged();
        }
        if (
          current.userId !== workflow.userId ||
          current.updatedAt.valueOf() !== workflow.updatedAt.valueOf()
        ) {
          throw webhookBindingRevoked();
        }
        workflow = current;
        assertUniqueWorkflowStepIds(workflow.definition.steps);
      }

      if (existingExecution && existingExecution.status === WorkflowExecutionStatus.Completed) {
        return existingExecution;
      }

      const resumed = Boolean(existingExecution);
      const executionInput = this.buildExecutionInput(triggerPayload, idempotencyKey);
      const scopedInput = admission ? structuredClone(executionInput) : undefined;
      const execution =
        existingExecution ??
        (await this.workflowStorage.createExecution({
          workflowId,
          status: WorkflowExecutionStatus.Running,
          // Until the claim is rechecked, persist the key without the scoped payload.
          input: admission ? this.buildExecutionInput({}, idempotencyKey) : executionInput,
        }));

      if (existingExecution) {
        await this.workflowStorage.updateExecution(existingExecution.id, {
          status: WorkflowExecutionStatus.Running,
          error: undefined,
        });
      }

      const executionState = this.readExecutionState(existingExecution ?? null);
      const completedStepIds = [...executionState.completedStepIds];
      const contextData = { ...executionState.data };

      const context: WorkflowContext = {
        workflowId,
        executionId: execution.id,
        userId: workflow.userId,
        tenantId: workflow.tenantId,
        trigger: {
          provider: workflow.definition.trigger.provider,
          event: workflow.definition.trigger.event,
          connectionId: admission?.scope.connectionId,
          payload: triggerPayload,
        },
        data: contextData,
      };
      let includeScopedInput = false;
      const writeExecution = async (updates: Partial<WorkflowExecution>) => {
        await this.workflowStorage.updateExecution(execution.id, {
          ...(includeScopedInput ? { input: scopedInput } : {}),
          ...updates,
        });
        includeScopedInput = false;
      };
      const checkpointStep = async (stepId: string): Promise<void> => {
        if (!completedStepIds.includes(stepId)) {
          completedStepIds.push(stepId);
        }
        await writeExecution({
          status: WorkflowExecutionStatus.Running,
          output: this.buildExecutionOutput(context.data, {
            idempotencyKey,
            completedStepIds,
            retriable: false,
            resumed,
          }),
        });
      };

      const startedAtMs = execution.startedAt ? execution.startedAt.getTime() : Date.now();
      let activeStepId: string | undefined;

      try {
        assertWorkflowBindingActive(admission?.revoked);
        if (admission) {
          const current = await this.workflowStorage.get(workflowId);
          assertWorkflowBindingActive(admission.revoked);
          if (
            !matchesWorkflowAdmission(current, admission) ||
            current.userId !== workflow.userId ||
            current.updatedAt.valueOf() !== workflow.updatedAt.valueOf()
          ) {
            throw webhookBindingRevoked();
          }
          includeScopedInput = true;
        }
        if (workflow.definition.trigger.filter) {
          const shouldRun = this.resolveCondition(
            workflow.definition.trigger.filter,
            'workflow trigger filter'
          )(context);
          if (!shouldRun) {
            await writeExecution({
              status: WorkflowExecutionStatus.Completed,
              output: this.buildExecutionOutput(context.data, {
                idempotencyKey,
                completedStepIds,
                retriable: false,
                resumed,
              }),
              completedAt: new Date(),
              durationMs: Date.now() - startedAtMs,
            });

            const skippedExecution = await this.getExecutionById(workflowId, execution.id);
            return skippedExecution ?? execution;
          }
        }

        for (const step of workflow.definition.steps) {
          activeStepId = step.id;
          if (completedStepIds.includes(step.id)) {
            continue;
          }

          await this.executeStep(step, context, completedStepIds, checkpointStep, admission?.revoked);
          await checkpointStep(step.id);
        }

        await writeExecution({
          status: WorkflowExecutionStatus.Completed,
          output: this.buildExecutionOutput(context.data, {
            idempotencyKey,
            completedStepIds,
            retriable: false,
            resumed,
          }),
          completedAt: new Date(),
          durationMs: Date.now() - startedAtMs,
        });

        this.logger.info(`Workflow executed successfully: ${workflow.name}`, {
          workflowId,
          executionId: execution.id,
          duration: Date.now() - startedAtMs,
          resumed,
        });

        const completedExecution = await this.getExecutionById(workflowId, execution.id);
        return completedExecution ?? execution;
      } catch (error) {
        let failure = normalizeWorkflowExecutionFailure(
          admission?.revoked.aborted ? webhookBindingRevoked() : error
        );
        this.logger.error(`Workflow execution failed: ${workflow.name}`, {
          workflowId,
          executionId: execution.id,
          errorCode: failure.code,
        });

        if (failure.code !== 'WEBHOOK_WORKFLOW_BINDING_REVOKED' && workflow.definition.errorHandlers) {
          for (const errorHandler of workflow.definition.errorHandlers) {
            if (admission?.revoked.aborted) {
              break;
            }
            try {
              await this.resolveErrorHandler(
                errorHandler.handler,
                `workflow error handler${errorHandler.stepId ? ` for ${errorHandler.stepId}` : ''}`
              )(failure.error, context);
            } catch (handlerError) {
              this.logger.error('Error handler failed');
            }
          }
        }

        if (admission?.revoked.aborted) {
          failure = normalizeWorkflowExecutionFailure(webhookBindingRevoked());
        }
        await writeExecution({
          status: failure.code === 'WEBHOOK_WORKFLOW_BINDING_REVOKED'
            ? WorkflowExecutionStatus.Cancelled
            : WorkflowExecutionStatus.Failed,
          error: `${failure.code}:${failure.error.message}`,
          output: this.buildExecutionOutput(context.data, {
            idempotencyKey,
            completedStepIds,
            retriable: failure.retriable,
            resumed,
            failedStepId: activeStepId,
            errorCode: failure.code,
          }),
          completedAt: new Date(),
          durationMs: Date.now() - startedAtMs,
        });

        this.persistedFailures.add(failure.error);
        throw failure.error;
      }
    } finally {
      if (lockKey && releaseExecutionLock) {
        releaseExecutionLock();
        if (this.executionLocks.get(lockKey) === queueTail) {
          this.executionLocks.delete(lockKey);
        }
      }
    }
  }

  private async executeStep(
    step: WorkflowStep,
    context: WorkflowContext,
    completedStepIds: string[],
    checkpointStep: (stepId: string) => Promise<void>,
    revoked?: AbortSignal
  ): Promise<void> {
    assertWorkflowBindingActive(revoked);
    switch (step.type) {
      case 'action': {
        const result = await this.resolveAction(step.action, `action step ${step.id}`)(context);
        Object.assign(context.data, result);
        break;
      }

      case 'filter': {
        const shouldContinue = this.resolveCondition(
          step.condition,
          `filter step ${step.id}`
        )(context);
        if (!shouldContinue) {
          throw new Error('Filter condition not met');
        }
        break;
      }

      case 'branch': {
        await this.executeBranchStep(step, context, completedStepIds, checkpointStep, revoked);
        break;
      }

      case 'parallel': {
        await this.executeParallelStep(step, context, completedStepIds, checkpointStep, revoked);
        break;
      }

      case 'delay': {
        const ms = this.convertDelayToMs(step);
        throw new WorkflowEngineError(
          'WORKFLOW_DURABILITY_UNSUPPORTED',
          `delay step ${step.id} requires a durable scheduler`,
          {
            stepId: step.id,
            durationMs: ms,
          }
        );
      }

      default: {
        const unsupportedType = (step as { type?: unknown }).type;
        throw new Error(`Unknown workflow step type: ${String(unsupportedType)}`);
      }
    }
  }

  private async executeBranchStep(
    step: Extract<WorkflowStep, { type: 'branch' }>,
    context: WorkflowContext,
    completedStepIds: string[],
    checkpointStep: (stepId: string) => Promise<void>,
    revoked?: AbortSignal
  ): Promise<void> {
    const branch = this.resolveCondition(step.condition, `branch step ${step.id}`)(context)
      ? step.then
      : step.else;
    if (!branch) {
      return;
    }

    for (const branchStep of branch) {
      if (completedStepIds.includes(branchStep.id)) {
        continue;
      }
      await this.executeStep(branchStep, context, completedStepIds, checkpointStep, revoked);
      await checkpointStep(branchStep.id);
    }
  }

  private async executeParallelStep(
    step: Extract<WorkflowStep, { type: 'parallel' }>,
    context: WorkflowContext,
    completedStepIds: string[],
    checkpointStep: (stepId: string) => Promise<void>,
    revoked?: AbortSignal
  ): Promise<void> {
    const pendingActions = step.actions
      .map((action, index) => ({
        action: this.resolveAction(action, `parallel step ${step.id} action ${index}`),
        checkpointId: parallelActionCheckpointId(step.id, index),
      }))
      .filter(({ checkpointId }) => !completedStepIds.includes(checkpointId));
    const results = await Promise.allSettled(
      pendingActions.map(async ({ action }) => {
        assertWorkflowBindingActive(revoked);
        return action(context);
      })
    );

    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        await checkpointStep(pendingActions[index].checkpointId);
      }
    }

    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failure) {
      throw failure.reason;
    }
  }

  private convertDelayToMs(step: any): number {
    const { duration, unit = 'ms' } = step;

    switch (unit) {
      case 'ms':
        return duration;
      case 'seconds':
        return duration * 1000;
      case 'minutes':
        return duration * 60 * 1000;
      case 'hours':
        return duration * 60 * 60 * 1000;
      case 'days':
        return duration * 24 * 60 * 60 * 1000;
      default:
        return duration;
    }
  }

  private resolveAction(action: string | WorkflowAction, location: string): WorkflowAction {
    if (typeof action === 'function') return action;
    const resolved = this.runtime.actions?.[action];
    if (!resolved) throw this.missingRuntimeReference('action', action, location);
    return resolved;
  }

  private resolveCondition(
    condition: WorkflowCondition,
    location: string
  ): Exclude<WorkflowCondition, string> {
    if (typeof condition === 'function') return condition;
    const resolved = this.runtime.conditions?.[condition];
    if (!resolved) throw this.missingRuntimeReference('condition', condition, location);
    return resolved;
  }

  private resolveErrorHandler(
    handler: string | WorkflowErrorHandlerFn,
    location: string
  ): WorkflowErrorHandlerFn {
    if (typeof handler === 'function') return handler;
    const resolved = this.runtime.errorHandlers?.[handler];
    if (!resolved) throw this.missingRuntimeReference('error handler', handler, location);
    return resolved;
  }

  private missingRuntimeReference(kind: string, reference: string, location: string): WorkflowEngineError {
    return new WorkflowEngineError(
      'WORKFLOW_DEFINITION_INVALID',
      `${location} references unregistered ${kind} ${reference}`,
      { kind, reference, location }
    );
  }

  async getStats(workflowId: string): Promise<WorkflowStats> {
    const executions = await this.workflowStorage.listExecutions(workflowId, 1000);

    const totalExecutions = executions.length;
    const successfulExecutions = executions.filter(
      (execution) => execution.status === WorkflowExecutionStatus.Completed
    ).length;
    const failedExecutions = executions.filter(
      (execution) => execution.status === WorkflowExecutionStatus.Failed
    ).length;

    const successRate = totalExecutions > 0 ? (successfulExecutions / totalExecutions) * 100 : 0;

    const durations = executions
      .filter((execution) => execution.durationMs)
      .map((execution) => execution.durationMs as number);
    const avgDuration = durations.length > 0
      ? durations.reduce((left, right) => left + right, 0) / durations.length
      : 0;

    const lastExecutedAt = executions.length > 0 ? executions[0].startedAt : undefined;

    return {
      totalExecutions,
      successfulExecutions,
      failedExecutions,
      successRate,
      avgDuration,
      lastExecutedAt,
    };
  }

  private registerTrigger(workflow: Workflow): boolean {
    assertUniqueWorkflowStepIds(workflow.definition.steps);
    if (this.triggerBindings.has(workflow.id)) {
      this.unregisterTrigger(workflow);
    }

    const { provider, event } = workflow.definition.trigger;
    const scope = workflowScope(workflow);
    if (!scope) {
      this.skippedUnboundTriggers.add(workflow.id);
      this.logger.warn('Workflow webhook trigger skipped: tenant and connection binding required', {
        workflowId: workflow.id,
      });
      return false;
    }

    const handler: ScopedTriggerHandler = async (delivery, { bindingIsCurrent, revoked }) => {
      try {
        await this.runExecution(workflow.id, delivery, { provider, event, scope, bindingIsCurrent, revoked });
      } catch (error) {
        if (error instanceof WorkflowBindingChanged) {
          return;
        }
        this.logger.error(`Workflow trigger execution failed`, { workflow: workflow.id, errorCode: 'WORKFLOW_TRIGGER_EXECUTION_FAILED' });
        throw error;
      }
    };

    const binding = { provider, event, scope, handler };
    this.webhookHandler.onWorkflow(provider, event, scope, handler);
    this.triggerBindings.set(workflow.id, binding);
    this.skippedUnboundTriggers.delete(workflow.id);

    this.logger.info('Workflow trigger registered', {
      workflowId: workflow.id,
      backend: 'webhook-handler',
      provider: workflow.definition.trigger.provider,
      event: workflow.definition.trigger.event,
    });
    return true;
  }

  private unregisterTrigger(workflow: Workflow): void {
    const binding = this.triggerBindings.get(workflow.id);

    if (!binding) {
      if (this.skippedUnboundTriggers.has(workflow.id) || !workflowScope(workflow)) {
        return;
      }
      throw new WorkflowEngineError(
        'WORKFLOW_TRIGGER_UNREGISTER_FAILED',
        `active trigger binding not found for workflow ${workflow.id}`,
        {
          workflowId: workflow.id,
          provider: workflow.definition.trigger.provider,
          event: workflow.definition.trigger.event,
          backend: 'webhook-handler',
        }
      );
    }

    this.webhookHandler.offWorkflow(binding.provider, binding.event, binding.scope, binding.handler);
    this.triggerBindings.delete(workflow.id);

    this.logger.info('Workflow trigger unregistered', {
      workflowId: workflow.id,
      backend: 'webhook-handler',
      provider: binding.provider,
      event: binding.event,
    });
  }

  private buildExecutionInput(triggerPayload: any, idempotencyKey?: string): any {
    return {
      ...triggerPayload,
      __workflow: {
        idempotencyKey,
      },
    };
  }

  private buildExecutionOutput(data: Record<string, any>, state: PersistedWorkflowState): any {
    return {
      data,
      __workflow: {
        idempotencyKey: state.idempotencyKey,
        completedStepIds: [...state.completedStepIds],
        retriable: state.retriable,
        resumed: state.resumed,
        failedStepId: state.failedStepId,
        errorCode: state.errorCode,
      },
    };
  }

  private readExecutionState(execution: WorkflowExecution | null): {
    data: Record<string, any>;
    completedStepIds: string[];
  } {
    if (!execution || !execution.output || typeof execution.output !== 'object') {
      return {
        data: {},
        completedStepIds: [],
      };
    }

    const output = execution.output as Record<string, any>;
    const workflowState = output.__workflow as Record<string, any> | undefined;
    const completedStepIds = Array.isArray(workflowState?.completedStepIds)
      ? workflowState?.completedStepIds.filter((value: unknown): value is string => {
          return typeof value === 'string' && value.length > 0;
        })
      : [];

    const data = output.data && typeof output.data === 'object'
      ? (output.data as Record<string, any>)
      : {};

    return {
      data,
      completedStepIds,
    };
  }

  private resolveIdempotencyKey(triggerPayload: any): string | undefined {
    if (!triggerPayload || typeof triggerPayload !== 'object') {
      return undefined;
    }

    const explicit = triggerPayload.idempotencyKey;
    if (typeof explicit === 'string' && explicit.length > 0) {
      return explicit;
    }

    if (triggerPayload.webhookDelivery === true) {
      return undefined;
    }

    const payloadId = triggerPayload.id;
    if (typeof payloadId === 'string' && payloadId.length > 0) {
      return payloadId;
    }

    return undefined;
  }

  private async getExecutionById(
    workflowId: string,
    executionId: string
  ): Promise<WorkflowExecution | null> {
    const execution = await this.workflowStorage.getExecution(executionId);
    if (!execution || execution.workflowId !== workflowId) {
      return null;
    }

    return execution;
  }
}

const PARALLEL_ACTION_CHECKPOINT_PREFIX = '__parallel__:';

function workflowScope(workflow: Workflow): WebhookWorkflowBinding | undefined {
  const { tenantId } = workflow;
  const { connectionId } = workflow.definition.trigger;
  return isBindingId(tenantId) && isBindingId(connectionId)
    ? { tenantId, connectionId }
    : undefined;
}

function matchesWorkflowAdmission(
  workflow: Workflow | null,
  admission: WorkflowTriggerScope
): workflow is Workflow {
  return workflow?.status === WorkflowStatus.Enabled &&
    workflow.tenantId === admission.scope.tenantId &&
    workflow.definition.trigger.connectionId === admission.scope.connectionId &&
    workflow.definition.trigger.provider === admission.provider &&
    workflow.definition.trigger.event === admission.event;
}

function assertWorkflowBindingActive(revoked: AbortSignal | undefined): void {
  if (revoked?.aborted) {
    throw webhookBindingRevoked();
  }
}

function parallelActionCheckpointId(stepId: string, actionIndex: number): string {
  return `${PARALLEL_ACTION_CHECKPOINT_PREFIX}${stepId}:${actionIndex}`;
}

function assertUniqueWorkflowStepIds(steps: WorkflowStep[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const reserved = new Set<string>();

  const visit = (step: WorkflowStep): void => {
    if (typeof step.id !== 'string') {
      throw new WorkflowEngineError(
        'WORKFLOW_DEFINITION_INVALID',
        'workflow step IDs must be strings',
        { stepId: step.id }
      );
    }
    if (step.id.startsWith(PARALLEL_ACTION_CHECKPOINT_PREFIX)) {
      reserved.add(step.id);
    }
    if (seen.has(step.id)) {
      duplicates.add(step.id);
    } else {
      seen.add(step.id);
    }

    if (step.type === 'branch') {
      for (const nested of [...step.then, ...(step.else ?? [])]) {
        visit(nested);
      }
    }
  };

  for (const step of steps) {
    visit(step);
  }

  if (reserved.size > 0) {
    const reservedStepIds = [...reserved].sort((left, right) => left.localeCompare(right));
    throw new WorkflowEngineError(
      'WORKFLOW_DEFINITION_INVALID',
      `workflow step IDs cannot use the reserved ${PARALLEL_ACTION_CHECKPOINT_PREFIX} prefix: ${reservedStepIds.join(', ')}`,
      { reservedStepIds }
    );
  }

  if (duplicates.size > 0) {
    const duplicateStepIds = [...duplicates].sort((left, right) => left.localeCompare(right));
    throw new WorkflowEngineError(
      'WORKFLOW_DEFINITION_INVALID',
      `workflow step IDs must be unique: ${duplicateStepIds.join(', ')}`,
      { duplicateStepIds }
    );
  }
}

function normalizeWorkflowExecutionFailure(error: unknown): {
  code: string;
  retriable: boolean;
  error: Error;
} {
  if (error instanceof WebhookHandlerError && error.code === 'WEBHOOK_WORKFLOW_BINDING_REVOKED') {
    return { code: error.code, retriable: true, error };
  }
  if (error instanceof WorkflowEngineError) {
    return {
      code: error.code,
      retriable: false,
      error,
    };
  }

  if (error instanceof Error) {
    return {
      code: 'WORKFLOW_STEP_FAILED',
      retriable: true,
      error,
    };
  }

  return {
    code: 'WORKFLOW_STEP_FAILED',
    retriable: true,
    error: new Error('workflow execution failed'),
  };
}

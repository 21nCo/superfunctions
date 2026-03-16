import type {
  Workflow,
  WorkflowContext,
  WorkflowExecution,
  WorkflowStats,
  ListWorkflowsOptions,
} from '../types/workflow.js';
import { WorkflowStatus, WorkflowExecutionStatus } from '../types/workflow.js';
import type { Logger } from '../types/action.js';
import { WorkflowStorage } from '../storage/workflow-storage.js';
import { WebhookHandler } from '../webhooks/webhook-handler.js';

interface PersistedWorkflowState {
  idempotencyKey?: string;
  completedStepIds: string[];
  retriable: boolean;
  resumed: boolean;
  failedStepId?: string;
  errorCode?: string;
}

export class WorkflowEngine {
  constructor(
    private workflowStorage: WorkflowStorage,
    private webhookHandler: WebhookHandler,
    private logger: Logger
  ) {}

  async create(workflow: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'>): Promise<Workflow> {
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

  async enable(id: string): Promise<void> {
    const workflow = await this.workflowStorage.get(id);
    if (!workflow) {
      throw new Error(`Workflow ${id} not found`);
    }

    await this.workflowStorage.update(id, { status: WorkflowStatus.Enabled });
    this.registerTrigger(workflow);

    this.logger.info(`Workflow enabled: ${workflow.name}`, { workflowId: id });
  }

  async disable(id: string): Promise<void> {
    const workflow = await this.workflowStorage.get(id);
    if (!workflow) {
      throw new Error(`Workflow ${id} not found`);
    }

    await this.workflowStorage.update(id, { status: WorkflowStatus.Disabled });
    this.unregisterTrigger(workflow);

    this.logger.info(`Workflow disabled: ${workflow.name}`, { workflowId: id });
  }

  async delete(id: string): Promise<void> {
    const workflow = await this.workflowStorage.get(id);
    if (workflow) {
      this.unregisterTrigger(workflow);
    }

    await this.workflowStorage.delete(id);
    this.logger.info(`Workflow deleted`, { workflowId: id });
  }

  async execute(workflowId: string, triggerPayload: any): Promise<WorkflowExecution> {
    const workflow = await this.workflowStorage.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    if (workflow.status !== WorkflowStatus.Enabled) {
      throw new Error(`Workflow ${workflowId} is not enabled`);
    }

    const idempotencyKey = this.resolveIdempotencyKey(triggerPayload);
    const existingExecution = idempotencyKey
      ? await this.findExecutionByIdempotencyKey(workflowId, idempotencyKey)
      : null;

    if (existingExecution && existingExecution.status === WorkflowExecutionStatus.Completed) {
      return existingExecution;
    }

    const resumed = Boolean(existingExecution);
    const execution =
      existingExecution ??
      (await this.workflowStorage.createExecution({
        workflowId,
        status: WorkflowExecutionStatus.Running,
        input: this.buildExecutionInput(triggerPayload, idempotencyKey),
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
      trigger: {
        provider: workflow.definition.trigger.provider,
        event: workflow.definition.trigger.event,
        payload: triggerPayload,
      },
      data: contextData,
    };

    const startedAtMs = execution.startedAt ? execution.startedAt.getTime() : Date.now();
    let activeStepId: string | undefined;

    try {
      if (workflow.definition.trigger.filter) {
        const shouldRun = workflow.definition.trigger.filter(context);
        if (!shouldRun) {
          await this.workflowStorage.updateExecution(execution.id, {
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

        await this.executeStep(step, context);
        completedStepIds.push(step.id);

        await this.workflowStorage.updateExecution(execution.id, {
          status: WorkflowExecutionStatus.Running,
          output: this.buildExecutionOutput(context.data, {
            idempotencyKey,
            completedStepIds,
            retriable: false,
            resumed,
          }),
        });
      }

      await this.workflowStorage.updateExecution(execution.id, {
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
      this.logger.error(`Workflow execution failed: ${workflow.name}`, {
        workflowId,
        executionId: execution.id,
        error,
      });

      if (workflow.definition.errorHandlers) {
        for (const errorHandler of workflow.definition.errorHandlers) {
          try {
            await errorHandler.handler(error as Error, context);
          } catch (handlerError) {
            this.logger.error('Error handler failed', { handlerError });
          }
        }
      }

      await this.workflowStorage.updateExecution(execution.id, {
        status: WorkflowExecutionStatus.Failed,
        error: `WORKFLOW_STEP_FAILED:${(error as Error).message}`,
        output: this.buildExecutionOutput(context.data, {
          idempotencyKey,
          completedStepIds,
          retriable: true,
          resumed,
          failedStepId: activeStepId,
          errorCode: 'WORKFLOW_STEP_FAILED',
        }),
        completedAt: new Date(),
        durationMs: Date.now() - startedAtMs,
      });

      throw error;
    }
  }

  private async executeStep(step: any, context: WorkflowContext): Promise<void> {
    switch (step.type) {
      case 'action': {
        const result = await step.action(context);
        Object.assign(context.data, result);
        break;
      }

      case 'filter': {
        const shouldContinue = step.condition(context);
        if (!shouldContinue) {
          throw new Error('Filter condition not met');
        }
        break;
      }

      case 'branch': {
        const condition = step.condition(context);
        const branch = condition ? step.then : step.else;
        if (branch) {
          for (const branchStep of branch) {
            await this.executeStep(branchStep, context);
          }
        }
        break;
      }

      case 'parallel': {
        await Promise.all(step.actions.map((action: any) => action(context)));
        break;
      }

      case 'delay': {
        const ms = this.convertDelayToMs(step);
        await new Promise((resolve) => setTimeout(resolve, ms));
        break;
      }

      default:
        throw new Error(`Unknown workflow step type: ${step.type}`);
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

  private registerTrigger(workflow: Workflow): void {
    const handler = async (event: any) => {
      try {
        await this.execute(workflow.id, event);
      } catch (error) {
        this.logger.error(`Workflow trigger execution failed`, { workflow: workflow.id, error });
      }
    };

    this.webhookHandler.on(
      workflow.definition.trigger.provider,
      workflow.definition.trigger.event,
      handler
    );
  }

  private unregisterTrigger(workflow: Workflow): void {
    this.logger.debug(`Unregistering trigger for workflow ${workflow.id}`);
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

    const payloadId = triggerPayload.id;
    if (typeof payloadId === 'string' && payloadId.length > 0) {
      return payloadId;
    }

    return undefined;
  }

  private async findExecutionByIdempotencyKey(
    workflowId: string,
    idempotencyKey: string
  ): Promise<WorkflowExecution | null> {
    const executions = await this.workflowStorage.listExecutions(workflowId, 1000);

    for (const execution of executions) {
      const executionKey = this.extractExecutionIdempotencyKey(execution);
      if (executionKey === idempotencyKey) {
        return execution;
      }
    }

    return null;
  }

  private extractExecutionIdempotencyKey(execution: WorkflowExecution): string | undefined {
    const input = execution.input as Record<string, any> | undefined;
    if (input && typeof input === 'object') {
      const workflowInput = input.__workflow as Record<string, any> | undefined;
      if (typeof workflowInput?.idempotencyKey === 'string' && workflowInput.idempotencyKey.length > 0) {
        return workflowInput.idempotencyKey;
      }
      if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
        return input.idempotencyKey;
      }
    }

    const output = execution.output as Record<string, any> | undefined;
    if (output && typeof output === 'object') {
      const workflowOutput = output.__workflow as Record<string, any> | undefined;
      if (typeof workflowOutput?.idempotencyKey === 'string' && workflowOutput.idempotencyKey.length > 0) {
        return workflowOutput.idempotencyKey;
      }
    }

    return undefined;
  }

  private async getExecutionById(
    workflowId: string,
    executionId: string
  ): Promise<WorkflowExecution | null> {
    const executions = await this.workflowStorage.listExecutions(workflowId, 1000);
    return executions.find((execution) => execution.id === executionId) ?? null;
  }
}

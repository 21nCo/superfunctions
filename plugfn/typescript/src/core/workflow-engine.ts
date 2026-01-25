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

/**
 * Workflow engine manages and executes workflows
 */
export class WorkflowEngine {
  constructor(
    private workflowStorage: WorkflowStorage,
    private webhookHandler: WebhookHandler,
    private logger: Logger
  ) {}

  /**
   * Create a new workflow
   */
  async create(workflow: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'>): Promise<Workflow> {
    const created = await this.workflowStorage.create(workflow);
    
    // Register trigger if workflow is enabled
    if (workflow.status === WorkflowStatus.Enabled) {
      this.registerTrigger(created);
    }
    
    this.logger.info(`Workflow created: ${created.name}`, { workflowId: created.id });
    return created;
  }

  /**
   * Get a workflow
   */
  async get(id: string): Promise<Workflow | null> {
    return this.workflowStorage.get(id);
  }

  /**
   * List workflows
   */
  async list(options?: ListWorkflowsOptions): Promise<Workflow[]> {
    return this.workflowStorage.list(options?.userId, options?.status);
  }

  /**
   * Enable a workflow
   */
  async enable(id: string): Promise<void> {
    const workflow = await this.workflowStorage.get(id);
    if (!workflow) {
      throw new Error(`Workflow ${id} not found`);
    }

    await this.workflowStorage.update(id, { status: WorkflowStatus.Enabled });
    this.registerTrigger(workflow);
    
    this.logger.info(`Workflow enabled: ${workflow.name}`, { workflowId: id });
  }

  /**
   * Disable a workflow
   */
  async disable(id: string): Promise<void> {
    const workflow = await this.workflowStorage.get(id);
    if (!workflow) {
      throw new Error(`Workflow ${id} not found`);
    }

    await this.workflowStorage.update(id, { status: WorkflowStatus.Disabled });
    this.unregisterTrigger(workflow);
    
    this.logger.info(`Workflow disabled: ${workflow.name}`, { workflowId: id });
  }

  /**
   * Delete a workflow
   */
  async delete(id: string): Promise<void> {
    const workflow = await this.workflowStorage.get(id);
    if (workflow) {
      this.unregisterTrigger(workflow);
    }
    
    await this.workflowStorage.delete(id);
    this.logger.info(`Workflow deleted`, { workflowId: id });
  }

  /**
   * Execute a workflow
   */
  async execute(workflowId: string, triggerPayload: any): Promise<WorkflowExecution> {
    const workflow = await this.workflowStorage.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    if (workflow.status !== WorkflowStatus.Enabled) {
      throw new Error(`Workflow ${workflowId} is not enabled`);
    }

    // Create execution record
    const execution = await this.workflowStorage.createExecution({
      workflowId,
      status: WorkflowExecutionStatus.Running,
      input: triggerPayload,
    });

    const startTime = Date.now();
    
    try {
      // Build context
      const context: WorkflowContext = {
        workflowId,
        executionId: execution.id,
        userId: workflow.userId,
        trigger: {
          provider: workflow.definition.trigger.provider,
          event: workflow.definition.trigger.event,
          payload: triggerPayload,
        },
        data: {},
      };

      // Check filter if defined
      if (workflow.definition.trigger.filter) {
        const shouldRun = workflow.definition.trigger.filter(context);
        if (!shouldRun) {
          this.logger.debug(`Workflow skipped by filter: ${workflow.name}`);
          
          await this.workflowStorage.updateExecution(execution.id, {
            status: WorkflowExecutionStatus.Completed,
            output: { skipped: true },
            completedAt: new Date(),
            durationMs: Date.now() - startTime,
          });
          
          return execution;
        }
      }

      // Execute steps
      for (const step of workflow.definition.steps) {
        await this.executeStep(step, context);
      }

      // Update execution as successful
      await this.workflowStorage.updateExecution(execution.id, {
        status: WorkflowExecutionStatus.Completed,
        output: context.data,
        completedAt: new Date(),
        durationMs: Date.now() - startTime,
      });

      this.logger.info(`Workflow executed successfully: ${workflow.name}`, {
        workflowId,
        executionId: execution.id,
        duration: Date.now() - startTime,
      });

      return execution;
    } catch (error) {
      this.logger.error(`Workflow execution failed: ${workflow.name}`, {
        workflowId,
        executionId: execution.id,
        error,
      });

      // Handle error
      if (workflow.definition.errorHandlers) {
        for (const errorHandler of workflow.definition.errorHandlers) {
          try {
            await errorHandler.handler(error as Error, {
              workflowId,
              executionId: execution.id,
              userId: workflow.userId,
              trigger: {
                provider: workflow.definition.trigger.provider,
                event: workflow.definition.trigger.event,
                payload: triggerPayload,
              },
              data: {},
            });
          } catch (handlerError) {
            this.logger.error('Error handler failed', { handlerError });
          }
        }
      }

      // Update execution as failed
      await this.workflowStorage.updateExecution(execution.id, {
        status: WorkflowExecutionStatus.Failed,
        error: (error as Error).message,
        completedAt: new Date(),
        durationMs: Date.now() - startTime,
      });

      throw error;
    }
  }

  /**
   * Execute a workflow step
   */
  private async executeStep(step: any, context: WorkflowContext): Promise<void> {
    switch (step.type) {
      case 'action':
        const result = await step.action(context);
        Object.assign(context.data, result);
        break;

      case 'filter':
        const shouldContinue = step.condition(context);
        if (!shouldContinue) {
          throw new Error('Filter condition not met');
        }
        break;

      case 'branch':
        const condition = step.condition(context);
        const branch = condition ? step.then : step.else;
        if (branch) {
          for (const branchStep of branch) {
            await this.executeStep(branchStep, context);
          }
        }
        break;

      case 'parallel':
        await Promise.all(step.actions.map((action: any) => action(context)));
        break;

      case 'delay':
        const ms = this.convertDelayToMs(step);
        await new Promise((resolve) => setTimeout(resolve, ms));
        break;
    }
  }

  /**
   * Convert delay to milliseconds
   */
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

  /**
   * Get workflow statistics
   */
  async getStats(workflowId: string): Promise<WorkflowStats> {
    const executions = await this.workflowStorage.listExecutions(workflowId, 1000);
    
    const totalExecutions = executions.length;
    const successfulExecutions = executions.filter(
      (e) => e.status === WorkflowExecutionStatus.Completed
    ).length;
    const failedExecutions = executions.filter(
      (e) => e.status === WorkflowExecutionStatus.Failed
    ).length;
    
    const successRate = totalExecutions > 0 ? (successfulExecutions / totalExecutions) * 100 : 0;
    
    const durations = executions
      .filter((e) => e.durationMs)
      .map((e) => e.durationMs!);
    const avgDuration = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
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

  /**
   * Register workflow trigger
   */
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

  /**
   * Unregister workflow trigger
   */
  private unregisterTrigger(workflow: Workflow): void {
    // Note: We can't easily unregister a specific handler without keeping a reference
    // This is a limitation - in production, we'd want to track handler references
    this.logger.debug(`Unregistering trigger for workflow ${workflow.id}`);
  }
}


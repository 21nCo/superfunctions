import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../src/core/workflow-engine.js';
import { ProviderRegistry } from '../src/core/provider-registry.js';
import { WebhookHandler } from '../src/webhooks/webhook-handler.js';
import { AdapterWorkflowStorage } from '../src/storage/workflow-storage.js';
import { MemoryAdapter } from '../src/storage/adapters/memory.js';
import { NoopLogger } from '../src/utils/logger.js';
import { WorkflowStatus, WorkflowExecutionStatus } from '../src/types/workflow.js';

describe('workflow idempotency and crash recovery', () => {
  it('resumes failed execution by idempotency key without duplicating completed side effects', async () => {
    const adapter = new MemoryAdapter();
    const storage = new AdapterWorkflowStorage(adapter);
    const logger = new NoopLogger();
    const providerRegistry = new ProviderRegistry(logger);
    const webhookHandler = new WebhookHandler(providerRegistry, logger);
    const engine = new WorkflowEngine(storage, webhookHandler, logger);

    const sideEffects: string[] = [];
    let failStepTwoOnce = true;
    const workflow = await engine.create({
      userId: 'user-1',
      name: 'workflow-idempotency',
      status: WorkflowStatus.Enabled,
      definition: {
        trigger: {
          provider: 'test',
          event: 'incoming.event',
        },
        steps: [
          {
            id: 'step-1',
            type: 'action',
            action: async () => {
              sideEffects.push('step-1');
              return {
                first: true,
              };
            },
          },
          {
            id: 'step-2',
            type: 'action',
            action: async () => {
              if (failStepTwoOnce) {
                failStepTwoOnce = false;
                throw new Error('step two failed');
              }
              sideEffects.push('step-2');
              return {
                second: true,
              };
            },
          },
        ],
      },
    });

    await expect(
      engine.execute(workflow.id, {
        idempotencyKey: 'ik-1',
      })
    ).rejects.toThrow('step two failed');

    const failedExecution = (await storage.listExecutions(workflow.id, 10))[0];
    expect(failedExecution.status).toBe(WorkflowExecutionStatus.Failed);
    expect(failedExecution.error).toBe('WORKFLOW_STEP_FAILED:step two failed');
    expect(failedExecution.output.__workflow).toMatchObject({
      idempotencyKey: 'ik-1',
      completedStepIds: ['step-1'],
      retriable: true,
      resumed: false,
      failedStepId: 'step-2',
      errorCode: 'WORKFLOW_STEP_FAILED',
    });
    expect(sideEffects).toEqual(['step-1']);

    const resumedEngine = new WorkflowEngine(
      storage,
      new WebhookHandler(new ProviderRegistry(logger), logger),
      logger
    );
    const resumedExecution = await resumedEngine.execute(workflow.id, {
      idempotencyKey: 'ik-1',
    });

    expect(resumedExecution.status).toBe(WorkflowExecutionStatus.Completed);
    expect(resumedExecution.output.__workflow).toMatchObject({
      idempotencyKey: 'ik-1',
      completedStepIds: ['step-1', 'step-2'],
      retriable: false,
      resumed: true,
    });
    expect(sideEffects).toEqual(['step-1', 'step-2']);
  });

  it('returns prior completed execution for duplicate idempotency key', async () => {
    const adapter = new MemoryAdapter();
    const storage = new AdapterWorkflowStorage(adapter);
    const logger = new NoopLogger();
    const providerRegistry = new ProviderRegistry(logger);
    const webhookHandler = new WebhookHandler(providerRegistry, logger);
    const engine = new WorkflowEngine(storage, webhookHandler, logger);

    let sideEffectCount = 0;
    const workflow = await engine.create({
      userId: 'user-1',
      name: 'workflow-idempotency-completed',
      status: WorkflowStatus.Enabled,
      definition: {
        trigger: {
          provider: 'test',
          event: 'incoming.event',
        },
        steps: [
          {
            id: 'step-1',
            type: 'action',
            action: async () => {
              sideEffectCount += 1;
              return {
                count: sideEffectCount,
              };
            },
          },
        ],
      },
    });

    const first = await engine.execute(workflow.id, {
      idempotencyKey: 'ik-2',
    });
    const second = await engine.execute(workflow.id, {
      idempotencyKey: 'ik-2',
    });

    expect(first.id).toBe(second.id);
    expect(first.status).toBe(WorkflowExecutionStatus.Completed);
    expect(second.status).toBe(WorkflowExecutionStatus.Completed);
    expect(sideEffectCount).toBe(1);
  });
});

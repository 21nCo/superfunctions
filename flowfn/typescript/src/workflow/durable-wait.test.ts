import { it, expect } from 'vitest';
import { MemoryAdapter } from '../adapters/memory.js';
import { WorkflowBuilderImpl } from './workflow.js';

it('waits for durable completion when execution still belongs to another runtime', async () => {
  const adapter = new MemoryAdapter();
  const owner = new WorkflowBuilderImpl('remote-wait', adapter).waitForEvent('go').build();
  const reader = new WorkflowBuilderImpl('remote-wait', adapter).waitForEvent('go').build();
  try {
    const execution = await owner.execute({});
    let settled = false;
    const waiting = reader.waitForCompletion(execution.id).then(result => { settled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    await reader.signalEvent(execution.id, 'go', 7);
    expect((await waiting).status).toBe('completed');
  } finally { await owner.close(); await reader.close(); }
});

it('retries recovery after its initial resumed checkpoint loses ownership', async () => {
  const adapter = new MemoryAdapter();
  const owner = new WorkflowBuilderImpl('resume-checkpoint', adapter).ownership({ leaseDuration: 100 }).waitForEvent('go').build();
  const reader = new WorkflowBuilderImpl('resume-checkpoint', adapter).ownership({ leaseDuration: 100 }).waitForEvent('go').build();
  const mutate = adapter.mutateWorkflowState.bind(adapter);
  try {
    const execution = await owner.execute({});
    await new Promise(resolve => setTimeout(resolve, 20));
    const stored = (await adapter.loadWorkflowState(execution.id))!;
    await mutate(execution.id, { expectedRevision: stored.revision!, token: stored.lease!.token, release: true });
    await owner.close().catch(() => undefined);
    let fail = true;
    adapter.mutateWorkflowState = async (id, mutation) => {
      if (fail && mutation.state && mutation.token && !mutation.acquire) { fail = false; return null; }
      return mutate(id, mutation);
    };
    await expect(reader.resumeExecution(execution.id)).rejects.toThrow('lease lost');
    await new Promise(resolve => setTimeout(resolve, 130));
    await reader.resumeExecution(execution.id);
    await reader.signalEvent(execution.id, 'go', 9);
    expect((await reader.waitForCompletion(execution.id)).status).toBe('completed');
  } finally { adapter.mutateWorkflowState = mutate; await owner.close().catch(() => undefined); await reader.close(); }
});

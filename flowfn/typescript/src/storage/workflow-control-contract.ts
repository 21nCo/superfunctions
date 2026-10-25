import { expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FlowAdapter } from '../adapters/base.js';
import { WorkflowBuilderImpl } from '../workflow/workflow.js';

export async function workflowControlContract(adapter: FlowAdapter, leaseDuration = 90) {
  const id = randomUUID();
  const state = { id, workflowId: 'ownership', status: 'running' as const, input: {}, startedAt: Date.now() };
  const mutate = adapter.mutateWorkflowState!.bind(adapter);
  const created = await Promise.all(Array.from({length: 12}, () => mutate(id, { expectedRevision: null, state })));
  expect(created.filter(Boolean)).toHaveLength(1);
  const claims = await Promise.all(Array.from({length: 12}, (_, i) => mutate(id, { expectedRevision: 1, token: `owner-${i}`, acquire: 30 })));
  const owned = claims.find(Boolean)!;
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(await mutate(id, { expectedRevision: owned.revision!, state, token: 'stale' })).toBeNull();
  await expect(adapter.saveWorkflowState(id, state)).rejects.toThrow('revision-checked');
  await new Promise(resolve => setTimeout(resolve, 45));
  expect(await mutate(id, { expectedRevision: owned.revision!, token: owned.lease!.token, renew: 30 })).toBeNull();
  const takeover = await mutate(id, { expectedRevision: owned.revision!, token: 'replacement', acquire: 1000 });
  expect(takeover?.lease?.token).toBe('replacement');
  expect(await mutate(id, { expectedRevision: takeover!.revision!, token: owned.lease!.token, state })).toBeNull();
  const released = await mutate(id, { expectedRevision: takeover!.revision!, token: 'replacement', release: true });
  expect(released?.lease).toBeUndefined();

  const name = randomUUID();
  const workflows = Array.from({length: 12}, () => new WorkflowBuilderImpl(name, adapter).waitForEvent('finish').build());
  const executions = await Promise.all(workflows.map(workflow => workflow.execute({})));
  const reader = new WorkflowBuilderImpl(name, adapter).waitForEvent('finish').build();
  try {
    expect((await reader.listExecutions()).map(value => value.id).sort()).toEqual(executions.map(value => value.id).sort());
    await expect(reader.resumeExecution(executions[0].id)).rejects.toThrow('owned or changed');
  } finally {
    await Promise.all(workflows.map(workflow => workflow.close()));
    await reader.close();
  }

  let compensated = false, aborted = false;
  const hanging = new WorkflowBuilderImpl(randomUUID(), adapter).ownership({ leaseDuration })
    .saga('external', {
      execute: async ctx => { await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true })); },
      compensate: async () => { compensated = true; },
    }).build();
  const originalMutation = adapter.mutateWorkflowState!;
  adapter.mutateWorkflowState = (key, change) => change.renew !== undefined ? new Promise(() => undefined) : originalMutation.call(adapter, key, change);
  try {
    const execution = await hanging.execute({});
    await expect(hanging.waitForCompletion(execution.id)).rejects.toThrow('lease lost');
    expect(aborted).toBe(true);
    expect(compensated).toBe(false);
    expect((await adapter.loadWorkflowState(execution.id))?.completedAt).toBeUndefined();
  } finally { adapter.mutateWorkflowState = originalMutation; await hanging.close(); }
}

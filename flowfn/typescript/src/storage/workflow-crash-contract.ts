import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import { WorkflowBuilderImpl } from '../workflow/workflow.js';
import type { FlowAdapter } from '../adapters/base.js';

export async function workflowCrashContract(adapter: FlowAdapter, kind: string, scope: string, scheduler = false) {
  const name = `restart-${randomUUID()}`;
  const children: ReturnType<typeof fork>[] = [];
  const start = (executionId?: string) => {
    const child = fork(resolve(`scripts/${scheduler ? 'scheduler' : 'workflow'}-crash-worker.mjs`), [], {
      env: { ...process.env, FLOWFN_CRASH_CONFIG: JSON.stringify({ kind, scope, name, executionId, resume: Boolean(executionId) }) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.push(child);
    return child;
  };
  const message = (child: ReturnType<typeof fork>): Promise<any> => new Promise((resolve, reject) => {
    let errors = '';
    child.stderr?.on('data', data => { errors += data; });
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Worker exited ${code}: ${errors}`)));
  });
  try {
    const original = start();
    const initial = await message(original);
    const executionId = scheduler ? 'resume' : initial.executionId;
    const exited = once(original, 'exit');
    original.kill('SIGKILL');
    await exited;
    const sender = new WorkflowBuilderImpl(name, adapter).build();
    if (!scheduler) await sender.signalEvent(executionId, 'go', 7);
    await new Promise(resolve => setTimeout(resolve, 220));
    const restored = start(executionId);
    const finished = once(restored, 'exit');
    const completion = message(restored);
    void completion.catch(() => undefined);
    if (!scheduler) {
      await vi.waitFor(async () => expect((await adapter.loadWorkflowState(executionId))?.waiting?.kind).toBe('approval'), { timeout: 5000 });
      await sender.approveExecution(executionId, { approver: 'ops', reviewedBy: 'remote-operator', approved: true });
    }
    await sender.close();
    const result = await completion;
    if (scheduler) expect(result.completed).toBe(true);
    else {
      expect(result.result.output).toBe(12);
      expect(result.result.state.approved).toBe(true);
      expect(result.result.input).toEqual({ values: [], nested: { empty: [] } });
    }
    await finished;
    expect((await adapter.getStreamInfo(name)).length).toBe(scheduler ? 2 : 1);
    if (scheduler) {
      const messages = await adapter.getMessages!(name, '-', '+');
      expect(messages[0].data.occurrence).toBe(messages[1].data.occurrence);
    }
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
  }
}

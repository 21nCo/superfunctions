import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { FlowAdapter } from '../adapters/base.js';
import { WorkflowBuilderImpl } from '../workflow/workflow.js';

export async function workflowCancelContract(adapter: FlowAdapter, kind: string, scope: string, restart: boolean) {
  const name = `cancel-${randomUUID()}`;
  const children: ReturnType<typeof fork>[] = [];
  const start = (executionId?: string) => {
    const child = fork(resolve('scripts/workflow-cancel-worker.mjs'), [], {
      env: { ...process.env, FLOWFN_CANCEL_CONFIG: JSON.stringify({ kind, scope, name, executionId }) },
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
    child.once('exit', code => reject(new Error(`Cancellation worker exited ${code}: ${errors}`)));
  });
  const sender = new WorkflowBuilderImpl(name, adapter).build();
  try {
    let owner = start();
    const { executionId } = await message(owner);
    if (restart) {
      const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited;
      await sender.cancelExecution(executionId);
      owner = start(executionId);
    }
    const finished = once(owner, 'exit');
    const completion = message(owner);
    void completion.catch(() => undefined);
    if (!restart) await sender.cancelExecution(executionId);
    const { result } = await completion;
    expect(result.status).toBe('cancelled');
    expect(result.completedAt).toBeTypeOf('number');
    await finished;
    expect((await adapter.getMessages!(name, '-', '+')).map(message => message.data.phase)).toEqual(['effect', 'compensated']);
  } finally {
    await sender.close();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
  }
}

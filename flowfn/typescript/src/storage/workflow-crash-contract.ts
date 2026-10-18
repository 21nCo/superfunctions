import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { FlowAdapter } from '../adapters/base.js';

export async function workflowCrashContract(adapter: FlowAdapter, kind: string, scope: string) {
  const name = `restart-${randomUUID()}`;
  const children: ReturnType<typeof fork>[] = [];
  const start = (executionId?: string) => {
    const child = fork(resolve('scripts/workflow-crash-worker.mjs'), [], {
      env: { ...process.env, FLOWFN_CRASH_CONFIG: JSON.stringify({ kind, scope, name, executionId }) },
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
    const { executionId } = await message(original);
    const exited = once(original, 'exit');
    original.kill('SIGKILL');
    await exited;
    await new Promise(resolve => setTimeout(resolve, 220));
    const restored = start(executionId);
    const finished = once(restored, 'exit');
    const { result } = await message(restored);
    expect(result.output).toBe(12);
    expect(result.input).toEqual({ values: [], nested: { empty: [] } });
    await finished;
    expect((await adapter.getStreamInfo(name)).length).toBe(1);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
  }
}

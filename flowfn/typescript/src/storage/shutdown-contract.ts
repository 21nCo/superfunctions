import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import type { FlowAdapter } from '../adapters/base.js';
import { createFlow } from '../core/flow-fn.js';

export async function shutdownContract(adapter: FlowAdapter) {
  let cleanup = 0, release!: () => void;
  const binding = new Proxy(adapter, { get(target, key) { const value = Reflect.get(target, key); return key === 'cleanup' ? async () => { cleanup++; } : typeof value === 'function' ? value.bind(target) : value; } });
  const flow = createFlow({ adapter: binding, namespace: randomUUID() });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Set<string>(), aborted = new Set<string>();
  const queue = flow.queue('hung');
  queue.process(async job => { started.add('queue'); job.signal?.addEventListener('abort', () => aborted.add('queue'), { once: true }); await gate; return 'late'; });
  const workflow = flow.workflow('hung').step('hung', async ctx => { started.add('workflow'); ctx.signal.addEventListener('abort', () => aborted.add('workflow'), { once: true }); await gate; ctx.set('late', true); return 'late'; }).build();
  try {
    const job = await queue.add('work', {});
    const execution = await workflow.execute({});
    await flow.scheduler().schedule('hung', { every: 1, limit: 1 }, async (_data, ctx) => { started.add('scheduler'); ctx.signal.addEventListener('abort', () => aborted.add('scheduler'), { once: true }); await gate; });
    await vi.waitFor(() => expect(started.size).toBe(3), { timeout: 5000 });
    await expect(flow.close({ timeout: 20 })).rejects.toThrow('shutdown timed out');
    expect(aborted.size).toBe(3);
    expect(cleanup).toBe(1);
    release();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect((await queue.getJob(job.id))?.returnvalue).toBeUndefined();
    expect((await workflow.getExecution(execution.id)).completedAt).toBeUndefined();
    expect((await workflow.getExecution(execution.id)).state?.late).toBeUndefined();
    expect((await flow.scheduler().list())[0].count).toBe(0);
  } finally { release(); await flow.close().catch(() => undefined); }
}

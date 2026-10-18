import { expect, it, vi } from 'vitest';
import { createFlow } from './flow-fn.js';
import { MemoryAdapter } from '../adapters/memory.js';
import { shutdownContract } from '../storage/shutdown-contract.js';
import { createWorker } from '../queue/worker.js';
import { createWorkerPool } from '../queue/worker-pool.js';
import { ShutdownTimeoutError } from './shutdown.js';

it('bounds shutdown and fences non-cooperative queue, workflow and scheduler callbacks', async () => { await shutdownContract(new MemoryAdapter()); });
it('bounds hung adapter cleanup without allowing new work', async () => {
  const adapter = new MemoryAdapter();
  adapter.cleanup = () => new Promise(() => {});
  const flow = createFlow({ adapter });
  await expect(flow.close({ timeout: 20 })).rejects.toBeInstanceOf(ShutdownTimeoutError);
  expect(() => flow.queue('new')).toThrow('closed');
});
it('still cleans the adapter when a shutdown hook never returns', async () => {
  const adapter = new MemoryAdapter();
  const cleanup = vi.spyOn(adapter, 'cleanup');
  const flow = createFlow({ adapter });
  flow.on('closing', () => new Promise(() => {}));
  await expect(flow.close({ timeout: 20 })).rejects.toThrow('Shutdown hook');
  expect(cleanup).toHaveBeenCalledTimes(1);
});
it('closes workers and pool scaling when their flow closes and removes signals', async () => {
  const flow = createFlow({ adapter: 'memory' });
  const first = process.listenerCount('SIGUSR1'), second = process.listenerCount('SIGUSR2');
  const worker = createWorker({ flow, queues: ['work'], signals: ['SIGUSR1'] });
  worker.register('work', async () => undefined);
  const pool = createWorkerPool({ flow, queues: ['pool'], minWorkers: 1, maxWorkers: 2, scaleUpThreshold: 1, scaleDownDelay: 1, signals: ['SIGUSR2'] });
  pool.register('pool', async () => undefined);
  await worker.run(); await pool.start();
  await flow.close({ timeout: 100 });
  expect(worker.getStats().running).toBe(false);
  expect((await pool.getStats()).activeWorkers).toBe(0);
  expect(process.listenerCount('SIGUSR1')).toBe(first);
  expect(process.listenerCount('SIGUSR2')).toBe(second);
});

it('does not miss workflow cancellation while an inbox read is pending', async () => {
  const adapter = new MemoryAdapter();
  const read = adapter.loadWorkflowState.bind(adapter);
  let entered!: () => void, release!: () => void;
  const inboxRead = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  adapter.loadWorkflowState = async id => { if (id.endsWith(':inbox')) { entered(); await gate; } return read(id); };
  adapter.cleanup = async () => {};
  const flow = createFlow({ adapter });
  const workflow = flow.workflow('cancel-inbox').waitForEvent('never').build();
  const execution = await workflow.execute({});
  await inboxRead;
  const closing = flow.close({ timeout: 200 });
  release();
  await closing;
  expect((await workflow.getExecution(execution.id)).status).toBe('cancelled');
});
it('unsubscribes acquisitions that finish after stream shutdown', async () => {
  const adapter = new MemoryAdapter();
  let release!: (value: { unsubscribe: () => Promise<void> }) => void;
  let entered!: () => void;
  const acquiring = new Promise<void>(resolve => { entered = resolve; });
  adapter.subscribe = () => new Promise(resolve => { release = resolve; entered(); });
  const flow = createFlow({ adapter });
  const stream = flow.stream('late');
  const pending = stream.subscribe(async () => {});
  await acquiring;
  await stream.close({ timeout: 20 });
  const unsubscribe = vi.fn(async () => {});
  release({ unsubscribe });
  await expect(pending).rejects.toThrow('closed');
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  await flow.close();
});

it('does not let worker lifecycle observers prevent cleanup', async () => {
  const flow = createFlow({ adapter: 'memory' });
  const worker = createWorker({ flow, queues: ['observed'] });
  worker.register('observed', async () => undefined);
  await worker.run();
  worker.on('closing', () => { throw new Error('closing observer'); });
  worker.on('closed', () => { throw new Error('closed observer'); });
  await worker.close({ timeout: 100 });
  expect(worker.getStats().running).toBe(false);
  await flow.close();
});

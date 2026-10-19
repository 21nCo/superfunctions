import { it, expect, vi } from 'vitest';
import { createFlow } from '../core/flow-fn.js';
import { Worker } from './worker.js';
import { createWorkerPool } from './worker-pool.js';
import { MemoryAdapter } from '../adapters/memory.js';
import { workerOwnershipContract, workerPoolContract } from '../storage/worker-contract.js';
it('bounds shutdown and fences abandoned handlers without closing shared queues', async () => { await workerOwnershipContract(new MemoryAdapter()); });
it('scales independent workers up and down within pool bounds', async () => { await workerPoolContract(new MemoryAdapter()); });

it('closes already-started workers when a later pool worker fails startup', async () => {
  const flow = createFlow({ adapter: 'memory' });
  const pool = createWorkerPool({ flow, queues: ['tasks'], minWorkers: 2, maxWorkers: 2, scaleUpThreshold: 1, scaleDownDelay: 10 });
  const run = Worker.prototype.run;
  let calls = 0;
  const stub = vi.spyOn(Worker.prototype, 'run').mockImplementation(async function (this: Worker) {
    if (++calls === 2) throw new Error('startup unavailable');
    await run.call(this);
  });
  try {
    await expect(pool.start()).rejects.toThrow('startup unavailable');
    await pool.close();
    expect((await pool.getStats()).activeWorkers).toBe(0);
  } finally { stub.mockRestore(); await pool.close(); await flow.close(); }
});

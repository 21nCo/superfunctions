import { expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FlowAdapter } from '../adapters/base.js';
import { JobImpl } from '../queue/job.js';

export async function queueClockContract(adapter: FlowAdapter & Required<Pick<FlowAdapter, 'createJob'>>, skew: number, deduplication: boolean) {
  const queue = `clock-${randomUUID()}`;
  const realNow = Date.now.bind(Date);
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
  try {
    const proposed = new JobImpl('work', {}, { delay: 200 });
    if (deduplication) proposed.deduplicationId = 'unique';
    const start = realNow();
    const created = await adapter.createJob(queue, proposed);
    expect(created.timestamp).toBeGreaterThanOrEqual(start - 100);
    expect(created.timestamp).toBeLessThanOrEqual(realNow() + 100);
    clock.mockImplementation(() => realNow() + 3_600_000);
    expect(await adapter.dequeue(queue)).toBeNull();
    await sleep(260);
    clock.mockImplementation(() => realNow() - 3_600_000);
    const claimed = await adapter.dequeue(queue, undefined, 10_000);
    expect(claimed?.id).toBe(created.id);
    expect(claimed!.processedOn).toBeGreaterThanOrEqual(start);
    expect(claimed!.processedOn).toBeLessThanOrEqual(realNow() + 100);
    // Retry the leased job using the opposite producer clock skew.
    clock.mockImplementation(() => realNow() - skew);
    claimed!.opts.delay = 200;
    const retryStart = realNow();
    await adapter.enqueue(queue, claimed!);
    const retried = await adapter.getJob(queue, claimed!.id);
    expect(retried!.timestamp).toBeGreaterThanOrEqual(retryStart - 100);
    expect(retried!.timestamp).toBeLessThanOrEqual(realNow() + 100);
    clock.mockImplementation(() => realNow() + 3_600_000);
    expect(await adapter.dequeue(queue)).toBeNull();
    await sleep(260);
    clock.mockImplementation(() => realNow() - 3_600_000);
    expect((await adapter.dequeue(queue))?.id).toBe(created.id);
  } finally { clock.mockRestore(); }
}

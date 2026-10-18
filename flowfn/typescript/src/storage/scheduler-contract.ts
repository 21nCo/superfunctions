import { expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DurableScheduler } from '../core/durable-scheduler.js';
import type { FlowAdapter } from '../adapters/base.js';

export async function schedulerContract(adapter: FlowAdapter, leaseDuration = 120) {
  const namespace = randomUUID();
  const first = new DurableScheduler(adapter, namespace, leaseDuration);
  const second = new DurableScheduler(adapter, namespace, leaseDuration);
  let calls = 0, active = 0, maximum = 0;
  const handler = async (data: { value: number }) => {
    expect(data.value).toBe(1);
    data.value = 99;
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, leaseDuration * 1.5));
    active--;
  };
  try {
    const options = { every: 20, limit: 3, data: { value: 1 } };
    await Promise.all([first.schedule('work', options, handler), second.schedule('work', options, handler)]);
    await vi.waitFor(async () => expect(await first.list()).toEqual([]), { timeout: Math.max(4000, leaseDuration * 15) });
    expect(calls).toBe(3);
    expect(maximum).toBe(1);
    await first.close(); await second.close();
    const reopened = new DurableScheduler(adapter, namespace, leaseDuration);
    try {
      await reopened.schedule('work', options, handler);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await reopened.list()).toEqual([]);
      expect(calls).toBe(3);
      await reopened.schedule('paused', { every: 1000 }, handler);
      await second.pause('paused');
      expect((await reopened.list())[0].paused).toBe(true);
      await second.cancel('paused');
      expect(await reopened.list()).toEqual([]);
    } finally { await reopened.close(); }
  } finally { await first.close(); await second.close(); }
}

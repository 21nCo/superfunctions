import { afterEach, expect, it, vi } from 'vitest';
import { MemoryAdapter } from './memory.js';
import { JobImpl } from '../queue/job.js';
import type { JobOptions } from '../queue/types.js';
afterEach(() => vi.restoreAllMocks());
async function add(adapter: MemoryAdapter, id: string, opts: JobOptions = {}) {
  const job = new JobImpl('work', {}, { ...opts, jobId: id });
  await adapter.enqueue('q', job); return job;
}
async function take(adapter: MemoryAdapter, count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push((await adapter.dequeue('q'))!.id);
  return ids;
}
it('preserves LIFO insertion order when every enqueue has the same timestamp', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const adapter = new MemoryAdapter();
  for (const id of ['a', 'b', 'c']) await add(adapter, id, { lifo: true });
  expect(await take(adapter, 3)).toEqual(['c', 'b', 'a']);
});
it('orders priority before mixed LIFO/FIFO and ignores wall-clock regression for insertion order', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000); const adapter = new MemoryAdapter();
  await add(adapter, 'fifo-first'); clock.mockReturnValue(900);
  await add(adapter, 'lifo-first', { lifo: true }); await add(adapter, 'fifo-last');
  await add(adapter, 'lifo-last', { lifo: true }); await add(adapter, 'priority', { priority: 10 });
  expect(await take(adapter, 5)).toEqual(['priority', 'lifo-last', 'lifo-first', 'fifo-first', 'fifo-last']);
});
it('moves an explicitly requeued job to the insertion tail but preserves order on saves', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000); const adapter = new MemoryAdapter();
  const first = await add(adapter, 'first'); await add(adapter, 'second');
  await adapter.saveJob('q', first);
  expect((await adapter.dequeue('q'))!.id).toBe('first');
  const owned = (await adapter.getJob('q', 'first'))!;
  await adapter.enqueue('q', owned);
  expect(await take(adapter, 2)).toEqual(['second', 'first']);
});
it('skips blocked dependencies, future delays and other names without losing ordering', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000); const adapter = new MemoryAdapter();
  await add(adapter, 'blocked', { priority: 100, waitFor: ['missing'] });
  await add(adapter, 'delayed', { priority: 100, delay: 500 });
  await add(adapter, 'ready');
  const other = new JobImpl('other', {}, { jobId: 'other', priority: 100 }); await adapter.enqueue('q', other);
  expect((await adapter.dequeue('q', 'work'))!.id).toBe('ready');
  expect(await adapter.dequeue('q', 'work')).toBeNull();
});

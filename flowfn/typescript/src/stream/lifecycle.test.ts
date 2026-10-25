import { streamFilterContract } from '../storage/stream-filter-contract.js';
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryAdapter } from "../adapters/memory.js";
import { StreamImpl } from "./stream.js";
import type { Message } from "./types.js";
const adapters: MemoryAdapter[] = [];
const adapter = () => {
  const value = new MemoryAdapter();
  adapters.push(value);
  return value;
};
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const value of adapters.splice(0)) await value.cleanup();
  vi.useRealTimers();
});
it('rejects unsupported partition configuration and explicit labels before writing', async () => {
  const storage = adapter();
  const configured = new StreamImpl('partitioned', storage, { partitions: 3 });
  const legacy = new StreamImpl('legacy', storage);
  await expect(configured.publish(1, { key: 'tenant' })).rejects.toThrow('does not support durable stream partitioning');
  await expect(legacy.publish(2, { partition: 0 })).rejects.toThrow('does not support durable stream partitioning');
  expect(await storage.getMessages('partitioned', '-', '+')).toEqual([]);
  expect(await storage.getMessages('legacy', '-', '+')).toEqual([]);
  await configured.close();
  await legacy.close();
});
it("delivers each message to one member per group with manual acknowledgment backpressure", async () => {
  const storage = adapter(),
    stream = new StreamImpl<number>("events", storage),
    a: Message<number>[] = [],
    b: Message<number>[] = [],
    other: number[] = [];
  const first = stream.createConsumer("first", {
      groupId: "group",
      autoCommit: false,
      maxInFlight: 1,
    }),
    second = stream.createConsumer("second", {
      groupId: "group",
      autoCommit: false,
      maxInFlight: 1,
    }),
    independent = stream.createConsumer("other", { groupId: "other" });
  await first.subscribe(async (message) => {
    a.push(message);
  });
  await second.subscribe(async (message) => {
    b.push(message);
  });
  await independent.subscribe(async (message) => {
    other.push(message.data);
  });
  await stream.publishBatch([1, 2, 3].map((data) => ({ data })));
  await vi.advanceTimersByTimeAsync(0);
  expect(a.length + b.length).toBe(2);
  expect(other).toEqual([1, 2, 3]);
  await a[0].ack();
  await vi.advanceTimersByTimeAsync(0);
  expect(a.length + b.length).toBe(3);
  expect(new Set([...a, ...b].map((message) => message.id)).size).toBe(3);
  await stream.close();
});
it("requeues nacks and disconnects while stale acknowledgments cannot consume a reassigned delivery", async () => {
  const storage = adapter(),
    stream = new StreamImpl<number>("events", storage),
    seen: Message<number>[] = [];
  const first = stream.createConsumer("first", {
    groupId: "group",
    autoCommit: false,
  });
  await first.subscribe(async (message) => {
    seen.push(message);
  });
  await stream.publish(1);
  await vi.advanceTimersByTimeAsync(0);
  await seen[0].nack(true);
  await vi.advanceTimersByTimeAsync(20);
  expect(seen).toHaveLength(2);
  await first.close();
  const next: Message<number>[] = [];
  const second = stream.createConsumer("second", {
    groupId: "group",
    autoCommit: false,
  });
  await second.subscribe(async (message) => {
    next.push(message);
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(next).toHaveLength(1);
  await seen[1].ack();
  await stream.publish(2);
  await vi.advanceTimersByTimeAsync(0);
  expect(next).toHaveLength(1);
  await next[0].ack();
  await vi.advanceTimersByTimeAsync(0);
  expect(next.map((message) => message.data)).toEqual([1, 2]);
  await stream.close();
});
it("pause prevents future delivery and resume preserves unacknowledged and undispatched messages", async () => {
  const stream = new StreamImpl<number>("events", adapter()),
    seen: number[] = [];
  const consumer = stream.createConsumer("one", { groupId: "group" });
  await consumer.subscribe(async (message) => {
    seen.push(message.data);
  });
  await consumer.pause();
  await stream.publish(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(seen).toEqual([]);
  await consumer.resume();
  await vi.advanceTimersByTimeAsync(0);
  expect(seen).toEqual([1]);
  await stream.close();
  await stream
    .publish(2)
    .catch((error) => expect(error.message).toContain("closed"));
  expect(vi.getTimerCount()).toBe(0);
});
it("reopens retained history, uses chronological ranges and honors millisecond retention and zero limits", async () => {
  const storage = adapter(),
    stream = new StreamImpl<number>("events", storage, { retention: 100 });
  const first = await stream.publish(1);
  await vi.advanceTimersByTimeAsync(50);
  const second = await stream.publish(2);
  const reopened = new StreamImpl<number>("events", storage);
  expect(
    (await reopened.getMessages(first, second)).map((message) => message.data),
  ).toEqual([1, 2]);
  expect(await reopened.getMessages("-", "+", 0)).toEqual([]);
  await vi.advanceTimersByTimeAsync(50);
  await stream.publish(3);
  expect(
    (await reopened.getMessages("-", "+")).map((message) => message.data),
  ).toEqual([2, 3]);
  const seen: number[] = [];
  const consumer = reopened.createConsumer("new", {
    groupId: "history",
    fromBeginning: true,
  });
  await consumer.subscribe(async (message) => {
    seen.push(message.data);
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(seen).toEqual([2, 3]);
  expect(await reopened.trim({ maxLength: 0 })).toBe(2);
  expect((await stream.getInfo()).length).toBe(0);
  await reopened.close();
  await stream.close();
});
it("delays automatic commits by the requested interval and removes timers on cleanup", async () => {
  const stream = new StreamImpl<number>("events", adapter()),
    seen: number[] = [];
  const consumer = stream.createConsumer("one", {
    groupId: "group",
    commitInterval: 100,
  });
  await consumer.subscribe(async (message) => {
    seen.push(message.data);
  });
  await stream.publish(1);
  await stream.publish(2);
  await vi.advanceTimersByTimeAsync(99);
  expect(seen).toEqual([1]);
  await vi.advanceTimersByTimeAsync(1);
  expect(seen).toEqual([1, 2]);
  await stream.close();
  expect(vi.getTimerCount()).toBe(0);
});

it('applies age retention on reads without another publish and rejects fractional length before writes', async () => {
  const storage = adapter();
  expect(() => new StreamImpl('invalid', storage, { maxLength: 1.5 })).toThrow('integer');
  expect(await storage.getMessages('invalid', '-', '+')).toEqual([]);
  const stream = new StreamImpl('idle', storage, { retention: 50 });
  await stream.publish(1);
  await vi.advanceTimersByTimeAsync(50);
  expect(await stream.getMessages('-', '+')).toEqual([]);
  expect((await stream.getInfo()).length).toBe(0);
  await stream.close();
});
it('admits only one concurrent consumer subscription and releases late acquisition after close', async () => {
  const storage = adapter();
  let resolve!: (value: { unsubscribe: () => Promise<void> }) => void;
  const acquire = vi.spyOn(storage, 'consume').mockImplementation(() => new Promise(done => { resolve = done; }));
  const stream = new StreamImpl('admission', storage);
  const consumer = stream.createConsumer('one', { groupId: 'group' });
  const first = consumer.subscribe(async () => {});
  await expect(consumer.subscribe(async () => {})).rejects.toThrow('already subscribed');
  await Promise.resolve();
  expect(acquire).toHaveBeenCalledTimes(1);
  await consumer.close();
  const unsubscribe = vi.fn(async () => {});
  resolve({ unsubscribe });
  await expect(first).rejects.toThrow('closed');
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  await stream.close();
});

it('counts running acknowledged callbacks separately from finished unacknowledged deliveries', async () => {
  const stream = new StreamImpl<number>('slots', adapter());
  const seen: Message<number>[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const consumer = stream.createConsumer('one', { groupId: 'group', maxInFlight: 2, autoCommit: false });
  await consumer.subscribe(async message => { seen.push(message); if (message.data === 1) { await message.ack(); await gate; } });
  await stream.publishBatch([1, 2, 3].map(data => ({ data })));
  await vi.advanceTimersByTimeAsync(0);
  expect(seen.map(message => message.data)).toEqual([1, 2]);
  await seen[1].ack();
  await vi.advanceTimersByTimeAsync(0);
  expect(seen.map(message => message.data)).toEqual([1, 2, 3]);
  release();
  await stream.close();
});
it('aborts memory handlers and does not create delayed commits after unsubscribe', async () => {
  const stream = new StreamImpl<number>('cancel-memory', adapter());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: Message<number>[] = [];
  const consumer = stream.createConsumer('one', { groupId: 'group', commitInterval: 100 });
  await consumer.subscribe(async message => { seen.push(message); await gate; });
  await stream.publish(1);
  await vi.advanceTimersByTimeAsync(0);
  await consumer.close();
  expect(seen[0].signal?.aborted).toBe(true);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  await stream.close();
});

it('filters subscribers and groups while preserving history and retrying failed predicates', async () => { await streamFilterContract(adapter()); });
it('rejects invalid predicates before subscription acquisition', async () => {
  const storage = adapter();
  const acquire = vi.spyOn(storage, 'subscribe');
  const stream = new StreamImpl('invalid-filter', storage);
  await expect(stream.subscribe(async () => {}, { filter: true as any })).rejects.toThrow('function');
  expect(() => stream.createConsumer('one', { groupId: 'group', filter: true as any })).toThrow('function');
  expect(acquire).not.toHaveBeenCalled();
  await stream.close();
});

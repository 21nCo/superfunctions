import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFlow, type FlowFn } from "../core/flow-fn.js";
const flows: FlowFn[] = [];
const make = () => {
  const flow = createFlow({ adapter: "memory" });
  flows.push(flow);
  return flow;
};
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const flow of flows.splice(0)) await flow.close();
  vi.useRealTimers();
});
it("isolates identical job IDs across queues and keeps terminal failures distinct", async () => {
  const flow = make(),
    first = flow.queue("first"),
    second = flow.queue("second");
  const a = await first.add("task", { secret: 1 }, { jobId: "same" }),
    b = await second.add("task", { secret: 2 }, { jobId: "same" });
  first.process(async () => {
    throw new Error("failure");
  });
  second.process(async () => 42);
  await vi.advanceTimersByTimeAsync(50);
  expect((await first.getJob(a.id))?.state).toBe("failed");
  expect((await second.getJob(b.id))?.returnvalue).toBe(42);
  expect(await first.clean(0, "completed")).toBe(0);
  expect((await second.getJobCounts()).completed).toBe(1);
  await expect((await first.getJob(a.id))!.waitUntilFinished()).rejects.toThrow(
    "failure",
  );
});
it("honors names, priority, delays and pause/resume without starting duplicate workers", async () => {
  const flow = make(),
    queue = flow.queue<number>("work"),
    seen: number[] = [];
  await queue.add("other", 9);
  await queue.add("work", 1, { priority: 1 });
  await queue.add("work", 2, { priority: 10 });
  await queue.add("work", 3, { delay: 100 });
  await queue.pause();
  queue.process("work", async (job) => {
    seen.push(job.data);
    return job.data;
  });
  await vi.advanceTimersByTimeAsync(50);
  expect(seen).toEqual([]);
  await queue.resume();
  await vi.advanceTimersByTimeAsync(30);
  expect(seen).toEqual([2, 1]);
  await vi.advanceTimersByTimeAsync(50);
  expect(seen).toEqual([2, 1, 3]);
  expect((await queue.getJobs("waiting")).map((job) => job.data)).toEqual([9]);
});
it("persists progress/logs and retry backoff, then drains while idle workers stay alive", async () => {
  const queue = make().queue("retry");
  let attempts = 0;
  const job = await queue.add(
    "task",
    {},
    { attempts: 2, backoff: { type: "fixed", delay: 100 } },
  );
  queue.process(async (value) => {
    attempts++;
    await value.updateProgress(50);
    await value.log("started");
    if (attempts === 1) throw new Error("retry");
    return 7;
  });
  await vi.advanceTimersByTimeAsync(50);
  expect(attempts).toBe(1);
  expect((await queue.getJob(job.id))?.state).toBe("delayed");
  await vi.advanceTimersByTimeAsync(100);
  await queue.drain();
  const saved = (await queue.getJob(job.id))!;
  expect(saved.returnvalue).toBe(7);
  expect(saved.progress).toBe(50);
  expect(saved.logs).toHaveLength(2);
  expect(saved.attemptsMade).toBe(1);
});
it("deduplicates concurrent additions and retries a failed bound job", async () => {
  const queue = make().queue("dedup");
  const [a, b] = await Promise.all([
    queue.add("task", { id: 1 }, { deduplicationKey: "key" }),
    queue.add("task", { id: 1 }, { deduplicationKey: "key" }),
  ]);
  expect(a.id).toBe(b.id);
  let attempt = 0;
  queue.process(async () => {
    if (attempt++ === 0) throw new Error("first");
    return "ok";
  });
  await vi.advanceTimersByTimeAsync(30);
  await (await queue.getJob(a.id))!.retry();
  await vi.advanceTimersByTimeAsync(30);
  expect(await (await queue.getJob(a.id))!.waitUntilFinished()).toBe("ok");
});
it("tracks batch work during close and requeues an incomplete collection without running its handler", async () => {
  const queue = make().queue("batch");
  const job = await queue.add("item", 1);
  const handler = vi.fn(async (jobs) => jobs.map((job: any) => job.data));
  queue.processBatch("batch-label", { batchSize: 10, maxWait: 1000 }, handler);
  await vi.advanceTimersByTimeAsync(10);
  await queue.close();
  expect(handler).not.toHaveBeenCalled();
  expect((await queue.getJob(job.id))?.state).toBe("waiting");
});
it("validates worker concurrency and removes completed records when requested", async () => {
  const queue = make().queue("remove");
  expect(() => queue.process(0, async () => {})).toThrow("positive");
  const job = await queue.add("task", {}, { removeOnComplete: true });
  queue.process(async () => 1);
  await vi.advanceTimersByTimeAsync(30);
  expect(await queue.getJob(job.id)).toBeNull();
});

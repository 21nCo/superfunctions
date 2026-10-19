import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createFlow } from "../core/flow-fn.js";

describe("Batch Processing", () => {
  let flow: ReturnType<typeof createFlow>;

  beforeEach(() => {
    flow = createFlow({ adapter: "memory" });
  });

  afterEach(async () => {
    await flow.close();
  });


  it("keeps jobs for other processors waiting", async () => {
    const queue = flow.queue("batch-names");
    const other = await queue.add("other", 1);
    const selected = await queue.add("selected", 2);
    queue.processBatch("selected", { batchSize: 2, maxWait: 10 }, async jobs => jobs.map(job => job.data * 2));
    await selected.waitUntilFinished();
    expect((await queue.getJob(selected.id))?.returnvalue).toBe(4);
    expect((await queue.getJob(other.id))?.state).toBe("waiting");
  });

  it("applies cache and retention to individual batch results", async () => {
    const queue = flow.queue("batch-cache", { cache: { enabled: true, ttl: 1000 } });
    let calls = 0;
    queue.processBatch("work", { batchSize: 2, maxWait: 5 }, async jobs => {
      calls++;
      return jobs.map(job => job.data * 2);
    });
    const first = await queue.add("work", 2);
    await queue.drain();
    expect((await queue.getJob(first.id))?.returnvalue).toBe(4);
    const cached = await queue.add("work", 2, { removeOnComplete: true });
    const fresh = await queue.add("work", 3);
    await queue.drain();
    expect(calls).toBe(2);
    expect(await queue.getJob(cached.id)).toBeNull();
    expect((await queue.getJob(fresh.id))?.returnvalue).toBe(6);
  });

  it("enforces per-job batch timeouts and propagates cancellation", async () => {
    const queue = flow.queue("batch-timeout");
    const timed = await queue.add("work", {}, { timeout: 10 });
    let aborted = false;
    queue.processBatch("work", { batchSize: 1, maxWait: 1 }, async jobs => {
      await new Promise<void>(resolve => jobs[0].signal!.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
      return ["too late"];
    });
    await queue.drain();
    expect(aborted).toBe(true);
    expect((await queue.getJob(timed.id))?.state).toBe("failed");
    expect((await queue.getJob(timed.id))?.failedReason).toBe("Job timed out");
  });

  it("charges each batched job to the configured rate limiter", async () => {
    const queue = flow.queue("batch-rate", { limiter: { max: 1, duration: 40 } });
    await queue.addBulk([{ name: "work", data: 1 }, { name: "work", data: 2 }]);
    const started = Date.now();
    queue.processBatch("work", { batchSize: 2, maxWait: 5 }, async jobs => jobs.map(job => job.data));
    await queue.drain();
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    expect((await queue.getJobCounts()).completed).toBe(2);
  });

  it("should process jobs in batches", async () => {
    const queue = flow.queue("batch-test");
    let processedBatches = 0;

    await queue.addBulk([
      { name: "test", data: 1 },
      { name: "test", data: 2 },
      { name: "test", data: 3 },
    ]);

    await new Promise<void>((resolve) => {
      queue.processBatch("test", 2, async (jobs) => {
        processedBatches++;
        if (processedBatches === 2) resolve();
        return jobs.map((j) => j.data * 2);
      });
    });

    expect(processedBatches).toBe(2); // One batch of 2, one batch of 1
  });
});

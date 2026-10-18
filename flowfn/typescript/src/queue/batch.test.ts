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

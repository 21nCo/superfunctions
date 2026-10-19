import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createFlow } from "../core/flow-fn.js";

describe("Job Dependencies", () => {
  let flow: ReturnType<typeof createFlow>;

  beforeEach(() => {
    flow = createFlow({ adapter: "memory" });
  });

  afterEach(async () => {
    await flow.close();
  });

  it("should wait for dependencies to complete", async () => {
    const queue = flow.queue("dep-test");
    let order: string[] = [];

    const job1 = await queue.add("job1", { id: 1 });
    const job2 = await queue.add("job2", { id: 2 }, { waitFor: [job1.id] });

    // Start processing
    queue.process(async (job) => {
      order.push(job.name);
      return { done: true };
    });

    // Wait for both to complete
    await new Promise((r) => setTimeout(r, 500));

    expect(order).toEqual(["job1", "job2"]);
  });
});

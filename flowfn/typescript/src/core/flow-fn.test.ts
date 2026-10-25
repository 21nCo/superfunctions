import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createFlow } from "./flow-fn.js";

describe("flowfn", () => {
  let flow: ReturnType<typeof createFlow>;

  beforeEach(() => {
    flow = createFlow({ adapter: "memory" });
  });

  afterEach(async () => {
    await flow.close();
  });

  it("should process jobs in a queue", async () => {
    const queue = flow.queue("test-queue");

    // Add job
    await queue.add("job1", { foo: "bar" });

    const stats = await queue.getJobCounts();
    expect(stats.waiting).toBe(1);

    // Process
    await new Promise<void>((resolve) => {
      queue.process(async (job) => {
        expect(job.data.foo).toBe("bar");
        resolve();
        return { processed: true };
      });
    });
  });

  it("should stream messages", async () => {
    const stream = flow.stream("test-stream");
    const received: any[] = [];

    await stream.subscribe(async (msg) => {
      received.push(msg.data);
    });

    await stream.publish({ event: "test" });

    // Wait for event loop
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ event: "test" });
  });

  it('rejects changing the partition setting of an existing stream handle', () => {
    const configured = flow.stream('partitioned', { partitions: 3 });
    expect(flow.stream('partitioned')).toBe(configured);
    expect(flow.stream('partitioned', { partitions: 3 })).toBe(configured);
    expect(() => flow.stream('partitioned', { partitions: 4 })).toThrow(/partition/i);
    flow.stream('discovered');
    expect(() => flow.stream('discovered', { partitions: 3 })).toThrow(/partition/i);
  });

  it("should execute a simple workflow", async () => {
    const workflow = flow
      .workflow("test-workflow")
      .step("step1", async (ctx) => {
        await ctx.sleep(100); // Wait so we can catch it running
        ctx.set("step1", "done");
        return "result1";
      })
      .build();

    const execution = await workflow.execute({ input: "test" });

    expect(execution.status).toBe("running");

    // Wait for execution
    await new Promise((r) => setTimeout(r, 150));

    const status = await workflow.getExecution(execution.id);
    expect(status.status).toBe("completed");
  });
});

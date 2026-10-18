import type { QueueImpl } from "./queue.js";
import { describe, it, expect, vi } from "vitest";
import { createFlow } from "../core/flow-fn.js";
import { createWorker } from "./worker.js";

describe("worker lifecycle", () => {
  it("starts registered processors only on run and does not duplicate repeated starts", async () => {
    const flow = createFlow({ adapter: "memory" });
    const queue = flow.queue("work");
    const worker = createWorker({ flow, queues: ["work"], concurrency: 2 });
    const handler = vi.fn(async (job) => job.data);
    worker.register("work", handler);
    await queue.add("task", 3);
    expect(handler).not.toHaveBeenCalled();
    const completed = vi.fn();
    worker.on("completed", completed);
    await worker.run();
    await worker.run();
    await queue.drain();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
    await worker.close();
    expect((queue as QueueImpl).listenerCount("completed")).toBe(1); // Only Flow metrics observer remains.
    await expect(worker.run()).rejects.toThrow("closed");
    await flow.close();
  });
  it("rejects unbound and duplicate processors and waits for an active handler at close", async () => {
    const flow = createFlow({ adapter: "memory" });
    const worker = createWorker({ flow, queues: ["work"] });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = vi.fn();
    worker.register("work", async () => {
      started();
      await wait;
    });
    expect(() => worker.register("work", async () => {})).toThrow("already");
    expect(() => worker.register("outside", async () => {})).toThrow("outside");
    await worker.run();
    await flow.queue("work").add("task", 1);
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    let closed = false;
    const closing = worker.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    await flow.close();
  });
});

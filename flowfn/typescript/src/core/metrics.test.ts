import { describe, it, expect, vi } from "vitest";
import { createFlow } from "./flow-fn.js";
import { createWorker } from "../queue/worker.js";
describe("live metrics", () => {
  it("tracks actual queue execution, active workers, registered resources and workflow outcomes", async () => {
    const flow = createFlow({ adapter: "memory", namespace: "metrics" });
    const completedEvent = vi.fn();
    flow.on("job:completed", completedEvent);
    const queue = flow.queue("jobs");
    flow.stream("events");
    const worker = createWorker({ flow, queues: ["jobs"] });
    worker.register("jobs", async () => 42);
    await worker.run();
    await queue.add("task", {});
    await queue.drain();
    expect(completedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: "jobs",
        jobId: expect.any(String),
        result: 42,
        duration: expect.any(Number),
      }),
    );
    const workflow = flow.workflow("approval").waitForEvent("go").build();
    const execution = await workflow.execute({});
    expect(await flow.metrics.getSystemMetrics()).toMatchObject({
      queues: 1,
      streams: 1,
      workflows: 1,
      workers: 1,
    });
    expect(await flow.metrics.getQueueMetrics("jobs")).toMatchObject({
      completed: 1,
      throughput: 1 / 60,
    });
    expect(await flow.metrics.getWorkflowMetrics("approval")).toMatchObject({
      totalExecutions: 1,
      running: 1,
      completed: 0,
    });
    await workflow.signalEvent(execution.id, "go");
    await workflow.waitForCompletion(execution.id);
    expect(await flow.metrics.getWorkflowMetrics("approval")).toMatchObject({
      running: 0,
      completed: 1,
      successRate: 100,
    });
    await worker.close();
    expect((await flow.metrics.getSystemMetrics()).workers).toBe(0);
    await flow.close();
  });
  it("measures published messages and delivery latency and isolates metric tags and returned snapshots", async () => {
    const flow = createFlow({ adapter: "memory" });
    const stream = flow.stream("events");
    const received = vi.fn();
    await stream.subscribe(async (message) => {
      received(message.data);
    });
    await stream.publish(1);
    await vi.waitFor(() => expect(received).toHaveBeenCalled());
    expect(await flow.metrics.getStreamMetrics("events")).toMatchObject({
      length: 1,
      throughput: 1,
      avgLatency: expect.any(Number),
    });
    flow.metrics.record("value", 3, { a: "b,c:d" });
    flow.metrics.record("value", 8, { a: "b", c: "d" });
    const series = flow.metrics.getTimeSeries("value", {
      tags: { a: "b,c:d" },
    })!;
    series.dataPoints[0].value = 99;
    expect(
      flow.metrics.getTimeSeries("value", { tags: { a: "b,c:d" } })!.avg,
    ).toBe(3);
    expect(
      flow.metrics.getTimeSeries("value", {
        tags: { a: "b", c: "d" },
        limit: 0,
      }),
    ).toBeNull();
    expect(() => flow.metrics.record("value", NaN)).toThrow("finite");
    await flow.close();
  });
});

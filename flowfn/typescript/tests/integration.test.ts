/**
 * Integration tests for FlowFn
 * Tests the complete stack: queues, streams, workflows together
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createFlow } from "../src/core/flow-fn.js";
import { FlowFn } from "../src/core/flow-fn.js";

describe("FlowFn Integration Tests", () => {
  let flow: FlowFn;

  beforeEach(() => {
    flow = createFlow({ adapter: "memory" });
  });

  afterEach(async () => {
    await flow.close();
  });

  describe("Queue + Stream Integration", () => {
    it("should process queue jobs and publish to stream", async () => {
      const queue = flow.queue("processing");
      const stream = flow.stream("events");
      const results: any[] = [];

      // Subscribe to stream
      await stream.subscribe(async (msg) => {
        results.push(msg.data);
        await msg.ack();
      });

      // Process queue and publish to stream
      queue.process(async (job) => {
        await stream.publish({ processed: job.data });
        return { success: true };
      });

      // Add jobs
      await queue.add("task", { value: 1 });
      await queue.add("task", { value: 2 });

      // Wait for processing
      await new Promise((r) => setTimeout(r, 100));

      expect(results.length).toBeGreaterThan(0);
    }, 10000);
  });

  describe("Workflow + Queue Integration", () => {
    it("should trigger workflow from queue job", async () => {
      const queue = flow.queue("triggers");
      let workflowExecuted = false;

      const workflow = flow
        .workflow("process-order")
        .step("validate", async (ctx) => {
          ctx.set("validated", true);
        })
        .step("execute", async (ctx) => {
          workflowExecuted = true;
          ctx.set("executed", true);
        })
        .build();

      queue.process(async (job) => {
        await workflow.execute(job.data);
        return { done: true };
      });

      await queue.add("order", { orderId: "123" });

      // Wait for processing
      await new Promise((r) => setTimeout(r, 200));

      expect(workflowExecuted).toBe(true);
    }, 10000);
  });

  describe("Health Check Integration", () => {
    it("should report healthy system", async () => {
      const health = await flow.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.timestamp).toBeGreaterThan(0);
      expect(health.checks.length).toBeGreaterThan(0);

      // Should have default checks
      const checkNames = health.checks.map((c) => c.name);
      expect(checkNames).toContain("uptime");
      expect(checkNames).toContain("memory");
    });

    it("should track health check events", async () => {
      await flow.healthCheck();

      const tracker = flow.getEventTracker();
      const events = tracker.getEvents({ type: "health.check" });

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].category).toBe("system");
    });
  });

  describe("Metrics Integration", () => {
    it("should collect queue metrics", async () => {
      const queue = flow.queue("metrics-test");

      // Record some metrics
      flow.metrics.record("queue.throughput", 10, { queue: "metrics-test" });
      flow.metrics.record("queue.throughput", 20, { queue: "metrics-test" });

      const metrics = await flow.metrics.getQueueMetrics("metrics-test");

      expect(metrics).toBeDefined();
      expect(metrics.waiting).toBeDefined();
    });
  });

  describe("Complete E2E Flow", () => {
    it("should handle queue → workflow → stream flow", async () => {
      const queue = flow.queue("orders");
      const stream = flow.stream("order-events");
      const results: string[] = [];

      // Subscribe to events
      await stream.subscribe(async (msg) => {
        results.push(msg.data.status);
        await msg.ack();
      });

      // Workflow for order processing
      const workflow = flow
        .workflow("order-processing")
        .step("validate", async (ctx) => {
          await stream.publish({ status: "validating", order: ctx.input });
          ctx.set("valid", true);
        })
        .step("process", async (ctx) => {
          await stream.publish({ status: "processing", order: ctx.input });
          ctx.set("processed", true);
        })
        .step("complete", async (ctx) => {
          await stream.publish({ status: "completed", order: ctx.input });
        })
        .build();

      // Queue processor triggers workflow
      queue.process(async (job) => {
        await workflow.execute(job.data);
        return { success: true };
      });

      // Add order
      await queue.add("new-order", { id: "order-123", amount: 100 });

      // Wait for complete flow
      await new Promise((r) => setTimeout(r, 300));

      // Should have all events
      expect(results).toContain("validating");
      expect(results).toContain("processing");
      expect(results).toContain("completed");
    }, 10000);
  });

  describe("Error Handling Integration", () => {
    it("should handle workflow failures gracefully", async () => {
      const workflow = flow
        .workflow("failing-workflow")
        .step("step1", async (ctx) => {
          ctx.set("step1", true);
        })
        .step("step2", async (ctx) => {
          throw new Error("Intentional failure");
        })
        .step("step3", async (ctx) => {
          ctx.set("step3", true); // Should not execute
        })
        .build();

      const execution = await workflow.execute({ test: true });

      // Wait for execution
      await new Promise((r) => setTimeout(r, 100));

      const result = await workflow.getExecution(execution.id);
      expect(result.status).toBe("failed");
      expect(result.error).toBeDefined();
    }, 10000);
  });

  describe("Concurrent Operations", () => {
    it("should handle multiple queues concurrently", async () => {
      const queue1 = flow.queue("concurrent-1");
      const queue2 = flow.queue("concurrent-2");

      let count1 = 0;
      let count2 = 0;

      queue1.process(async () => {
        count1++;
      });
      queue2.process(async () => {
        count2++;
      });

      // Add jobs to both queues
      await Promise.all([
        queue1.add("job", { id: 1 }),
        queue1.add("job", { id: 2 }),
        queue2.add("job", { id: 3 }),
        queue2.add("job", { id: 4 }),
      ]);

      await new Promise((r) => setTimeout(r, 200));

      expect(count1).toBe(2);
      expect(count2).toBe(2);
    }, 10000);

    it("should handle multiple streams concurrently", async () => {
      const stream1 = flow.stream("stream-1");
      const stream2 = flow.stream("stream-2");

      const results1: any[] = [];
      const results2: any[] = [];

      await stream1.subscribe(async (msg) => {
        results1.push(msg.data);
        await msg.ack();
      });

      await stream2.subscribe(async (msg) => {
        results2.push(msg.data);
        await msg.ack();
      });

      // Publish to both streams
      await Promise.all([
        stream1.publish({ stream: 1, value: "a" }),
        stream2.publish({ stream: 2, value: "b" }),
        stream1.publish({ stream: 1, value: "c" }),
        stream2.publish({ stream: 2, value: "d" }),
      ]);

      await new Promise((r) => setTimeout(r, 100));

      expect(results1.length).toBe(2);
      expect(results2.length).toBe(2);
    }, 10000);
  });
});

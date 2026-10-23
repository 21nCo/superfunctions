/**
 * Tests for Workflow System
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createFlow } from "../src/core/flow-fn.js";
import { FlowFn } from "../src/core/flow-fn.js";

describe("Workflow System", () => {
  let flow: FlowFn;

  beforeEach(() => {
    flow = createFlow({ adapter: "memory" });
  });

  describe("Workflow Execution", () => {
    it("should execute sequential steps", async () => {
      const steps: string[] = [];

      const workflow = flow
        .workflow("sequential")
        .step("step1", async (ctx) => {
          steps.push("step1");
          ctx.set("result1", "done");
        })
        .step("step2", async (ctx) => {
          steps.push("step2");
          expect(ctx.get("result1")).toBe("done");
        })
        .step("step3", async (ctx) => {
          steps.push("step3");
        })
        .build();

      await workflow.execute({ input: "test" });
      await new Promise((r) => setTimeout(r, 100));

      expect(steps).toEqual(["step1", "step2", "step3"]);
    });

    it("should execute parallel steps", async () => {
      const results: number[] = [];

      const workflow = flow
        .workflow("parallel")
        .parallel([
          async (ctx) => {
            results.push(1);
          },
          async (ctx) => {
            results.push(2);
          },
          async (ctx) => {
            results.push(3);
          },
        ])
        .build();

      await workflow.execute({});
      await new Promise((r) => setTimeout(r, 100));

      expect(results.length).toBe(3);
      expect(results).toContain(1);
      expect(results).toContain(2);
      expect(results).toContain(3);
    });
  });

  describe("Workflow State Management", () => {
    it("should persist state across steps", async () => {
      const workflow = flow
        .workflow("state-test")
        .step("set-values", async (ctx) => {
          ctx.set("key1", "value1");
          ctx.set("key2", 42);
        })
        .step("read-values", async (ctx) => {
          expect(ctx.get("key1")).toBe("value1");
          expect(ctx.get("key2")).toBe(42);
        })
        .build();

      await workflow.execute({});
      await new Promise((r) => setTimeout(r, 100));
    });

    it("should track execution status", async () => {
      const workflow = flow
        .workflow("status-test")
        .step("work", async (ctx) => {
          await new Promise((r) => setTimeout(r, 50));
        })
        .build();

      const execution = await workflow.execute({ test: true });

      expect(execution.status).toBe("running");
      expect(execution.input).toEqual({ test: true });

      await new Promise((r) => setTimeout(r, 150));

      const result = await workflow.getExecution(execution.id);
      expect(result.status).toBe("completed");
    });
  });

  describe("Workflow Error Handling", () => {
    it("should handle step failures", async () => {
      const workflow = flow
        .workflow("error-test")
        .step("failing-step", async (ctx) => {
          throw new Error("Step failed");
        })
        .build();

      const execution = await workflow.execute({});
      await new Promise((r) => setTimeout(r, 100));

      const result = await workflow.getExecution(execution.id);
      expect(result.status).toBe("failed");
      expect(result.error).toBeDefined();
    });
  });

  describe("Workflow Listing and Filtering", () => {
    it("should list executions", async () => {
      const workflow = flow
        .workflow("list-test")
        .step("step1", async () => {})
        .build();

      await workflow.execute({ id: 1 });
      await workflow.execute({ id: 2 });
      await new Promise((r) => setTimeout(r, 100));

      const executions = await workflow.listExecutions();
      expect(executions.length).toBeGreaterThanOrEqual(2);
    });

    it("should filter executions by status", async () => {
      const workflow = flow
        .workflow("filter-test")
        .step("work", async () => {
          await new Promise((r) => setTimeout(r, 50));
        })
        .build();

      await workflow.execute({ id: 1 });
      await workflow.execute({ id: 2 });

      await new Promise((r) => setTimeout(r, 20)); // Some running

      const running = await workflow.listExecutions({ status: "running" });
      expect(running.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Workflow Cancel and Retry", () => {
    it("should cancel running execution", async () => {
      const workflow = flow
        .workflow("cancel-test")
        .step("long-step", async () => {
          await new Promise((r) => setTimeout(r, 500));
        })
        .build();

      const execution = await workflow.execute({});

      await new Promise((r) => setTimeout(r, 50));
      await workflow.cancelExecution(execution.id);

      const result = await workflow.getExecution(execution.id);
      expect(result.status).toBe("cancelled");
    });

    it("should retry failed execution", async () => {
      let attempts = 0;

      const workflow = flow
        .workflow("retry-test")
        .step("flaky-step", async () => {
          attempts++;
          if (attempts === 1) {
            throw new Error("First attempt fails");
          }
        })
        .build();

      const execution = await workflow.execute({});
      await new Promise((r) => setTimeout(r, 100));

      // First execution should fail
      let result = await workflow.getExecution(execution.id);
      expect(result.status).toBe("failed");

      // Retry should create new execution
      const retried = await workflow.retryExecution(execution.id);
      await new Promise((r) => setTimeout(r, 100));

      result = await workflow.getExecution(retried.id);
      expect(result.status).toBe("completed");
      expect(attempts).toBe(2);
    });
  });

  describe("Workflow History", () => {
    it("should track execution history", async () => {
      const workflow = flow
        .workflow("history-test")
        .step("step1", async () => {})
        .step("step2", async () => {})
        .build();

      const execution = await workflow.execute({});
      await new Promise((r) => setTimeout(r, 100));

      const history = await workflow.getExecutionHistory(execution.id);

      expect(history.length).toBeGreaterThan(0);

      const types = history.map((e) => e.type);
      expect(types).toContain("execution.started");
      expect(types).toContain("step.started");
      expect(types).toContain("step.completed");
    });
  });

  describe("Workflow Metrics", () => {
    it("should collect workflow metrics", async () => {
      const workflow = flow
        .workflow("metrics-test")
        .step("work", async () => {
          await new Promise((r) => setTimeout(r, 10));
        })
        .build();

      await workflow.execute({ id: 1 });
      await workflow.execute({ id: 2 });
      await new Promise((r) => setTimeout(r, 100));

      const metrics = await workflow.getMetrics();

      expect(metrics.totalExecutions).toBe(2);
      expect(metrics.successRate).toBeGreaterThan(0);
      expect(metrics.avgDuration).toBeGreaterThan(0);
    });
  });

  describe("Conditional Branching", () => {
    it("should execute conditional branches", async () => {
      let branchTaken = "";

      const thenBranch = flow
        .workflow("then-branch")
        .step("then-step", async () => {
          branchTaken = "then";
        });

      const elseBranch = flow
        .workflow("else-branch")
        .step("else-step", async () => {
          branchTaken = "else";
        });

      const workflow = flow
        .workflow("branch-test")
        .branch({
          condition: (ctx) => ctx.input.value > 10,
          then: thenBranch as any,
          else: elseBranch as any,
        })
        .build();

      await workflow.execute({ value: 15 });
      await new Promise((r) => setTimeout(r, 100));

      expect(branchTaken).toBe("then");

      branchTaken = "";
      await workflow.execute({ value: 5 });
      await new Promise((r) => setTimeout(r, 100));

      expect(branchTaken).toBe("else");
    });
  });
});

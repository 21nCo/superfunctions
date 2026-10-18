import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFlow, type FlowFn } from "../core/flow-fn.js";
import { MemoryAdapter } from "../adapters/memory.js";
import { WorkflowBuilderImpl } from "./workflow.js";
import type { WorkflowExecution } from "./types.js";
const flows: FlowFn[] = [];
const flow = (namespace?: string) => {
  const value = createFlow({ adapter: "memory", namespace });
  flows.push(value);
  return value;
};
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const value of flows.splice(0)) await value.close();
  vi.useRealTimers();
});
const flush = () => vi.advanceTimersByTimeAsync(0);
it("delivers buffered events FIFO to one execution and forwards results through branch and parallel steps", async () => {
  const app = flow();
  const workflow = app
    .workflow("events")
    .waitForEvent("go")
    .step("double", async (_ctx, value) => value * 2)
    .branch({
      condition: () => true,
      then: app.steps().step("plus", async (_ctx, value) => value + 1),
    })
    .parallel([async (_ctx, value) => value, async (_ctx, value) => value + 1])
    .step("sum", async (_ctx, values) =>
      values.reduce((a: number, b: number) => a + b, 0),
    )
    .build();
  const first = await workflow.execute({}),
    second = await workflow.execute({});
  await app.signalWorkflow(first.id, "go", 3);
  expect((await workflow.waitForCompletion(first.id)).output).toBe(15);
  expect((await workflow.getExecution(second.id)).status).toBe("running");
  await app.signalWorkflow(second.id, "go", 5);
  expect((await workflow.waitForCompletion(second.id)).output).toBe(23);
  await expect(workflow.signalEvent(first.id, "go")).rejects.toThrow(
    "not active",
  );
  expect(await app.listWorkflows()).toEqual([workflow]);
});
it("waits for explicit human approval, preserves rejected decisions and refuses duplicates or wrong roles", async () => {
  const app = flow();
  const workflow = app
    .workflow("approval")
    .waitForApproval("reviewer", {
      timeout: 1000,
      data: () => ({ content: 42 }),
    })
    .step("decision", async (_ctx, decision) => decision)
    .build();
  const execution = await workflow.execute({});
  await flush();
  expect((await workflow.getExecution(execution.id)).waiting).toMatchObject({
    kind: "approval",
    name: "reviewer",
    data: { content: 42 },
  });
  await expect(
    workflow.approveExecution(execution.id, {
      approved: true,
      reviewedBy: "user",
      approver: "other",
    }),
  ).rejects.toThrow("role");
  await app.approveWorkflow(execution.id, {
    approved: false,
    reviewedBy: "user",
    reason: "change required",
  });
  const result = await workflow.waitForCompletion(execution.id);
  expect(result.output).toMatchObject({
    approved: false,
    reason: "change required",
  });
  await expect(
    app.approveWorkflow(execution.id, { approved: true, reviewedBy: "user" }),
  ).rejects.toThrow("not waiting");
});
it("approval timeout invokes onTimeout exactly once and never invokes the approved continuation", async () => {
  const app = flow(),
    timeout = vi.fn(async () => {}),
    next = vi.fn(async () => {});
  const workflow = app
    .workflow("expiry")
    .waitForApproval("reviewer", { timeout: 100, onTimeout: timeout })
    .step("next", next)
    .build();
  const execution = await workflow.execute({});
  await vi.advanceTimersByTimeAsync(100);
  expect((await workflow.waitForCompletion(execution.id)).status).toBe(
    "failed",
  );
  expect(timeout).toHaveBeenCalledTimes(1);
  expect(next).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("cancellation wakes sleeps and event waits, remains terminal and cleans timers", async () => {
  const app = flow(),
    later = vi.fn(async () => {});
  for (const builder of [
    app.workflow("sleep").delay({ days: 40 }),
    app.workflow("wait").waitForEvent("never"),
  ]) {
    const workflow = builder.step("later", later).build(),
      execution = await workflow.execute({});
    await flush();
    await workflow.cancelExecution(execution.id);
    expect((await workflow.waitForCompletion(execution.id)).status).toBe(
      "cancelled",
    );
    await expect(workflow.cancelExecution(execution.id)).rejects.toThrow(
      "inactive",
    );
  }
  expect(later).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("does not compensate while an uncancellable handler can still finish its side effect", async () => {
  const app = flow(),
    calls: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const workflow = app
    .workflow("cancel-side-effect")
    .saga("external", {
      execute: async () => {
        await blocked;
        calls.push("effect");
      },
      compensate: async () => {
        calls.push("undo");
      },
    })
    .step("later", async () => {
      calls.push("later");
    })
    .build();
  const execution = await workflow.execute({});
  await flush();
  await workflow.cancelExecution(execution.id);
  expect(calls).toEqual([]);
  release();
  expect((await workflow.waitForCompletion(execution.id)).status).toBe(
    "cancelled",
  );
  expect(calls).toEqual(["effect", "undo"]);
});
it("waits for parallel settlement before rollback, invokes ordinary-step compensation and records rollback failures", async () => {
  const app = flow(),
    calls: string[] = [];
  const workflow = app
    .workflow("rollback")
    .step("first", async () => {
      calls.push("first");
    })
    .compensate("first", async () => {
      calls.push("undo-first");
    })
    .saga("second", {
      execute: async () => {},
      compensate: async () => {
        calls.push("undo-second");
        throw new Error("refund failed");
      },
    })
    .parallel([
      async () => {
        throw new Error("parallel failure");
      },
      async (ctx) => {
        await ctx.sleep(20);
        calls.push("parallel-finished");
      },
    ])
    .build();
  const execution = await workflow.execute({});
  await vi.advanceTimersByTimeAsync(20);
  const result = await workflow.waitForCompletion(execution.id);
  expect(calls).toEqual([
    "first",
    "parallel-finished",
    "undo-second",
    "undo-first",
  ]);
  expect(result.status).toBe("failed");
  expect(result.error.message).toBe("parallel failure");
  expect(result.compensationErrors).toEqual([
    { step: "second", message: "refund failed" },
  ]);
});
it("runs error handlers but retains the triggering failure if error reporting also throws", async () => {
  const app = flow(),
    handler = vi.fn(async () => {
      throw new Error("notify failed");
    });
  const workflow = app
    .workflow("errors")
    .step("bad", async () => {
      throw new Error("original");
    })
    .onError("bad", handler)
    .build();
  const execution = await workflow.execute({});
  const result = await workflow.waitForCompletion(execution.id);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(result.error.message).toBe("original");
  expect(
    (await workflow.getExecutionHistory(execution.id)).map(
      (event) => event.type,
    ),
  ).toContain("error-handler.failed");
});
it("handles all duration units and does not overflow timers for waits longer than 24 days", async () => {
  const app = flow();
  const workflow = app
    .workflow("long")
    .ownership({ leaseDuration: 60 * 86400000 })
    .delay({ days: 30, hours: 1, minutes: 1, seconds: 1, ms: 1 })
    .build();
  const execution = await workflow.execute({});
  await vi.advanceTimersByTimeAsync(2147483647);
  expect((await workflow.getExecution(execution.id)).status).toBe("running");
  await vi.advanceTimersByTimeAsync(30 * 86400000 + 3661001 - 2147483647);
  expect((await workflow.waitForCompletion(execution.id)).status).toBe(
    "completed",
  );
});
class SnapshotAdapter extends MemoryAdapter {
  get records() { return this.workflowStates; }
  set records(value: Map<string, WorkflowExecution>) { this.workflowStates = value; }
  async saveWorkflowState(id: string, state: WorkflowExecution) {
    this.records.set(id, structuredClone(state));
  }
  async loadWorkflowState(id: string) {
    return structuredClone(this.records.get(id) ?? null);
  }
}
it('rejects changed workflow definitions before acquiring or modifying their checkpoints', async () => {
  const adapter = new SnapshotAdapter();
  const original = new WorkflowBuilderImpl('definition', adapter).waitForEvent('go').build();
  const execution = await original.execute({});
  await flush();
  const before = await adapter.loadWorkflowState(execution.id);
  for (const changed of [
    new WorkflowBuilderImpl('definition', adapter).waitForEvent('different').build(),
    new WorkflowBuilderImpl('definition', adapter).version('2').waitForEvent('go').build(),
  ]) {
    await expect(changed.resumeExecution(execution.id)).rejects.toThrow('definition differs');
    expect(await adapter.loadWorkflowState(execution.id)).toEqual(before);
    await changed.close();
  }
  await original.close();
});
it("recovers persisted event waits and history without replaying completed steps", async () => {
  const adapter = new SnapshotAdapter();
  let completedCalls = 0;
  const build = (storage: SnapshotAdapter) =>
    new WorkflowBuilderImpl("durable", storage)
      .step("effect", async (ctx) => {
        completedCalls++;
        ctx.set("saved", 3);
        return 4;
      })
      .waitForEvent("resume")
      .step("finish", async (ctx, value) => ctx.get("saved") + value)
      .build();
  const original = build(adapter),
    execution = await original.execute({});
  await flush();
  const restartAdapter = new SnapshotAdapter();
  restartAdapter.records = structuredClone(adapter.records);
  await original.close();
  await vi.advanceTimersByTimeAsync(30_001);
  const restored = build(restartAdapter);
  expect((await restored.listExecutions()).map((value) => value.id)).toEqual([
    execution.id,
  ]);
  await restored.resumeExecution(execution.id);
  await restored.signalEvent(execution.id, "resume", 7);
  expect((await restored.waitForCompletion(execution.id)).output).toBe(10);
  expect(completedCalls).toBe(1);
  expect(
    (await restored.getExecutionHistory(execution.id)).map(
      (event) => event.type,
    ),
  ).toContain("execution.resumed");
  await expect(
    new WorkflowBuilderImpl("other", restartAdapter)
      .build()
      .getExecution(execution.id),
  ).rejects.toThrow("not found");
  expect(await restored.listExecutions({ limit: 0 })).toEqual([]);
  await restored.close();
});
it("returns detached snapshots so callers cannot modify workflow state or input", async () => {
  const app = flow(),
    workflow = app.workflow("snapshots").waitForEvent("go").build();
  const input = { value: 1 },
    execution = await workflow.execute(input);
  input.value = 2;
  execution.input.value = 3;
  const read = await workflow.getExecution(execution.id);
  read.state!.injected = true;
  expect((await workflow.getExecution(execution.id)).input.value).toBe(1);
  expect((await workflow.getExecution(execution.id)).state).toEqual({});
});
it("supports independent parallel context waits and consumes repeated event names once each", async () => {
  const app = flow();
  const workflow = app
    .workflow("parallel-waits")
    .parallel([
      async (ctx) => [await ctx.waitForEvent("x"), await ctx.waitForEvent("x")],
      async (ctx) => await ctx.waitForEvent("y"),
    ])
    .build();
  const execution = await workflow.execute({});
  await flush();
  expect((await workflow.getExecution(execution.id)).waitingFor).toHaveLength(
    2,
  );
  await workflow.signalEvent(execution.id, "x", 1);
  await workflow.signalEvent(execution.id, "x", 2);
  await workflow.signalEvent(execution.id, "y", 3);
  expect((await workflow.waitForCompletion(execution.id)).output).toEqual([
    [1, 2],
    3,
  ]);
});
it("recovers an already-consumed event when its surrounding handler must replay after a crash", async () => {
  const adapter = new SnapshotAdapter();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = new WorkflowBuilderImpl("inside-handler", adapter)
    .step("wait", async (ctx) => {
      const value = await ctx.waitForEvent("go");
      await blocked;
      return value;
    })
    .build();
  const execution = await original.execute({});
  await flush();
  await original.signalEvent(execution.id, "go", 9);
  await flush();
  const copied = new SnapshotAdapter();
  copied.records = structuredClone(adapter.records);
  const restored = new WorkflowBuilderImpl("inside-handler", copied)
    .step("wait", async (ctx) => await ctx.waitForEvent("go"))
    .build();
  await vi.advanceTimersByTimeAsync(30_001);
  await restored.resumeExecution(execution.id);
  expect((await restored.waitForCompletion(execution.id)).output).toBe(9);
  release();
  await original.waitForCompletion(execution.id);
  await original.close();
  await restored.close();
});
it("surfaces checkpoint failures instead of reporting durable completion", async () => {
  class FailingAdapter extends SnapshotAdapter {
    async mutateWorkflowState(id: string, change: import('../storage/workflow-control.js').WorkflowMutation) {
      if (change.state?.completedAt !== undefined)
        throw new Error("checkpoint unavailable");
      return super.mutateWorkflowState(id, change);
    }
  }
  const workflow = new WorkflowBuilderImpl("failure", new FailingAdapter())
    .step("done", async () => 1)
    .build();
  const execution = await workflow.execute({});
  await expect(workflow.waitForCompletion(execution.id)).rejects.toThrow(
    "checkpoint unavailable",
  );
});

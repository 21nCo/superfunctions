import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createFlow } from "../core/flow-fn.js";

describe("Workflow Engine", () => {
  let flow: ReturnType<typeof createFlow>;

  beforeEach(() => {
    flow = createFlow({ adapter: "memory" });
  });

  afterEach(async () => {
    await flow.close();
  });

  it("should execute branching logic (true)", async () => {
    const workflow = flow
      .workflow("branch-test")
      .input<{ value: number }>()
      .branch({
        condition: (ctx) => ctx.input.value > 10,
        then: flow.workflow("then-branch").step("high", async (ctx) => {
          ctx.set("result", "high");
        }),
        else: flow.workflow("else-branch").step("low", async (ctx) => {
          ctx.set("result", "low");
        }),
      })
      .build();

    const execution = await workflow.execute({ value: 20 });

    await new Promise((r) => setTimeout(r, 50));

    const state = await workflow.getExecution(execution.id);
    expect(state.status).toBe("completed");
    expect(state.output.result).toBe("high");
  });

  it("should execute saga compensation on failure", async () => {
    let compensationCalled = false;

    const workflow = flow
      .workflow("saga-test")
      .saga("step1", {
        execute: async (ctx) => {
          ctx.set("step1", "done");
        },
        compensate: async (ctx) => {
          compensationCalled = true;
        },
      })
      .step("fail-step", async (ctx) => {
        throw new Error("Boom");
      })
      .build();

    const execution = await workflow.execute({});

    await new Promise((r) => setTimeout(r, 50));

    const state = await workflow.getExecution(execution.id);
    expect(state.status).toBe("failed");
    expect(compensationCalled).toBe(true);
  });
});

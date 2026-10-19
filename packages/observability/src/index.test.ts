import { describe, expect, it, vi } from "vitest";
import {
  createObservability,
  instrumentMethods,
  readObservationGroup,
} from "./index.js";

describe("superfunction observability", () => {
  it("preserves synchronous method return values", () => {
    const observability = createObservability({ service: "test-service" });
    const observed = instrumentMethods({
      target: {
        capabilitiesForTarget() {
          return { transactions: true };
        },
      },
      observability,
      kind: "db",
      component: "test.db",
    });

    const result = observed.capabilitiesForTarget();

    expect(result).toEqual({ transactions: true });
    expect(result).not.toBeInstanceOf(Promise);
  });

  it("records async method metrics into the active request", async () => {
    const observability = createObservability({
      service: "test-service",
    });
    const target = {
      async findOne(input: { model: string }) {
        return { id: input.model };
      },
    };
    const observed = instrumentMethods({
      target,
      observability,
      kind: "db",
      component: "test.db",
      extract: ({ property, args }) => ({
        operation: String(property),
        resource: (args[0] as { model?: string }).model,
      }),
    });
    const request = observability.startRequest({
      requestId: "req_test",
      method: "GET",
      path: "/test",
    });

    await observability.runWithRequest(request, () => observed.findOne({ model: "users" }));
    const snapshot = request.finish({ status: 200 });
    const db = readObservationGroup(snapshot, "db");

    expect(snapshot.requestId).toBe("req_test");
    expect(db.count).toBe(1);
    expect(db.errorCount).toBe(0);
    expect(snapshot.metrics[0]?.component).toBe("test.db");
    expect(snapshot.metrics[0]?.resource).toBe("users");
  });

  it("reads a thenable accessor only once", async () => {
    const observability = createObservability({ service: "test-service" });
    let reads = 0;
    const observed = instrumentMethods({
      target: {
        load() {
          return {
            get then() {
              reads += 1;
              return (resolve: (value: string) => void) => resolve("loaded");
            },
          };
        },
      },
      observability,
      kind: "db",
      component: "test.db",
    });

    await expect(observed.load()).resolves.toBe("loaded");
    expect(reads).toBe(1);
  });

  it("assimilates thenables whose callable then shadows Function.call", async () => {
    const observability = createObservability({ service: "test-service" });
    const then = (resolve: (value: string) => void) => resolve("loaded");
    Object.defineProperty(then, "call", { value: null });
    const observed = instrumentMethods({
      target: { load: () => ({ then }) },
      observability,
      kind: "db",
      component: "test.db",
    });

    await expect(observed.load()).resolves.toBe("loaded");
  });

  it("defers custom thenable execution until after the instrumented call returns", async () => {
    const observability = createObservability({ service: "test-service" });
    let callReturned = false;
    let invokedAfterReturn = false;
    const observed = instrumentMethods({
      target: {
        load: () => ({
          then(resolve: (value: string) => void) {
            invokedAfterReturn = callReturned;
            resolve("loaded");
          },
        }),
      },
      observability,
      kind: "db",
      component: "test.db",
    });

    const result = observed.load();
    callReturned = true;

    await expect(result).resolves.toBe("loaded");
    expect(invokedAfterReturn).toBe(true);
  });

  it("shares active request state across child scopes", async () => {
    const observability = createObservability({
      service: "test-service",
    });
    const child = observability.child({ component: "child" });
    const request = observability.startRequest({
      requestId: "req_child",
      method: "POST",
      path: "/child",
    });

    await observability.runWithRequest(request, async () => {
      child.record({
        kind: "lookup",
        operation: "get",
        durationMs: 2,
        ok: true,
      });
    });

    const snapshot = request.finish({ status: 200 });
    const lookup = readObservationGroup(snapshot, "lookup");

    expect(lookup.count).toBe(1);
    expect(snapshot.metrics[0]?.component).toBe("child");
  });

  it("keeps overlapping async requests isolated by default in Node", async () => {
    const observability = createObservability({
      service: "test-service",
    });
    const firstRequest = observability.startRequest({
      requestId: "req_first",
    });
    const secondRequest = observability.startRequest({
      requestId: "req_second",
    });
    let enterSecondRequest!: () => void;
    let recordFirstMetric!: () => void;
    const secondRequestEntered = new Promise<void>((resolve) => {
      enterSecondRequest = resolve;
    });
    const firstMetricRecorded = new Promise<void>((resolve) => {
      recordFirstMetric = resolve;
    });

    await Promise.all([
      observability.runWithRequest(firstRequest, async () => {
        await secondRequestEntered;
        observability.record({
          kind: "db",
          operation: "first",
          durationMs: 1,
          ok: true,
        });
        recordFirstMetric();
      }),
      observability.runWithRequest(secondRequest, async () => {
        enterSecondRequest();
        await firstMetricRecorded;
        observability.record({
          kind: "cache",
          operation: "second",
          durationMs: 1,
          ok: true,
        });
      }),
    ]);

    const firstSnapshot = firstRequest.finish({ status: 200 });
    const secondSnapshot = secondRequest.finish({ status: 200 });

    expect(readObservationGroup(firstSnapshot, "db").count).toBe(1);
    expect(readObservationGroup(firstSnapshot, "cache").count).toBe(0);
    expect(readObservationGroup(secondSnapshot, "db").count).toBe(0);
    expect(readObservationGroup(secondSnapshot, "cache").count).toBe(1);
  });

  it("routes typed domain events through the events channel", async () => {
    type TestEvent = {
      domain: "test";
      type: "test.started";
      requestId?: string;
      metadata?: { value: number };
    };
    const events: TestEvent[] = [];
    const observability = createObservability<TestEvent>({
      service: "test-service",
      events: {
        emit: (event) => events.push(event),
      },
    });
    const request = observability.startRequest({
      requestId: "req_event",
    });

    await observability.runWithRequest(request, () =>
      request.event({
        domain: "test",
        type: "test.started",
        metadata: { value: 1 },
      })
    );

    expect(events).toEqual([
      {
        domain: "test",
        type: "test.started",
        requestId: "req_event",
        metadata: { value: 1 },
      },
    ]);
  });
  it("restores nested parent context after rejection across child scopes", async () => {
    const parent = createObservability();
    const child = parent.child({ component: "child" });
    const outer = parent.startRequest({ requestId: "outer" });
    const inner = child.startRequest({ requestId: "inner" });
    await parent.runWithRequest(outer, async () => {
      await expect(child.runWithRequest(inner, async () => {
        await Promise.resolve();
        expect(parent.getCurrentRequest()).toBe(inner);
        throw new Error("nested failure");
      })).rejects.toThrow("nested failure");
      expect(child.getCurrentRequest()).toBe(outer);
    });
    expect(parent.getCurrentRequest()).toBeUndefined();
  });

  it("isolates concurrent first use before the Node loader has initialized", async () => {
    vi.resetModules();
    const { createObservability: fresh } = await import("./index.js");
    const observer = fresh();
    const requests = ["one", "two"].map(requestId => observer.startRequest({ requestId }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await Promise.all(requests.map((request, index) => observer.runWithRequest(request, async () => {
      expect(observer.getCurrentRequest()).toBe(request);
      if (index === 1) release();
      await gate;
      expect(observer.getCurrentRequest()).toBe(request);
    })));
    expect(observer.getCurrentRequest()).toBeUndefined();
  });

  it("does not silently fall back when the Node loader fails", async () => {
    vi.resetModules();
    vi.doMock("node:async_hooks", () => { throw new Error("loader failed"); });
    try {
      const { createObservability: fresh } = await import("./index.js");
      const observer = fresh();
      const work = vi.fn();
      await expect(observer.runWithRequest(observer.startRequest({ requestId: "failed" }), work)).rejects.toThrow();
      expect(work).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:async_hooks");
      vi.resetModules();
    }
  });

  it("keeps browser fallback synchronous without leaking concurrent async frames", async () => {
    vi.stubGlobal("process", undefined);
    try {
      const observer = createObservability();
      const first = observer.startRequest({ requestId: "browser-first" });
      const second = observer.startRequest({ requestId: "browser-second" });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const a = observer.runWithRequest(first, async () => {
        expect(observer.getCurrentRequest()).toBe(first);
        await gate;
        expect(observer.getCurrentRequest()).toBeUndefined();
      });
      const b = observer.runWithRequest(second, async () => {
        expect(observer.getCurrentRequest()).toBe(second);
        release();
        await Promise.resolve();
        expect(observer.getCurrentRequest()).toBeUndefined();
      });
      await Promise.all([a, b]);
      expect(observer.getCurrentRequest()).toBeUndefined();
    } finally { vi.unstubAllGlobals(); }
  });

  it("uses an injected browser context without replacing it", async () => {
    const { createAsyncLocalRequestContext } = await import("./node.js");
    const context = createAsyncLocalRequestContext();
    const run = vi.spyOn(context, "run");
    vi.stubGlobal("process", undefined);
    try {
      const observer = createObservability({ requestContext: context });
      const request = observer.startRequest({ requestId: "injected" });
      await observer.runWithRequest(request, async () => {
        await Promise.resolve();
        expect(observer.child({}).getCurrentRequest()).toBe(request);
      });
      expect(run).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

});

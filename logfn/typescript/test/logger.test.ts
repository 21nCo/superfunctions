import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, Logger, registerProcessHandlers, type LogEvent, type Sink } from "../src/index.js";

function capture() {
  const events: LogEvent[] = [];
  const sink: Sink = (batch) => {
    events.push(...batch);
  };
  return { events, sink };
}

const fixedNow = () => new Date("2026-01-14T12:00:00.000Z");

describe("Logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits events at or above the level with the v0 shape", () => {
    const { events, sink } = capture();
    const logger = createLogger({ name: "svc", level: "warn", sinks: [sink], now: fixedNow });
    logger.trace("t");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    logger.fatal("f");
    expect(events.map((e) => e.level)).toEqual(["warn", "error", "fatal"]);
    expect(events[0]).toEqual({ ts: "2026-01-14T12:00:00.000Z", level: "warn", msg: "w", name: "svc", version: "0" });
  });

  it("rejects an unknown level and an explicitly empty sink list", () => {
    expect(() => createLogger({ name: "x", level: "verbose" as never })).toThrow(/Unknown log level/);
    // Inherited object keys are not levels (they would silently drop every event).
    for (const level of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(() => createLogger({ name: "x", level: level as never })).toThrow(/Unknown log level/);
      expect(() => createLogger({ name: "x" }).child({ level: level as never })).toThrow(/Unknown log level/);
    }
    expect(() => createLogger({ name: "x", sinks: [] })).toThrow(/At least one sink/);
  });

  it("merges base, child and call context and tags", () => {
    const { events, sink } = capture();
    const logger = createLogger({ name: "svc", sinks: [sink], baseContext: { env: "prod", a: 1 }, baseTags: ["base"] });
    const child = logger.child({ name: "child", level: "info", ctx: { module: "auth", a: 2 }, tags: ["child"] });
    child.debug("hidden");
    child.info("login", { a: 3, user: "u1" }, ["call"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "child",
      ctx: { env: "prod", module: "auth", a: 3, user: "u1" },
      tags: ["base", "child", "call"],
    });
  });

  it("omits the tags field when there are no tags, also for child loggers", () => {
    const { events, sink } = capture();
    const logger = createLogger({ name: "svc", sinks: [sink] });
    logger.info("root", undefined, []);
    logger.child({ ctx: { module: "auth" } }).info("child");
    expect(events).toHaveLength(2);
    for (const logged of events) expect(logged).not.toHaveProperty("tags");
  });

  it("keeps an Error or a non-object passed as ctx", () => {
    const { events, sink } = capture();
    const logger = createLogger({ name: "svc", sinks: [sink] });
    logger.error("failed", new Error("boom"));
    (logger.info as (msg: string, ctx: unknown) => void)("odd", "text");
    expect(events[0].ctx).toEqual({ error: expect.objectContaining({ name: "Error", message: "boom" }) });
    expect(events[1].ctx).toEqual({ value: "text" });
  });

  it("applies pipeline stages in order and drops events when a stage returns null", () => {
    const { events, sink } = capture();
    const logger = createLogger({
      name: "svc",
      sinks: [sink],
      pipeline: [
        (e) => ({ ...e, msg: `${e.msg}-1` }),
        (e) => (e.msg.startsWith("drop") ? null : e),
        (e) => ({ ...e, msg: `${e.msg}-2` }),
      ],
    });
    logger.info("keep");
    logger.info("drop");
    expect(events.map((e) => e.msg)).toEqual(["keep-1-2"]);
  });

  it("drops the event and reports when a stage throws, so a broken redactor cannot leak", () => {
    const { events, sink } = capture();
    const onError = vi.fn();
    const logger = createLogger({
      name: "svc",
      sinks: [sink],
      onError,
      pipeline: [
        function brokenRedactor() {
          throw new Error("stage failed");
        },
      ],
    });
    expect(() => logger.info("password=hunter2")).not.toThrow();
    expect(events).toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "stage failed" }), { stage: "brokenRedactor" });
  });

  it("isolates sync and async sink failures from the caller and from other sinks", async () => {
    const { events, sink } = capture();
    const onError = vi.fn();
    const throwing: Sink = function throwingSink() {
      throw new Error("sync sink");
    };
    const rejecting: Sink = async function rejectingSink() {
      throw new Error("async sink");
    };
    const logger = createLogger({ name: "svc", sinks: [throwing, rejecting, sink], onError });
    expect(() => logger.info("m")).not.toThrow();
    await Promise.resolve();
    expect(events).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "sync sink" }), { sink: "throwingSink" });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "async sink" }), { sink: "rejectingSink" });
  });

  it("does not throw when onError itself throws", () => {
    const logger = createLogger({
      name: "svc",
      sinks: [
        () => {
          throw new Error("sink");
        },
      ],
      onError: () => {
        throw new Error("handler");
      },
    });
    expect(() => logger.info("m")).not.toThrow();
  });

  it("flushes every sink and resolves even when one flush rejects", async () => {
    const onError = vi.fn();
    const good = Object.assign((() => {}) as Sink, { flush: vi.fn(async () => {}) });
    const bad = Object.assign((() => {}) as Sink, {
      flush: vi.fn(async () => {
        throw new Error("flush failed");
      }),
    });
    const logger = createLogger({ name: "svc", sinks: [bad, good], onError });
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(good.flush).toHaveBeenCalledTimes(1);
    expect(bad.flush).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "flush failed" }), expect.any(Object));
  });

  it("flush waits for pending async sink calls, also those made through a child", async () => {
    const delivered: string[] = [];
    const releases: Array<() => void> = [];
    const slow: Sink = async (batch) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      delivered.push(...batch.map((event) => event.msg));
    };
    const logger = createLogger({ name: "svc", sinks: [slow] });
    logger.info("root");
    logger.child({ name: "child" }).info("child");
    let settled = false;
    const flushed = logger.flush().then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    releases.forEach((release) => release());
    await flushed;
    expect(delivered).toEqual(["root", "child"]);
  });

  describe("caller sinks and stages with throwing getters", () => {
    function throwingName<T extends object>(target: T, message: string): T {
      Object.defineProperty(target, "name", {
        get() {
          throw new Error(message);
        },
      });
      return target;
    }

    async function settle(run: (onError: ReturnType<typeof vi.fn>, sibling: Sink & { flush: ReturnType<typeof vi.fn> }) => Promise<void> | void) {
      const unhandled: unknown[] = [];
      const listener = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", listener);
      try {
        const onError = vi.fn();
        const sibling = Object.assign((() => {}) as Sink, { flush: vi.fn(async () => {}) });
        await run(onError, sibling);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { onError, sibling, unhandled };
      } finally {
        process.off("unhandledRejection", listener);
      }
    }

    it("reports a throwing flush getter and still flushes sibling sinks", async () => {
      const broken = (() => {}) as Sink;
      Object.defineProperty(broken, "flush", {
        get() {
          throw new Error("flush getter");
        },
      });
      const { onError, sibling, unhandled } = await settle(async (onError, sibling) => {
        const logger = createLogger({ name: "svc", sinks: [broken, sibling], onError });
        logger.info("m");
        await expect(logger.flush()).resolves.toBeUndefined();
      });
      expect(onError.mock.calls.map(([error, context]) => [error.message, context])).toEqual([
        ["flush getter", { sink: "broken" }],
      ]);
      expect(sibling.flush).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    });

    it("calls flush with the sink as receiver", async () => {
      const sink = Object.assign((() => {}) as Sink, {
        flushed: false,
        async flush(this: { flushed: boolean }) {
          this.flushed = true;
        },
      });
      const onError = vi.fn();
      await createLogger({ name: "svc", sinks: [sink], onError }).flush();
      expect(onError).not.toHaveBeenCalled();
      expect(sink.flushed).toBe(true);
    });

    it.each([
      ["sync sink", "sink"],
      ["async sink", "sink"],
      ["flush", "sink"],
      ["stage", "stage"],
    ] as const)("reports the %s failure, not a throwing name getter", async (kind, key) => {
      const { onError, sibling, unhandled } = await settle(async (onError, sibling) => {
        const failure = new Error(`${kind} failed`);
        const sinks: Sink[] = [sibling];
        const pipeline = [];
        if (kind === "stage") {
          pipeline.push(
            throwingName(() => {
              throw failure;
            }, "name getter")
          );
        } else if (kind === "flush") {
          sinks.unshift(
            throwingName(
              Object.assign((() => {}) as Sink, {
                flush: async () => {
                  throw failure;
                },
              }),
              "name getter"
            )
          );
        } else {
          sinks.unshift(
            throwingName(
              kind === "sync sink"
                ? ((() => {
                    throw failure;
                  }) as Sink)
                : ((async () => {
                    throw failure;
                  }) as Sink),
              "name getter"
            )
          );
        }
        const logger = createLogger({ name: "svc", sinks, pipeline, onError });
        if (kind !== "flush") logger.info("m");
        await expect(logger.flush()).resolves.toBeUndefined();
      });
      expect(onError.mock.calls.map(([error, context]) => [error.message, context])).toEqual([
        [`${kind} failed`, { [key]: "unknown" }],
      ]);
      expect(sibling.flush).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    });
  });

  it("process handlers flush after the signal event, log nothing after that flush, exit 128 + signal and exit at once on a repeated signal", async () => {
    const handlers = new Map<string, () => Promise<void>>();
    vi.spyOn(process, "on").mockImplementation(((event: string, handler: () => Promise<void>) => {
      handlers.set(event, handler);
      return process;
    }) as typeof process.on);
    vi.spyOn(process, "off").mockImplementation((() => process) as typeof process.off);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
    const order: string[] = [];
    const sink = Object.assign(((batch: LogEvent[]) => {
      order.push(...batch.map((event) => `event:${event.msg}`));
    }) as Sink, {
      flush: async () => {
        order.push("flush");
      },
    });

    for (const [signal, code] of [
      ["SIGTERM", 143],
      ["SIGINT", 130],
    ] as const) {
      order.length = 0;
      exit.mockClear();
      const unregister = registerProcessHandlers(createLogger({ name: "svc", sinks: [sink] }));
      await handlers.get(signal)!();
      expect(order).toEqual([`event:Received ${signal}, flushing logs...`, "flush"]);
      expect(exit).toHaveBeenCalledExactlyOnceWith(code);
      unregister();
    }

    // A flush that never settles: a repeated signal exits at once, once.
    exit.mockClear();
    let settle!: () => void;
    const stuck = Object.assign((() => {}) as Sink, {
      flush: () => new Promise<void>((resolve) => (settle = resolve)),
    });
    const unregister = registerProcessHandlers(createLogger({ name: "svc", sinks: [stuck] }));
    const first = handlers.get("SIGTERM")!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(exit).not.toHaveBeenCalled();
    await handlers.get("SIGINT")!();
    expect(exit).toHaveBeenCalledExactlyOnceWith(130);
    settle();
    await first;
    expect(exit).toHaveBeenCalledOnce();
    unregister();
  });

  it("defaults to a local console sink", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new Logger({ name: "svc", level: "info" });
    logger.info("hello");
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain("hello");
  });

  it("sanitizes circular context before it reaches sinks", () => {
    const { events, sink } = capture();
    const logger = createLogger({ name: "svc", sinks: [sink] });
    const ctx: Record<string, unknown> = { id: 1 };
    ctx.self = ctx;
    logger.info("cyclic", ctx);
    // The logger merges ctx into a new top-level object, so the caller's
    // object appears once more before its back-reference is cut.
    expect(events[0].ctx).toEqual({ id: 1, self: { id: 1, self: "[circular]" } });
    expect(() => JSON.stringify(events[0])).not.toThrow();
  });
  it("does not re-enter onError for a failure it causes", () => {
    // An onError that logs through the failing sink fails again; that nested
    // failure goes to the console reporter, not back into onError.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    const logger = createLogger({
      name: "svc",
      sinks: [
        () => {
          throw new Error("sink down");
        },
      ],
      onError: (error) => {
        calls.push(error.message);
        logger.error("sink failed", { error: error.message });
      },
    });
    logger.info("one");
    logger.info("two");
    expect(calls).toEqual(["sink down", "sink down"]);
    expect(consoleError).toHaveBeenCalledTimes(2);
  });

  it.each(["logger", "child"] as const)(
    "does not re-enter onError for an async sink rejection it causes (via %s)",
    async (via) => {
      // The rejection of a sink call made while onError ran arrives after
      // the handler returned; it must still not call that handler again.
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      let sinkCalls = 0;
      const calls: string[] = [];
      const root = createLogger({
        name: "svc",
        sinks: [
          async () => {
            sinkCalls++;
            throw new Error("sink down");
          },
        ],
        onError: (error) => {
          calls.push(error.message);
          target.error("sink failed", { error: error.message });
        },
      });
      const target = via === "child" ? root.child({ name: "child" }) : root;
      const started = Date.now();
      const timer = new Promise<number>((resolve) => {
        setTimeout(() => resolve(Date.now() - started), 10);
      });
      target.info("one event");
      await target.flush();
      expect(await timer).toBeLessThan(50);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toEqual(["sink down"]);
      expect(sinkCalls).toBe(2);
      expect(consoleError).toHaveBeenCalledTimes(1);

      // A later independent failure is still reported to onError.
      target.info("two");
      await target.flush();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toEqual(["sink down", "sink down"]);
      expect(sinkCalls).toBe(4);
    }
  );

  it("stops a reporting cycle between two loggers whose handlers log through each other", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let sinkCalls = 0;
    const failing = async () => {
      sinkCalls++;
      throw new Error("down");
    };
    const calls: string[] = [];
    const a: Logger = createLogger({
      name: "a",
      sinks: [failing],
      onError: () => {
        calls.push("a");
        b.error("a failed");
      },
    });
    const b: Logger = createLogger({
      name: "b",
      sinks: [failing],
      onError: () => {
        calls.push("b");
        a.error("b failed");
      },
    });
    a.info("one event");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toEqual(["a", "b"]);
    expect(sinkCalls).toBe(3);
  });
});

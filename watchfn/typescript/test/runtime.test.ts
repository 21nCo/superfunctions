import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage, createWatch, WatchError, type Collector, type CollectorContext } from "../src/index.js";
import { processMetricsCollector } from "../src/collectors.js";
import { deferred, instrument } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function recordingCollector(name: string, log: string[], options: { failStart?: boolean } = {}): Collector & { context?: CollectorContext } {
  const collector: Collector & { context?: CollectorContext } = {
    name,
    start(context) {
      log.push(`start:${name}`);
      if (options.failStart) throw new Error(`${name} refused`);
      collector.context = context;
    },
    stop() {
      log.push(`stop:${name}`);
    },
  };
  return collector;
}

describe("[memory-fixture] lifecycle", () => {
  it("opens storage once for repeated and concurrent start() calls and closes it once for repeated stop() calls", async () => {
    const { storage, calls } = instrument(createMemoryStorage());
    const watch = createWatch({ storage });
    await Promise.all([watch.start(), watch.start()]);
    await watch.start();
    expect(watch.state).toBe("started");
    expect(calls.open).toBe(1);

    await Promise.all([watch.stop(), watch.stop()]);
    await watch.stop();
    expect(watch.state).toBe("stopped");
    expect(calls.close).toBe(1);
  });

  it("does nothing on stop() before start() and can start again after a stop", async () => {
    const { storage, calls } = instrument(createMemoryStorage());
    const watch = createWatch({ storage });
    await watch.stop();
    expect(calls).toMatchObject({ open: 0, close: 0 });
    await watch.start();
    await watch.ingest({ type: "first" });
    await watch.stop();
    await watch.start();
    expect((await watch.query()).events.map((event) => event.type)).toEqual(["first"]);
    await watch.stop();
    expect(calls).toMatchObject({ open: 2, close: 2 });
  });

  it("refuses ingestion and queries while stopped without touching storage", async () => {
    const { storage, calls } = instrument(createMemoryStorage());
    const watch = createWatch({ storage });
    expect(await watch.ingest({ type: "early" })).toEqual({ ok: false, error: { code: "not_started", message: "the runtime is not started" } });
    expect((await watch.ingestBatch([{ type: "early" }])).ok).toBe(false);
    await expect(watch.query()).rejects.toMatchObject({ name: "WatchError", code: "not_started" });
    expect(calls).toMatchObject({ write: 0, query: 0 });
  });

  it("starts no collector, timer or process handler unless one is configured", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const events = ["uncaughtException", "unhandledRejection", "beforeExit", "exit", "SIGTERM", "SIGINT"] as const;
    const before = events.map((name) => process.listenerCount(name));
    const watch = createWatch({ storage: createMemoryStorage() });
    await watch.start();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(events.map((name) => process.listenerCount(name))).toEqual(before);
    expect((await watch.query()).events).toEqual([]);
    await watch.stop();
  });

  it("starts registered collectors in order, stops them in reverse and lets them ingest only while running", async () => {
    const log: string[] = [];
    const first = recordingCollector("first", log);
    const second = recordingCollector("second", log);
    const watch = createWatch({ storage: createMemoryStorage(), collectors: [first] });
    watch.registerCollector(second);
    expect(() => watch.registerCollector(recordingCollector("second", log))).toThrow(/already registered/);
    await watch.start();
    expect(() => watch.registerCollector(recordingCollector("late", log))).toThrow(WatchError);
    expect((await first.context!.ingest({ type: "collected" })).ok).toBe(true);
    await watch.stop();
    expect(log).toEqual(["start:first", "start:second", "stop:second", "stop:first"]);
    expect((await first.context!.ingest({ type: "after-stop" })).ok).toBe(false);
  });

  it("rolls back a failed start: stops started collectors, closes storage and stays stopped", async () => {
    const log: string[] = [];
    const { storage, calls } = instrument(createMemoryStorage());
    const watch = createWatch({
      storage,
      collectors: [recordingCollector("ok", log), recordingCollector("broken", log, { failStart: true }), recordingCollector("never", log)],
    });
    await expect(watch.start()).rejects.toMatchObject({ code: "start_failed", message: expect.stringContaining("broken") });
    expect(log).toEqual(["start:ok", "start:broken", "stop:ok", "stop:broken"]);
    expect(calls).toMatchObject({ open: 1, close: 1 });
    expect(watch.state).toBe("stopped");
    expect((await watch.ingest({ type: "x" })).ok).toBe(false);
  });

  it("rolls back a failed start on an adapter whose close() is synchronous", async () => {
    const close = vi.fn();
    const storage = { ...createMemoryStorage(), close } as unknown as ReturnType<typeof createMemoryStorage>;
    const watch = createWatch({ storage, collectors: [recordingCollector("broken", [], { failStart: true })] });
    await expect(watch.start()).rejects.toMatchObject({ code: "start_failed" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(watch.state).toBe("stopped");
  });

  it("fails start when storage cannot open and leaves no collector running", async () => {
    const log: string[] = [];
    const storage = { ...createMemoryStorage(), open: async () => Promise.reject(new Error("disk missing")) };
    const watch = createWatch({ storage, collectors: [recordingCollector("c", log)] });
    await expect(watch.start()).rejects.toMatchObject({ code: "start_failed", message: expect.stringContaining("disk missing") });
    expect(log).toEqual([]);
    expect(watch.state).toBe("stopped");
  });

  it("waits for in-flight writes before closing storage and rejects ingestion once stopping", async () => {
    const { storage, calls, control } = instrument(createMemoryStorage());
    const gate = deferred();
    control.gate = gate.promise;
    const watch = createWatch({ storage });
    await watch.start();
    const pending = watch.ingest({ type: "slow" });
    const stopping = watch.stop();
    await vi.waitFor(() => expect(watch.state).toBe("stopping"));
    expect(await watch.ingest({ type: "late" })).toMatchObject({ ok: false, error: { code: "not_started", message: "the runtime is stopping" } });
    await Promise.resolve();
    expect(calls.close).toBe(0);
    gate.resolve();
    expect((await pending).ok).toBe(true);
    await stopping;
    expect(calls.close).toBe(1);
    expect(control.written.flat().map((event) => event.type)).toEqual(["slow"]);
  });

  it("stop() leaves resources the runtime did not create alone", async () => {
    const own = () => undefined;
    process.on("beforeExit", own);
    const timer = setInterval(() => undefined, 60_000);
    const storage = createMemoryStorage();
    const listener = vi.fn();
    const watch = createWatch({ storage });
    watch.subscribe(listener);
    await watch.start();
    await watch.ingest({ type: "kept" });
    await watch.stop();
    expect(process.listeners("beforeExit")).toContain(own);
    expect(timer.hasRef()).toBe(true);
    expect(storage.size()).toBe(1);
    await watch.start();
    await watch.ingest({ type: "again" });
    expect(listener).toHaveBeenCalledTimes(2);
    await watch.stop();
    clearInterval(timer);
    process.off("beforeExit", own);
  });
});

describe("[memory-fixture] ingestion receipts", () => {
  it("resolves the receipt only after storage confirmed the write", async () => {
    const { storage, control } = instrument(createMemoryStorage());
    const gate = deferred();
    control.gate = gate.promise;
    const watch = createWatch({ storage });
    await watch.start();
    let settled = false;
    const receipt = watch.ingest({ type: "gated" }).then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    gate.resolve();
    expect(await receipt).toMatchObject({ ok: true, event: { type: "gated" } });
    await watch.stop();
  });

  it("turns an injected storage failure into a failed receipt, never a success, and notifies no listener", async () => {
    const { storage, control } = instrument(createMemoryStorage());
    control.failWrites = new Error("disk full");
    const listener = vi.fn();
    const watch = createWatch({ storage });
    watch.subscribe(listener);
    await watch.start();
    expect(await watch.ingest({ type: "lost" })).toEqual({
      ok: false,
      error: { code: "storage_failed", message: "storage memory rejected the write: disk full" },
    });
    expect(await watch.ingestBatch([{ type: "lost" }, { type: "lost" }])).toMatchObject({ ok: false, error: { code: "storage_failed" } });
    expect(listener).not.toHaveBeenCalled();
    control.failWrites = undefined;
    expect((await watch.query()).events).toEqual([]);
    await watch.stop();
  });

  it("turns a failing query into a WatchError with code storage_failed", async () => {
    const storage = { ...createMemoryStorage(), query: async () => Promise.reject(new Error("read failed")) };
    const watch = createWatch({ storage });
    await watch.start();
    await expect(watch.query()).rejects.toMatchObject({ code: "storage_failed", message: expect.stringContaining("read failed") });
    await watch.stop();
  });

  it.each([
    ["a non-object", "sdk.failure", "event: must be a plain object"],
    ["an array", [{ type: "x" }], "event: must be a plain object"],
    ["a missing type", {}, "event.type: must be a non-empty string"],
    ["a type with spaces", { type: "bad type" }, "event.type: may contain only letters, digits and _ . : / -"],
    ["an unknown field", { type: "x", attribute: {} }, "event.attribute: unknown field"],
    ["an impossible date", { type: "x", timestamp: "2026-02-30T00:00:00Z" }, "event.timestamp: date-time out of range"],
    ["a date without a zone", { type: "x", timestamp: "2026-02-01T00:00:00" }, "event.timestamp: must be an ISO 8601 date-time with a time zone"],
    ["fractional epoch milliseconds", { type: "x", timestamp: 1.5 }, "event.timestamp: must be integer epoch milliseconds"],
    ["a nested attribute", { type: "x", attributes: { a: { b: 1 } } }, "event.attributes.a: must be a string, finite number or boolean"],
    ["a NaN attribute", { type: "x", attributes: { a: Number.NaN } }, "event.attributes.a: must be a finite number"],
    ["a reserved attribute name", { type: "x", attributes: JSON.parse('{"__proto__": "x"}') }, "event.attributes.__proto__: invalid attribute name"],
    ["a function in data", { type: "x", data: { f: () => 1 } }, "event.data.f: must be JSON (null, boolean, finite number, string, array or plain object)"],
    ["Infinity in data", { type: "x", data: [Infinity] }, "event.data[0]: must be a finite number"],
  ])("rejects %s without writing", async (_label, input, issue) => {
    const { storage, calls } = instrument(createMemoryStorage());
    const watch = createWatch({ storage });
    await watch.start();
    const receipt = await watch.ingest(input);
    expect(receipt).toMatchObject({ ok: false, error: { code: "invalid_event" } });
    if (!receipt.ok) expect(receipt.error.issues).toContain(issue);
    expect(calls.write).toBe(0);
    await watch.stop();
  });

  it("rejects circular, deep and oversized data", async () => {
    const watch = createWatch({ storage: createMemoryStorage() });
    await watch.start();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    let deep: unknown = 1;
    for (let level = 0; level < 40; level += 1) deep = [deep];
    for (const data of [circular, deep, "x".repeat(70 * 1024)]) {
      expect(await watch.ingest({ type: "x", data })).toMatchObject({ ok: false, error: { code: "invalid_event" } });
    }
    await watch.stop();
  });

  it("validates a whole batch before writing any of it", async () => {
    const { storage, calls } = instrument(createMemoryStorage());
    const watch = createWatch({ storage });
    await watch.start();
    const receipt = await watch.ingestBatch([{ type: "good" }, { type: "" }]);
    expect(receipt).toMatchObject({ ok: false, error: { code: "invalid_event", issues: ["events[1].type: must be a non-empty string"] } });
    expect(await watch.ingestBatch([])).toMatchObject({ ok: false, error: { code: "invalid_event" } });
    expect(await watch.ingestBatch(Array.from({ length: 101 }, () => ({ type: "x" })))).toMatchObject({ ok: false });
    expect(calls.write).toBe(0);
    await watch.stop();
  });

  it("rejects invalid queries with their issues", async () => {
    const watch = createWatch({ storage: createMemoryStorage() });
    await watch.start();
    const invalid = [
      [{ from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" }, "query.from: must not be after query.to"],
      [{ limit: 0 }, "query.limit: must be an integer from 1 to 1000"],
      [{ limit: 1001 }, "query.limit: must be an integer from 1 to 1000"],
      [{ order: "newest" }, 'query.order: must be "asc" or "desc"'],
      [{ type: [] }, "query.type: must list 1 to 20 types"],
      [{ attributes: { a: [1] } }, "query.attributes.a: must be a string, finite number or boolean"],
      [{ where: {} }, "query.where: unknown field"],
    ] as const;
    for (const [query, issue] of invalid) {
      await expect(watch.query(query as never)).rejects.toMatchObject({ code: "invalid_query", issues: expect.arrayContaining([issue]) });
    }
    await watch.stop();
  });
});

describe("[memory-fixture] listeners", () => {
  it("delivers stored events, isolates a throwing listener and stops after unsubscribe", async () => {
    const onError = vi.fn();
    const seen: string[] = [];
    const watch = createWatch({ storage: createMemoryStorage(), onError });
    watch.subscribe(() => {
      throw new Error("listener bug");
    });
    const unsubscribe = watch.subscribe((event) => seen.push(event.type));
    await watch.start();
    expect((await watch.ingest({ type: "one" })).ok).toBe(true);
    unsubscribe();
    await watch.ingest({ type: "two" });
    expect(seen).toEqual(["one"]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "listener bug" }), { source: "listener" });
    await watch.stop();
  });
});

describe("[memory-fixture] process metrics collector (opt-in)", () => {
  it("samples on start and on its interval, then stops its timer", async () => {
    vi.useFakeTimers();
    const storage = createMemoryStorage();
    const watch = createWatch({ storage, collectors: [processMetricsCollector({ intervalMs: 1000 })] });
    await watch.start();
    await vi.advanceTimersByTimeAsync(2500);
    const sampled = await watch.query({ type: "infra.process" });
    expect(sampled.events).toHaveLength(3);
    expect(sampled.events[0]!.attributes.pid).toBe(process.pid);
    await watch.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => processMetricsCollector({ intervalMs: 10 })).toThrow(RangeError);
  });
});

describe("configuration", () => {
  it("requires an explicit storage adapter", () => {
    expect(() => createWatch({} as never)).toThrow(/config.storage/);
    expect(() => createWatch(undefined as never)).toThrow(/config is required/);
    expect(() => createWatch({ storage: createMemoryStorage(), now: 5 } as never)).toThrow(/config.now must be a function/);
  });
});

describe("[memory-fixture] concurrent start() shares one outcome", () => {
  it("gives every joiner of a pending start the same failure with one open, then lets a later start retry", async () => {
    const memory = createMemoryStorage();
    let opens = 0;
    const storage = {
      ...memory,
      kind: memory.kind,
      durable: memory.durable,
      write: memory.write,
      query: memory.query,
      async open() {
        opens += 1;
        if (opens === 1) throw new Error("disk busy");
      },
    };
    const watch = createWatch({ storage });
    const results = await Promise.allSettled([watch.start(), watch.start(), watch.start()]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(new Set(results.map((result) => (result as PromiseRejectedResult).reason)).size).toBe(1);
    expect(opens).toBe(1);
    expect(watch.state).toBe("stopped");

    await watch.start();
    expect(opens).toBe(2);
    expect(watch.state).toBe("started");
    await watch.stop();
  });

  it("does not let a start() requested after a stop() join the earlier start", async () => {
    const { storage, calls } = instrument(createMemoryStorage());
    const watch = createWatch({ storage });
    await Promise.all([watch.start(), watch.stop(), watch.start()]);
    expect(watch.state).toBe("started");
    expect(calls).toMatchObject({ open: 2, close: 1 });
    await watch.stop();
  });
});

describe("[memory-fixture] ingestion never throws", () => {
  async function started(config: Partial<Parameters<typeof createWatch>[0]> = {}) {
    const { storage, calls } = instrument(createMemoryStorage());
    const watch = createWatch({ storage, ...config });
    await watch.start();
    return { watch, calls };
  }

  it("validates data even when an earlier field is invalid (BigInt, cycles)", async () => {
    const { watch, calls } = await started();
    const bigint = await watch.ingest({ type: "", data: { x: 1n } });
    expect(bigint).toMatchObject({ ok: false, error: { code: "invalid_event" } });
    expect(!bigint.ok && bigint.error.issues).toEqual(["event.type: must be a non-empty string", expect.stringContaining("event.data.x: must be JSON")]);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cycle = await watch.ingest({ type: "ok", nope: true, data: cyclic });
    expect(cycle).toMatchObject({ ok: false, error: { code: "invalid_event" } });
    expect(!cycle.ok && cycle.error.issues).toEqual(["event.nope: unknown field", expect.stringContaining("nested deeper than")]);

    const batch = await watch.ingestBatch([{ type: "" , data: { x: 1n } }, { type: "fine" }]);
    expect(batch).toMatchObject({ ok: false, error: { code: "invalid_event" } });
    expect(calls.write).toBe(0);
    await watch.stop();
  });

  it("turns throwing getters into ingest_failed receipts for single events and batches", async () => {
    const { watch, calls } = await started();
    const trap = { type: "t", get data(): unknown { throw new Error("getter exploded"); } };
    expect(await watch.ingest(trap)).toMatchObject({ ok: false, error: { code: "ingest_failed", message: expect.stringContaining("getter exploded") } });
    expect(await watch.ingestBatch([{ type: "ok" }, trap])).toMatchObject({ ok: false, error: { code: "ingest_failed" } });
    const hostileArray = new Proxy([{ type: "ok" }], { get(target, key) { if (key === "0") throw new Error("index trap"); return Reflect.get(target, key); } });
    expect(await watch.ingestBatch(hostileArray)).toMatchObject({ ok: false, error: { code: "ingest_failed" } });
    expect(calls.write).toBe(0);
    await watch.stop();
  });

  it("stores the data it validated, even if a getter would return something else on a second read", async () => {
    const { watch } = await started();
    let reads = 0;
    const data = { get value(): unknown { reads += 1; return reads === 1 ? "checked" : { bad: 1n }; } };
    const receipt = await watch.ingest({ type: "t", data });
    expect(receipt).toMatchObject({ ok: true, event: { data: { value: "checked" } } });
    expect(reads).toBe(1);
    await watch.stop();
  });

  it("turns failing now() and generateId() hooks into ingest_failed receipts and writes nothing", async () => {
    for (const config of [
      { now: () => { throw new Error("clock down"); } },
      { now: () => Number.NaN },
      { generateId: (): string => { throw new Error("no entropy"); } },
      { generateId: () => "" },
    ]) {
      const { watch, calls } = await started(config);
      expect(await watch.ingest({ type: "t" })).toMatchObject({ ok: false, error: { code: "ingest_failed" } });
      expect(await watch.ingestBatch([{ type: "t" }])).toMatchObject({ ok: false, error: { code: "ingest_failed" } });
      expect(calls.write).toBe(0);
      await watch.stop();
    }
  });
});

describe("[memory-fixture] sparse arrays", () => {
  it("rejects holes in a batch and writes nothing", async () => {
    const { storage, calls } = instrument(createMemoryStorage());
    const watch = createWatch({ storage });
    await watch.start();
    for (const batch of [new Array(1), [, { type: "v" }], [{ type: "v" }, ,]]) {
      const receipt = await watch.ingestBatch(batch);
      expect(receipt).toMatchObject({ ok: false, error: { code: "invalid_event", issues: [expect.stringMatching(/^events\[\d\]: must be a plain object$/)] } });
    }
    expect(calls.write).toBe(0);
    await watch.stop();
  });

  it("rejects holes in a query's type list", async () => {
    const watch = createWatch({ storage: createMemoryStorage() });
    await watch.start();
    await expect(watch.query({ type: new Array(1) })).rejects.toMatchObject({ code: "invalid_query", issues: ["query.type[0]: must be a non-empty string"] });
    await expect(watch.query({ type: ["a", , "b"] as string[] })).rejects.toMatchObject({ code: "invalid_query" });
    await watch.stop();
  });
});

describe("[memory-fixture] memory storage capacity", () => {
  it("refuses a batch larger than maxEvents instead of acknowledging events it would evict", async () => {
    const memory = createMemoryStorage({ maxEvents: 2 });
    const watch = createWatch({ storage: memory });
    await watch.start();
    expect(await watch.ingestBatch([{ type: "a" }, { type: "b" }, { type: "c" }])).toMatchObject({ ok: false, error: { code: "storage_failed" } });
    expect(memory.size()).toBe(0);
    expect(await watch.ingestBatch([{ type: "a" }, { type: "b" }])).toMatchObject({ ok: true });
    await watch.stop();
  });
});

describe("process metrics collector interval bounds", () => {
  it("accepts the largest timer delay and rejects anything above it", () => {
    expect(() => processMetricsCollector({ intervalMs: 2_147_483_647 })).not.toThrow();
    expect(() => processMetricsCollector({ intervalMs: 2_147_483_648 })).toThrow(RangeError);
    expect(() => processMetricsCollector({ intervalMs: 999 })).toThrow(RangeError);
  });
});

/** Values a getter, hook or adapter may throw that cannot be safely stringified or whose fields throw when read. */
function hostileThrownValues(): Array<[string, unknown]> {
  const throwingMessage = new Error("unused");
  Object.defineProperty(throwingMessage, "message", { get() { throw new Error("message getter"); } });
  const throwingCause = new Error("outer");
  Object.defineProperty(throwingCause, "cause", { get() { throw new Error("cause getter"); } });
  const throwingName = new Error("named");
  Object.defineProperty(throwingName, "name", { get() { throw new Error("name getter"); } });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  return [
    ["a null-prototype object", Object.create(null)],
    ["an object whose toString throws", { toString() { throw new Error("toString"); } }],
    ["an object whose Symbol.toPrimitive throws", { [Symbol.toPrimitive]() { throw new Error("toPrimitive"); } }],
    ["an Error whose message getter throws", throwingMessage],
    ["an Error whose cause getter throws", throwingCause],
    ["an Error whose name getter throws", throwingName],
    ["a revoked proxy", revoked.proxy],
    ["undefined", undefined],
    ["a symbol", Symbol("thrown")],
  ];
}

describe("[memory-fixture] hostile thrown values never escape as non-receipts", () => {
  it.each(hostileThrownValues())("ingest and ingestBatch return failed receipts when %s is thrown", async (_label, thrown) => {
    const sites: Array<{ code: string; config: (storage: ReturnType<typeof instrument>) => Partial<Parameters<typeof createWatch>[0]>; event: () => unknown }> = [
      { code: "ingest_failed", config: () => ({}), event: () => ({ type: "t", get data(): unknown { throw thrown; } }) },
      { code: "ingest_failed", config: () => ({ now: () => { throw thrown; } }), event: () => ({ type: "t" }) },
      { code: "ingest_failed", config: () => ({ generateId: (): string => { throw thrown; } }), event: () => ({ type: "t" }) },
      { code: "storage_failed", config: (instrumented) => { instrumented.control.throwOnWrite = { thrown }; return {}; }, event: () => ({ type: "t" }) },
    ];
    for (const site of sites) {
      const instrumented = instrument(createMemoryStorage());
      const watch = createWatch({ storage: instrumented.storage, ...site.config(instrumented) });
      await watch.start();
      const single = await watch.ingest(site.event());
      expect(single).toMatchObject({ ok: false, error: { code: site.code, message: expect.any(String) } });
      const batch = await watch.ingestBatch([{ type: "ok" }, site.event()]);
      expect(batch).toMatchObject({ ok: false, error: { code: site.code, message: expect.any(String) } });
      expect(instrumented.control.written).toEqual([]);
      await watch.stop();
    }
  });

  it.each(hostileThrownValues())("query, start and a collector start reject only with WatchError when %s is thrown", async (_label, thrown) => {
    const failingQuery = instrument(createMemoryStorage());
    failingQuery.storage.query = async () => { throw thrown; };
    const queried = createWatch({ storage: failingQuery.storage });
    await queried.start();
    const queryError = await queried.query({}).catch((error: unknown) => error);
    expect(queryError).toBeInstanceOf(WatchError);
    expect(queryError).toMatchObject({ code: "storage_failed" });
    const unreadableQuery = { get limit(): number { throw thrown; } };
    await expect(queried.query(unreadableQuery)).rejects.toMatchObject({ name: "WatchError", code: "invalid_query" });
    await queried.stop();

    const failingOpen = instrument(createMemoryStorage());
    failingOpen.storage.open = async () => { throw thrown; };
    const opened = createWatch({ storage: failingOpen.storage });
    const openError = await opened.start().catch((error: unknown) => error);
    expect(openError).toBeInstanceOf(WatchError);
    expect(openError).toMatchObject({ code: "start_failed" });
    expect(opened.state).toBe("stopped");

    const collector: Collector = { name: "hostile", start() { throw thrown; }, stop() {} };
    const collected = createWatch({ storage: createMemoryStorage(), collectors: [collector], onError: () => undefined });
    const collectorError = await collected.start().catch((error: unknown) => error);
    expect(collectorError).toBeInstanceOf(WatchError);
    expect(collectorError).toMatchObject({ code: "start_failed", message: expect.stringContaining("hostile") });
    expect(collected.state).toBe("stopped");
  });

  it("caps the error description copied into a receipt", async () => {
    const instrumented = instrument(createMemoryStorage());
    instrumented.control.failWrites = new Error("x".repeat(10_000));
    const watch = createWatch({ storage: instrumented.storage });
    await watch.start();
    const receipt = await watch.ingest({ type: "t" });
    expect(!receipt.ok && receipt.error.message.length).toBeLessThan(700);
    await watch.stop();
  });
});

describe("[memory-fixture] async callbacks", () => {
  async function collectUnhandled(run: () => Promise<void>): Promise<unknown[]> {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await run();
      // Let rejected thenables settle and Node's unhandled-rejection check run.
      for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    return unhandled;
  }

  it("reports an async listener's rejection to onError without an unhandled rejection or a changed receipt", async () => {
    const reported: Array<[unknown, unknown]> = [];
    const watch = createWatch({ storage: createMemoryStorage(), onError: (error, context) => void reported.push([error, context]) });
    await watch.start();
    const failure = new Error("async listener failed");
    watch.subscribe(async () => {
      throw failure;
    });
    watch.subscribe((() => ({ then() { throw new Error("hostile then"); } })) as () => void);
    let receipt: Awaited<ReturnType<typeof watch.ingest>> | undefined;
    const unhandled = await collectUnhandled(async () => {
      receipt = await watch.ingest({ type: "t" });
    });
    expect(receipt).toMatchObject({ ok: true });
    expect(unhandled).toEqual([]);
    expect(reported).toHaveLength(2);
    expect(reported).toEqual(expect.arrayContaining([
      [failure, { source: "listener" }],
      [expect.objectContaining({ message: "hostile then" }), { source: "listener" }],
    ]));
    await watch.stop();
  });

  it("swallows an async onError rejection without an unhandled rejection", async () => {
    let onErrorCalls = 0;
    const watch = createWatch({
      storage: createMemoryStorage(),
      onError: async () => {
        onErrorCalls += 1;
        throw new Error("onError failed");
      },
    });
    await watch.start();
    watch.subscribe(() => {
      throw new Error("sync listener failed");
    });
    watch.subscribe(async () => {
      throw new Error("async listener failed");
    });
    let receipt: Awaited<ReturnType<typeof watch.ingest>> | undefined;
    const unhandled = await collectUnhandled(async () => {
      receipt = await watch.ingest({ type: "t" });
    });
    expect(receipt).toMatchObject({ ok: true });
    expect(onErrorCalls).toBe(2);
    expect(unhandled).toEqual([]);
    await watch.stop();
  });
});

describe("[memory-fixture] storage calls that do not return a native promise", () => {
  /** Resolves true once `promise` settles within `ticks` microtask turns, without relying on timers. */
  async function settlesWithin(promise: Promise<unknown>, ticks = 1000): Promise<boolean> {
    let settled = false;
    promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (let tick = 0; tick < ticks && !settled; tick += 1) await Promise.resolve();
    return settled;
  }

  const stored = { id: "e1", type: "t", timestamp: new Date(0).toISOString(), receivedAt: new Date(0).toISOString(), attributes: {} };
  const queryResults: Array<[string, () => unknown, { events: unknown[] } | "storage_failed"]> = [
    ["a synchronous array", () => [stored], { events: [stored] }],
    ["undefined", () => undefined, "storage_failed"],
    ["a plain thenable", () => ({ then: (resolve: (value: unknown) => void) => resolve([stored]) }), { events: [stored] }],
    ["a thenable that rejects", () => ({ then: (_: unknown, reject: (error: unknown) => void) => reject(new Error("no")) }), "storage_failed"],
    ["a thenable whose then getter throws", () => ({ get then(): never { throw new Error("getter"); } }), "storage_failed"],
    ["a thenable whose then() throws", () => ({ then(): never { throw new Error("then"); } }), "storage_failed"],
    ["a synchronous throw", () => { throw new Error("sync"); }, "storage_failed"],
  ];

  it.each(queryResults)("query handles %s and a later stop() resolves", async (_label, result, expected) => {
    const memory = createMemoryStorage();
    const storage = { ...memory, query: result as unknown as typeof memory.query };
    const watch = createWatch({ storage });
    await watch.start();
    if (expected === "storage_failed") {
      await expect(watch.query({})).rejects.toMatchObject({ name: "WatchError", code: "storage_failed" });
    } else {
      expect(await watch.query({})).toEqual({ ...expected, truncated: false });
    }
    expect(await settlesWithin(watch.stop())).toBe(true);
    expect(watch.state).toBe("stopped");
  });

  it.each([
    ["undefined synchronously", () => undefined, true],
    ["a plain thenable", () => ({ then: (resolve: (value: unknown) => void) => resolve(undefined) }), true],
    ["a thenable that rejects", () => ({ then: (_: unknown, reject: (error: unknown) => void) => reject(new Error("no")) }), false],
    ["a synchronous throw", () => { throw new Error("sync"); }, false],
  ] as Array<[string, () => unknown, boolean]>)("ingest handles a write returning %s and a later stop() resolves", async (_label, result, ok) => {
    const memory = createMemoryStorage();
    const storage = { ...memory, write: result as unknown as typeof memory.write };
    const watch = createWatch({ storage });
    await watch.start();
    expect(await watch.ingest({ type: "t" })).toMatchObject(ok ? { ok: true } : { ok: false, error: { code: "storage_failed" } });
    expect(await watch.ingestBatch([{ type: "t" }])).toMatchObject(ok ? { ok: true } : { ok: false, error: { code: "storage_failed" } });
    expect(await settlesWithin(watch.stop())).toBe(true);
    expect(watch.state).toBe("stopped");
  });
});

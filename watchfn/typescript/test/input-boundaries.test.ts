import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  LIMITS,
  WatchError,
  createMemoryStorage,
  createWatch,
  type Collector,
  type CollectorContext,
  type IngestReceipt,
  type WatchErrorCode,
} from "../src/index.js";
import { processMetricsCollector } from "../src/collectors.js";
import { instrument } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

/** A graph of `levels` nodes where each node references the next one twice, counting every property read. */
function aliasGraph(levels: number): { root: unknown; reads: () => number } {
  let reads = 0;
  let node: unknown = 1;
  for (let level = 0; level < levels; level += 1) {
    const child = node;
    const next = {};
    for (const key of ["a", "b"]) {
      Object.defineProperty(next, key, {
        enumerable: true,
        get() {
          reads += 1;
          return child;
        },
      });
    }
    node = next;
  }
  return { root: node, reads: () => reads };
}

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("[memory-fixture] data size is enforced while copying", () => {
  it("rejects an alias-heavy graph without expanding it, for single events and batches, and writes nothing", async () => {
    const { storage, calls } = instrument(createMemoryStorage());
    const watch = createWatch({ storage });
    await watch.start();
    // 2^20 leaves when expanded; within the depth limit, so only the size budget can stop it early.
    const single = aliasGraph(20);
    const started = performance.now();
    expect(await watch.ingest({ type: "alias", data: single.root })).toMatchObject({
      ok: false,
      error: { code: "invalid_event", issues: [`event.data: larger than ${LIMITS.maxDataBytes} bytes as JSON`] },
    });
    expect(single.reads()).toBeLessThan(LIMITS.maxDataBytes);
    const batch = aliasGraph(20);
    expect(await watch.ingestBatch([{ type: "ok" }, { type: "alias", data: batch.root }])).toMatchObject({
      ok: false,
      error: { code: "invalid_event", issues: [`events[1].data: larger than ${LIMITS.maxDataBytes} bytes as JSON`] },
    });
    expect(batch.reads()).toBeLessThan(LIMITS.maxDataBytes);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(calls.write).toBe(0);
    await watch.stop();
  });

  it("counts exactly the bytes JSON.stringify writes: a payload at the limit passes and one byte more fails", async () => {
    const watch = createWatch({ storage: createMemoryStorage() });
    await watch.start();
    const shapes: Array<Record<string, unknown>> = [
      { text: 'quote " backslash \\ newline \n tab \t' },
      { emoji: "😀", accents: "é漢", lone: "\uD800", control: "\u0001\u001f" },
      { 'key "quoted"': [1, -0, 1e21, 5e-324, 0.1 + 0.2, true, false, null, [], {}] },
      { __proto__key: { nested: { deeper: ["x", { y: "z" }] } } },
    ];
    for (const shape of shapes) {
      const base = jsonBytes({ ...shape, pad: "" });
      const fits = { ...shape, pad: "a".repeat(LIMITS.maxDataBytes - base) };
      expect(jsonBytes(fits)).toBe(LIMITS.maxDataBytes);
      expect(await watch.ingest({ type: "fit", data: fits })).toMatchObject({ ok: true });
      const over = { ...shape, pad: "a".repeat(LIMITS.maxDataBytes - base + 1) };
      expect(await watch.ingest({ type: "over", data: over })).toMatchObject({ ok: false, error: { code: "invalid_event" } });
    }
    await watch.stop();
  });
});

describe("[memory-fixture] only own fields of events and queries are read", () => {
  /** Runs `act` while Object.prototype and Array.prototype[0] carry the given fields, then restores them. */
  function withPollution<T>(fields: Record<string, unknown>, act: () => T): T {
    const objectKeys = Object.keys(fields);
    try {
      for (const key of objectKeys) Object.defineProperty(Object.prototype, key, { value: fields[key], configurable: true, writable: true });
      Object.defineProperty(Array.prototype, 0, { value: { type: "inherited" }, configurable: true, writable: true });
      return act();
    } finally {
      for (const key of objectKeys) delete (Object.prototype as Record<string, unknown>)[key];
      delete (Array.prototype as unknown as Record<number, unknown>)[0];
    }
  }

  it("ignores inherited event fields and inherited batch slots", async () => {
    const { storage, control } = instrument(createMemoryStorage());
    const watch = createWatch({ storage });
    await watch.start();
    const pending = withPollution(
      { type: "inherited", timestamp: "1999-01-01T00:00:00Z", attributes: { injected: true }, data: { injected: true } },
      () => [watch.ingest({}), watch.ingest({ type: "own" }), watch.ingestBatch([, { type: "own" }])] as const,
    );
    const [missingType, own, sparse] = await Promise.all(pending);
    expect(missingType).toMatchObject({ ok: false, error: { code: "invalid_event", issues: ["event.type: must be a non-empty string"] } });
    expect(sparse).toMatchObject({ ok: false, error: { code: "invalid_event", issues: ["events[0]: must be a plain object"] } });
    expect(own.ok).toBe(true);
    const stored = own.ok ? own.event : undefined;
    expect(stored?.attributes).toEqual({});
    expect(stored && Object.hasOwn(stored, "data")).toBe(false);
    expect(stored?.timestamp).toBe(stored?.receivedAt);
    expect(control.written).toHaveLength(1);
    await watch.stop();
  });

  it("ignores inherited query fields", async () => {
    const watch = createWatch({ storage: createMemoryStorage() });
    await watch.start();
    await watch.ingest({ type: "own", attributes: { k: 1 } });
    const result = withPollution(
      { type: "missing", attributes: { k: 2 }, limit: "bad", order: "sideways", from: "bad", to: "bad" },
      () => watch.query({}),
    );
    expect((await result).events.map((event) => event.type)).toEqual(["own"]);
    await watch.stop();
  });
});

describe("configuration of storage metadata and error codes", () => {
  it("requires a boolean storage.durable", () => {
    const adapter = { kind: "custom", write: async () => undefined, query: async () => [] };
    for (const durable of [undefined, "yes", 1, null]) {
      expect(() => createWatch({ storage: { ...adapter, durable } as never })).toThrow(
        expect.objectContaining({ code: "invalid_config", message: expect.stringContaining("durable") }),
      );
    }
    expect(() => createWatch({ storage: { ...adapter, durable: false } })).not.toThrow();
  });

  it("exports every code a WatchError can carry", () => {
    expectTypeOf<WatchError["code"]>().toEqualTypeOf<WatchErrorCode>();
    expectTypeOf<"start_failed" | "invalid_config" | "invalid_state">().toMatchTypeOf<WatchErrorCode>();
    expect(new WatchError("invalid_state", "x").code).toBe("invalid_state");
  });
});

describe("[memory-fixture] collector ingestion failures reach onError", () => {
  it("reports each failed collector receipt with source collector, still returns it, and recovers", async () => {
    const { storage, control } = instrument(createMemoryStorage());
    const onError = vi.fn();
    let context: CollectorContext | undefined;
    const collector: Collector = { name: "probe", start: (given) => void (context = given), stop() {} };
    const watch = createWatch({ storage, collectors: [collector], onError });
    await watch.start();
    control.failWrites = new Error("disk full");
    const failed = await context!.ingest({ type: "probe.sample" });
    expect(failed).toMatchObject({ ok: false, error: { code: "storage_failed" } });
    expect(onError).toHaveBeenCalledTimes(1);
    const [error, where] = onError.mock.calls[0]!;
    expect(error).toBeInstanceOf(WatchError);
    expect(error).toMatchObject({ code: "storage_failed", message: expect.stringContaining("collector probe") });
    expect(where).toEqual({ source: "collector", name: "probe" });
    const invalid: IngestReceipt = await context!.ingest({ type: "bad type" });
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_event" } });
    expect(onError.mock.calls[1]![0]).toMatchObject({ code: "invalid_event", issues: [expect.stringContaining("type")] });

    control.failWrites = undefined;
    expect(await context!.ingest({ type: "probe.sample" })).toMatchObject({ ok: true });
    expect(onError).toHaveBeenCalledTimes(2);
    // Direct ingestion keeps reporting through receipts only.
    control.failWrites = new Error("disk full");
    expect(await watch.ingest({ type: "direct" })).toMatchObject({ ok: false });
    expect(onError).toHaveBeenCalledTimes(2);
    control.failWrites = undefined;
    await watch.stop();
  });

  it("reports a process metrics sample that storage rejected, then records samples again", async () => {
    vi.useFakeTimers();
    const { storage, control } = instrument(createMemoryStorage());
    const onError = vi.fn();
    const watch = createWatch({ storage, collectors: [processMetricsCollector({ intervalMs: 1000 })], onError });
    control.failWrites = new Error("disk full");
    await watch.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "storage_failed" }), { source: "collector", name: "process-metrics" });
    control.failWrites = undefined;
    await vi.advanceTimersByTimeAsync(1000);
    expect((await watch.query({ type: "infra.process" })).events).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    await watch.stop();
  });

  it("rejects an invalid process metrics event type when the collector is created", () => {
    for (const type of ["infra process", "", "x".repeat(201), ".leading", 5]) {
      expect(() => processMetricsCollector({ type: type as string })).toThrow(TypeError);
    }
    expect(() => processMetricsCollector({ type: "infra.custom:process/v1" })).not.toThrow();
  });
});

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  LIMITS,
  WatchError,
  createMemoryStorage,
  createWatch,
  type Collector,
  type CollectorContext,
  type IngestReceipt,
  type StorageAdapter,
  type Watch,
  type WatchErrorCode,
} from "../src/index.js";
import { processMetricsCollector } from "../src/collectors.js";
import { createSqliteStorage } from "../src/sqlite.js";
import { copyData } from "../src/validation.js";
import { instrument, sqliteFile } from "./helpers.js";

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

/** An array whose index-0 getter, on its first read, calls `mutate` on the array and returns `first`. */
function mutatingArray(items: unknown[], mutate: (array: unknown[]) => void, first: unknown = null): unknown[] {
  const array = [...items];
  let done = false;
  Object.defineProperty(array, 0, {
    enumerable: true,
    configurable: true,
    get() {
      if (!done) mutate(array);
      done = true;
      return first;
    },
  });
  return array;
}

const fill = (count: number, value: unknown) => (array: unknown[]) => {
  for (let index = 0; index < count; index += 1) array.push(value);
};

const adapters: Array<[string, () => { storage: StorageAdapter; cleanup(): void }]> = [
  ["memory-fixture", () => ({ storage: createMemoryStorage(), cleanup() {} })],
  [
    "durable-sqlite",
    () => {
      const db = sqliteFile();
      return { storage: createSqliteStorage({ adapter: db.connect().adapter }), cleanup: () => db.cleanup() };
    },
  ],
];

describe.each(adapters)("[%s] data size is enforced while copying", (label, create) => {
  let harness: ReturnType<typeof create>;
  let watch: Watch;
  let calls: { write: number };

  beforeEach(async () => {
    harness = create();
    const instrumented = instrument(harness.storage);
    calls = instrumented.calls;
    watch = createWatch({ storage: instrumented.storage });
    await watch.start();
  });

  afterEach(async () => {
    await watch.stop();
    harness.cleanup();
  });

  it(`[${label}] rejects an array a getter grows while it is read, at the top level, in an object and two arrays deep, single and batch, writing nothing`, async () => {
    const growths: Array<[string, () => unknown[]]> = [
      ["13999 nulls", () => mutatingArray([null], fill(13_999, null))],
      ["40000 zeros", () => mutatingArray([0], fill(40_000, 0), 0)],
      ["one element", () => mutatingArray([null], fill(1, null))],
    ];
    const placements: Array<(array: unknown[]) => unknown> = [(array) => array, (array) => ({ k: array }), (array) => [[array]]];
    for (const [name, grown] of growths) {
      for (const place of placements) {
        const single = await watch.ingest({ type: "grow", data: place(grown()) });
        expect(single, name).toMatchObject({ ok: false, error: { code: "invalid_event", issues: [expect.stringContaining("changed while it was read")] } });
        const batch = await watch.ingestBatch([{ type: "ok" }, { type: "grow", data: place(grown()) }]);
        expect(batch, name).toMatchObject({ ok: false, error: { code: "invalid_event", issues: [expect.stringMatching(/^events\[1\]\.data.*changed while it was read$/)] } });
      }
    }
    expect(calls.write).toBe(0);
    expect((await watch.query()).events).toEqual([]);
  });

  it(`[${label}] rejects arrays and objects a getter shrinks or removes keys from, never storing holes or undefined`, async () => {
    const objectRemovingLater = () => {
      const value: Record<string, unknown> = {};
      Object.defineProperty(value, "a", {
        enumerable: true,
        configurable: true,
        get() {
          delete value.b;
          return 1;
        },
      });
      value.b = 2;
      return value;
    };
    const objectAddingKey = () => {
      const value: Record<string, unknown> = {};
      Object.defineProperty(value, "a", {
        enumerable: true,
        configurable: true,
        get() {
          value.extra = "x".repeat(70_000);
          return 1;
        },
      });
      return value;
    };
    const cases: Array<[string, () => unknown, RegExp]> = [
      ["pop", () => mutatingArray([null, 1, 2], (array) => void array.pop()), /changed while it was read/],
      ["splice", () => mutatingArray([null, 1, 2, 3], (array) => void array.splice(1, 2)), /changed while it was read/],
      ["truncate", () => mutatingArray([null, 1], (array) => void (array.length = 0)), /changed while it was read/],
      ["delete later item", () => mutatingArray([null, 1, 2], (array) => void delete array[2]), /sparse arrays are not JSON/],
      ["delete later key", objectRemovingLater, /changed while it was read/],
      ["add key", objectAddingKey, /changed while it was read/],
    ];
    for (const [name, make, issue] of cases) {
      expect(await watch.ingest({ type: "shrink", data: make() }), name).toMatchObject({ ok: false, error: { code: "invalid_event", issues: [expect.stringMatching(issue)] } });
      expect(await watch.ingestBatch([{ type: "shrink", data: { nested: [make()] } }]), name).toMatchObject({ ok: false, error: { code: "invalid_event" } });
    }
    expect(calls.write).toBe(0);
  });

  it(`[${label}] counts exactly the bytes JSON.stringify writes: a payload at the limit passes and one byte more fails`, async () => {
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
      const stored = await watch.ingest({ type: "fit", data: fits });
      expect(stored).toMatchObject({ ok: true });
      expect(stored.ok && jsonBytes(stored.event.data)).toBe(LIMITS.maxDataBytes);
      const over = { ...shape, pad: "a".repeat(LIMITS.maxDataBytes - base + 1) };
      expect(await watch.ingest({ type: "over", data: over })).toMatchObject({ ok: false, error: { code: "invalid_event" } });
    }
    expect((await watch.query({ type: "fit" })).events.map((event) => jsonBytes(event.data))).toEqual(shapes.map(() => LIMITS.maxDataBytes));
  });
});

describe("[memory-fixture] data traversal is bounded by counted work", () => {
  it("rejects an alias-heavy graph after fewer property reads than the byte limit, for single events and batches, and writes nothing", async () => {
    const { storage, calls } = instrument(createMemoryStorage());
    const watch = createWatch({ storage });
    await watch.start();
    // 2^20 leaves when expanded; within the depth limit, so only the size budget can stop it early.
    const single = aliasGraph(20);
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
    expect(calls.write).toBe(0);
    await watch.stop();
  });

  it("rejects a million-key object as data, as attributes and as event fields without reading any value", { timeout: 120_000 }, async () => {
    // A plain million-key object. k0, every 1000th key and the last key count reads: any traversal in key order reads k0 first.
    const target: Record<string, unknown> = { type: "wide" };
    let reads = 0;
    const last = 999_999;
    for (let index = 0; index < last; index += 1) {
      if (index % 1000 === 0 || index === last - 1) {
        Object.defineProperty(target, `k${index}`, {
          enumerable: true,
          get() {
            reads += 1;
            return index;
          },
        });
      } else {
        target[`k${index}`] = index;
      }
    }
    expect(Object.keys(target)).toHaveLength(1_000_000);
    const { storage, calls } = instrument(createMemoryStorage());
    const watch = createWatch({ storage });
    await watch.start();
    expect(await watch.ingest({ type: "wide", data: target })).toMatchObject({
      ok: false,
      error: { issues: [`event.data: larger than ${LIMITS.maxDataBytes} bytes as JSON`] },
    });
    expect(await watch.ingestBatch([{ type: "wide", attributes: target }])).toMatchObject({
      ok: false,
      error: { issues: [`events[0].attributes: more than ${LIMITS.maxAttributes} attributes`] },
    });
    const top = await watch.ingest(target);
    expect(top).toMatchObject({ ok: false, error: { code: "invalid_event" } });
    // Ten unknown fields are named and the rest counted, so the receipt stays small.
    expect(!top.ok && top.error.issues).toHaveLength(11);
    expect(!top.ok && top.error.issues?.at(-1)).toBe("event: 999989 more unknown fields");
    expect(reads).toBe(0);
    expect(calls.write).toBe(0);
    await watch.stop();
  });
});

/** Deterministic PRNG (mulberry32) so a failing case can be replayed from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** True when `value` is plain JSON with no holes, undefined or non-plain objects. */
function isStrictJson(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return Object.keys(value).length === value.length && value.every(isStrictJson);
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(isStrictJson);
}

describe("[memory-fixture] charged bytes equal the accepted copy under mutating getters", () => {
  it("holds for 2000 seeded random payloads whose getters grow, shrink, rekey or rewrite containers", () => {
    const leaves = [null, true, false, 0, -0, 1e21, 5e-324, -12.5, "", "a", 'q"\\', "😀", "\uD800", "\u0001", "é漢".repeat(20)];
    let accepted = 0;
    let mutatedAccepted = 0;
    let changedRejected = 0;
    for (let seed = 1; seed <= 2000; seed += 1) {
      const next = random(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
      const containers: Array<unknown[] | Record<string, unknown>> = [];
      const build = (depth: number): unknown => {
        if (depth > 4 || next() < 0.35) return pick(leaves);
        const size = Math.floor(next() * 6);
        const container: unknown[] | Record<string, unknown> = next() < 0.5 ? [] : {};
        for (let index = 0; index < size; index += 1) {
          if (Array.isArray(container)) container.push(build(depth + 1));
          else container[pick(["a", "b", "k", "__proto__", "é", `n${index}`, String(index)])] = build(depth + 1);
        }
        containers.push(container);
        return container;
      };
      const root = build(0);
      let mutations = 0;
      const mutate = () => {
        const target = pick(containers);
        mutations += 1;
        const action = Math.floor(next() * 6);
        if (Array.isArray(target)) {
          if (action === 0) for (let count = Math.floor(next() * 3000); count > 0; count -= 1) target.push(pick(leaves));
          else if (action === 1) target.pop();
          else if (action === 2) target.splice(0, 1);
          else if (action === 3 && target.length > 0) delete target[target.length - 1];
          else if (target.length > 0) target[Math.floor(next() * target.length)] = pick(leaves);
        } else {
          const keys = Object.keys(target);
          if (action === 0) target[`added${Math.floor(next() * 5)}`] = "x".repeat(Math.floor(next() * 3000));
          else if (action === 1 && keys.length > 0) delete target[pick(keys)];
          else if (action === 2 && keys.length > 0) {
            delete target[pick(keys)];
            target.swapped = 1;
          }
          else if (keys.length > 0) target[pick(keys)] = pick(leaves);
        }
      };
      for (const container of containers) {
        const keys = Object.keys(container);
        if (keys.length === 0 || next() < 0.5) continue;
        const key = pick(keys);
        const value = (container as Record<string, unknown>)[key];
        Object.defineProperty(container, key, {
          enumerable: true,
          configurable: true,
          get() {
            if (next() < 0.7) mutate();
            return value;
          },
          // A later write by another getter (or splice) turns the slot back into data.
          set: (written) => void Object.defineProperty(container, key, { value: written, writable: true, enumerable: true, configurable: true }),
        });
      }
      const maxBytes = 16 + Math.floor(next() * 4096);
      const result = copyData(root, "data", maxBytes);
      if (result.copy === undefined) {
        expect(result.issues.length, `seed ${seed}`).toBeGreaterThan(0);
        if (result.issues.some((issue) => issue.includes("changed while it was read"))) changedRejected += 1;
        continue;
      }
      accepted += 1;
      if (mutations > 0) mutatedAccepted += 1;
      expect(jsonBytes(result.copy), `seed ${seed}`).toBe(result.chargedBytes);
      expect(result.chargedBytes, `seed ${seed}`).toBeLessThanOrEqual(maxBytes);
      expect(isStrictJson(result.copy), `seed ${seed}`).toBe(true);
    }
    // Guards against a vacuous run: every outcome class must actually occur.
    expect(accepted).toBeGreaterThan(200);
    expect(mutatedAccepted).toBeGreaterThan(20);
    expect(changedRejected).toBeGreaterThan(50);
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

import { describe, expect, it, vi } from "vitest";
import { QueryEngine, QueryValidationError } from "../../src/query/query-engine";
import { MemoryStorage } from "../../src/storage/memory-storage";
import { WatchFn } from "../../src/core/watch-fn";
import type { Aggregation } from "../../src/query/types";

function engine(events: any[]) {
  const storage = new MemoryStorage();
  events.forEach(event => storage.add(event));
  return new QueryEngine(storage);
}
const numeric = Object.fromEntries(["sum", "avg", "min", "max"].map(operation => [operation, { operation, field: "duration" }])) as Record<string, Aggregation>;

describe("query aggregations", () => {
  it("computes named statistics after metric/where/time filters and ignores nonfinite numeric inputs", async () => {
    const query = engine([
      { name: "request", timestamp: 100, properties: { duration: 0, ok: true, user: "a" } },
      { name: "request", timestamp: 200, properties: { duration: 10, ok: true, user: "b" } },
      { name: "request", timestamp: 300, properties: { duration: 20, ok: true, user: "a" } },
      { name: "request", timestamp: 300, properties: { duration: "30", ok: true } },
      { name: "request", timestamp: 300, properties: { duration: Infinity, ok: true } },
      { name: "request", timestamp: 300, properties: { duration: NaN, ok: true } },
      { name: "request", timestamp: 400, properties: { duration: 10000, ok: true } },
      { name: "request", timestamp: 100, properties: { duration: 10000, ok: false } },
      { name: "other", timestamp: 100, properties: { duration: 10000, ok: true } },
    ]);
    const result = await query.execute({ metric: "request", where: { ok: true }, timeRange: { from: 100, to: 300 }, aggregations: {
      count: { operation: "count" }, users: { operation: "count_distinct", field: "user" }, ...numeric,
      p0: { operation: "percentile", field: "duration", percentile: 0 },
      p50: { operation: "percentile", field: "duration", percentile: 50 },
      p95: { operation: "percentile", field: "duration", percentile: 95 },
      p100: { operation: "percentile", field: "duration", percentile: 100 },
    } });
    expect(result.data).toEqual([{ count: 6, users: 2, sum: 30, avg: 10, min: 0, max: 20, p0: 0, p50: 10, p95: 19, p100: 20 }]);
    expect(result.meta.count).toBe(1);
  });

  it("groups mixed dimensions and UTC epoch-aligned buckets before ordering and limiting", async () => {
    const result = await engine([
      { name: "request", timestamp: 299999, properties: { endpoint: "/a", duration: 10 } },
      { name: "request", timestamp: 0, properties: { endpoint: "/a", duration: 30 } },
      { name: "request", timestamp: 300000, properties: { endpoint: "/a", duration: 40 } },
      { name: "request", ts: "1970-01-01T00:05:00Z", properties: { endpoint: "/b", duration: 50 } },
      { name: "request", properties: { endpoint: "/missing", duration: 9999 } },
    ]).execute({ groupBy: ["endpoint", { interval: "5m" }], aggregations: { count: { operation: "count" }, avg: numeric.avg }, orderBy: { field: "avg", direction: "desc" }, limit: 2 });
    expect(result.data).toEqual([{ endpoint: "/b", timestamp: 300000, count: 1, avg: 50 }, { endpoint: "/a", timestamp: 300000, count: 1, avg: 40 }]);
  });

  it("uses collision-safe group keys and preserves typed falsy values", async () => {
    const result = await engine([
      { a: "x:y", b: "z" }, { a: "x", b: "y:z" }, { a: false, b: 0 }, { a: "false", b: "0" }, { a: "", b: null }, {},
    ]).execute({ groupBy: ["a", "b"], aggregations: { count: { operation: "count" } } });
    expect(result.data).toHaveLength(6);
    expect(result.data[2]).toEqual({ a: false, b: 0, count: 1 });
    expect(result.data[5]).toEqual({ a: null, b: null, count: 1 });
  });

  it("sorts flat dotted group labels while preserving nested source field precedence", async () => {
    const query = engine([
      { request: { method: "POST" }, "request.method": "AAA" },
      { request: { method: "GET" }, "request.method": "ZZZ" },
    ]);
    expect((await query.execute({ groupBy: "request.method", aggregations: { count: { operation: "count" } }, orderBy: { field: "request.method", direction: "asc" } })).data).toEqual([
      { "request.method": "GET", count: 1 }, { "request.method": "POST", count: 1 },
    ]);
    expect((await query.execute({ where: { "request.method": "GET" } })).data).toHaveLength(1);
  });

  it("returns explicit empty-set semantics without inventing numeric samples", async () => {
    const aggregations = { count: { operation: "count" as const }, ...numeric, p95: { operation: "percentile" as const, field: "duration", percentile: 95 } };
    expect((await engine([]).execute({ aggregations })).data).toEqual([{ count: 0, sum: 0, avg: null, min: null, max: null, p95: null }]);
    expect((await engine([]).execute({ aggregations, groupBy: "endpoint" })).data).toEqual([]);
    expect((await engine([{ duration: 1 }]).execute({ aggregations, limit: 0 })).data).toEqual([]);
  });

  it("counts distinct scalar values without conflating numeric and string identities", async () => {
    const data = [0, false, "", 0, "0", null, undefined].map(user => ({ user }));
    expect((await engine(data).execute({ aggregations: { users: { operation: "count_distinct", field: "user" } } })).data).toEqual([{ users: 4 }]);
  });

  it("rejects malformed aggregation/group/filter requests before reading storage", async () => {
    const getAll = vi.fn(() => []);
    const query = new QueryEngine({ add() {}, query: () => [], getAll });
    for (const options of [
      { aggregations: { value: { operation: "avg" } } },
      { aggregations: { value: { operation: "percentile", field: "duration", percentile: 101 } } },
      { aggregations: { value: { operation: "rate", numerator: { metric: "error" } } } },
      { groupBy: { interval: "0m" }, aggregations: { count: { operation: "count" } } },
      { groupBy: ["endpoint", "endpoint"], aggregations: { count: { operation: "count" } } },
      { groupBy: "endpoint", aggregations: { endpoint: { operation: "count" } } },
      { where: { duration: { surprise: 1 } } }, { limit: -1 }, { orderBy: { field: "x", direction: "bad" } },
      { timeRange: { from: 10, to: 0 } },
      { aggregations: JSON.parse('{"__proto__":{"operation":"count"}}') },
    ]) await expect(query.execute(options as any)).rejects.toBeInstanceOf(QueryValidationError);
    expect(getAll).not.toHaveBeenCalled();
  });

  it("does not push down a pre-aggregation limit or grouping into raw storage", async () => {
    const executeQuery = vi.fn(async (_options: unknown) => [{ value: 1 }, { value: 3 }]);
    const query = new QueryEngine({ add() {}, query: () => [], executeQuery } as any);
    expect((await query.execute({ aggregations: { total: { operation: "sum", field: "value" } }, limit: 1 })).data).toEqual([{ total: 4 }]);
    expect(executeQuery.mock.calls[0][0]).not.toHaveProperty("limit");
    expect(executeQuery.mock.calls[0][0]).not.toHaveProperty("aggregations");
  });

  it("rejects overflow instead of returning Infinity", async () => {
    await expect(engine([{ duration: Number.MAX_VALUE }, { duration: Number.MAX_VALUE }]).execute({ aggregations: { sum: numeric.sum } })).rejects.toBeInstanceOf(QueryValidationError);
  });

  it("watch.aggregate reads real events with suffix metrics and percentile shorthand", async () => {
    const watch = new WatchFn({ name: "aggregation", storage: "memory", infra: { enabled: false } });
    watch.start();
    try {
      await watch.ingest([{ name: "api.request", timestamp: 0, properties: { duration: 10, endpoint: "/a" } }, { name: "api.request", timestamp: 1, properties: { duration: 30, endpoint: "/a" } }]);
      expect(await watch.aggregate({ metric: "api.request.duration", aggregation: "avg", groupBy: "endpoint" })).toEqual([{ endpoint: "/a", value: 20 }]);
      expect(await watch.aggregate({ metric: "api.request.duration", aggregation: "p95" })).toEqual([{ value: 29 }]);
      expect(await watch.aggregate({ metric: "api.request", aggregation: "count" })).toEqual([{ value: 2 }]);
      expect(await watch.aggregate({ metric: "api.request", aggregation: "max", field: "duration" })).toEqual([{ value: 30 }]);
    } finally { watch.stop(); }
  });

  it("prefers an exact scalar metric event over suffix interpretation", async () => {
    const query = engine([{ name: "cpu.usage", value: 0.25 }, { name: "cpu", properties: { usage: 90 } }]);
    expect((await query.aggregate({ metric: "cpu.usage", aggregation: "avg" })).data).toEqual([{ value: 0.25 }]);
  });
});

it("short-circuits and closes the exact-presence probe while retaining candidate filters", async () => {
  const calls: any[] = [];
  let closed = 0;
  const query = new QueryEngine({
    async *iterateQuery(options: any) {
      calls.push(options);
      try {
        if (!Object.keys(options).length) {
          yield { name: "request.duration", timestamp: 0, properties: { value: 999 } };
          throw new Error("Exact-presence probe must stop immediately");
        }
        yield { name: "request", timestamp: 100, properties: { duration: 10 } };
      } finally { closed++; }
    },
  } as any);
  const options = { metric: "request.duration", aggregation: "avg" as const, timeRange: { from: 50, to: 150 } };
  expect((await query.aggregate(options)).data).toEqual([{ value: null }]);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual({});
  expect(calls[1].resolvedTimeRange).toEqual({ from: 50, to: 150 });
  expect(closed).toBe(2);
  calls.length = 0;
  expect((await query.aggregate({ ...options, metric: "request", aggregation: "count" })).data).toEqual([{ value: 1 }]);
  expect(calls).toHaveLength(1);
});

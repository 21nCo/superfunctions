import { describe, expect, it } from "vitest";
import { QueryEngine } from "../../src/query/query-engine";
import type { StorageAdapter } from "../../src/storage/types";

function stream(events: any[], failAfter?: number) {
  const state = { yielded: 0, closed: false };
  const storage: StorageAdapter = {
    add() {}, query: () => [],
    getAll() { throw new Error("materialized path must not be used"); },
    async *iterateQuery() {
      try {
        for (const event of events) {
          if (state.yielded === failAfter) throw new Error("late storage failure");
          state.yielded++; yield event;
        }
      } finally { state.closed = true; }
    },
  };
  return { engine: new QueryEngine(storage), state };
}

describe("streamed query execution", () => {
  it("filters across all source pages while retaining only the requested unordered rows", async () => {
    const events = Array.from({ length: 1205 }, (_, index) => ({ id: index, type: "request", timestamp: index, properties: { keep: index % 137 === 0 } }));
    const { engine, state } = stream(events);
    expect((await engine.execute({ metric: "request", where: { keep: true }, timeRange: { from: 1, to: 1204 }, limit: 3 })).data.map(row => row.id)).toEqual([137, 274, 411]);
    expect(state).toEqual({ yielded: 1205, closed: true });
  });

  it("does not acknowledge an incomplete scan after reaching the requested output limit", async () => {
    const { engine, state } = stream([{ id: 1 }, { id: 2 }], 1);
    await expect(engine.execute({ limit: 1 })).rejects.toThrow("late storage failure");
    expect(state.closed).toBe(true);
  });

  it("preserves exact numeric arithmetic, including avg overflow avoidance and signed zero", async () => {
    const values = [Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE];
    const { engine } = stream(values.map(value => ({ value })));
    expect((await engine.execute({ aggregations: { mean: { operation: "avg", field: "value" } } })).data).toEqual([{ mean: values.reduce((mean, value) => mean + value / values.length, 0) }]);
    const zeros = stream([{ value: -0 }, { value: 0 }]).engine;
    const result = (await zeros.execute({ aggregations: { min: { operation: "min", field: "value" }, max: { operation: "max", field: "value" } } })).data[0];
    expect(Object.is(result.min, -0)).toBe(true); expect(Object.is(result.max, 0)).toBe(true);
  });

  it("discards invalid suffix groups if a later exact metric exists, even if exact is filtered out", async () => {
    const { engine } = stream([
      { name: "api.request", properties: { duration: 10, group: { invalid: true }, keep: true } },
      { name: "api.request.duration", value: 20, properties: { group: "exact", keep: false } },
    ]);
    expect((await engine.aggregate({ metric: "api.request.duration", aggregation: "avg", where: { keep: true }, groupBy: "group" })).data).toEqual([]);
    await expect(stream([{ name: "api.request", properties: { duration: 10, group: {} } }]).engine.aggregate({ metric: "api.request.duration", aggregation: "avg", groupBy: "group" })).rejects.toThrow("finite scalar");
  });

  it("keeps first-seen group order and complete statistics beyond 1000 events before limit", async () => {
    const events = Array.from({ length: 1501 }, (_, value) => ({ name: value % 3 ? "request" : "error", timestamp: value, group: value % 2 ? "odd" : "even", value, user: value % 17 }));
    const { engine } = stream(events);
    const result = await engine.execute({ groupBy: "group", aggregations: { count: { operation: "count" }, sum: { operation: "sum", field: "value" }, distinct: { operation: "count_distinct", field: "user" }, p50: { operation: "percentile", field: "value", percentile: 50 }, rate: { operation: "rate", numerator: { metric: "error" }, denominator: { metric: "request" } } }, limit: 1 });
    expect(result.data).toEqual([{ group: "even", count: 751, sum: 563250, distinct: 17, p50: 750, rate: 251 / 500 }]);
  });

  it("preserves stable mixed-value ordering rather than assuming a total comparator", async () => {
    const events = [{ value: 3 }, {}, { value: "2" }, { value: null }, { value: 1 }, { value: "word" }, { value: 3 }];
    const expected = [...events].sort((a: any, b: any) => a.value < b.value ? -1 : a.value > b.value ? 1 : 0).slice(0, 4);
    expect((await stream(events).engine.execute({ orderBy: { field: "value", direction: "asc" }, limit: 4 })).data).toEqual(expected);
  });
});

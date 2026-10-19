import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryEngine } from "../../src/query/query-engine";
import { MemoryStorage } from "../../src/storage/memory-storage";

function fixture(events: any[]) {
  const storage = new MemoryStorage();
  for (const event of events) storage.add(event);
  return { storage, engine: new QueryEngine(storage) };
}
afterEach(() => vi.useRealTimers());

describe("query filtering", () => {
  it("applies relative ranges inclusively to Date, epoch and serialized timestamps", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-10-20T12:00:00Z");
    vi.setSystemTime(now);
    const events = [
      { id: "start", timestamp: now - 3600000 },
      { id: "date", timestamp: new Date(now) },
      { id: "iso", timestamp: new Date(now - 1).toISOString() },
      { id: "old", timestamp: now - 3600001 },
      { id: "future", timestamp: now + 1 },
      { id: "missing" }, { id: "null", timestamp: null },
      { id: "invalid", timestamp: "invalid" },
    ];
    const { engine } = fixture(events);
    for (const timeRange of ["last-1h", { shortcut: "last-1h" }]) {
      expect((await engine.execute({ timeRange })).data.map(e => e.id)).toEqual(["start", "date", "iso"]);
    }
  });

  it("supports absolute and open bounds without treating epoch zero as missing", async () => {
    const { engine } = fixture([{ timestamp: -1 }, { timestamp: 0 }, { timestamp: 1 }]);
    expect((await engine.execute({ timeRange: { from: new Date(0), to: "1970-01-01T00:00:00.000Z" } })).data).toEqual([{ timestamp: 0 }]);
    expect((await engine.execute({ timeRange: { from: 0 } })).data).toEqual([{ timestamp: 0 }, { timestamp: 1 }]);
    expect((await engine.execute({ timeRange: { to: 0 } })).data).toEqual([{ timestamp: -1 }, { timestamp: 0 }]);
  });

  it("rejects malformed, reversed and unbounded empty range requests", async () => {
    const { engine } = fixture([]);
    for (const timeRange of ["bad-range", { from: "bad" }, { from: 2, to: 1 }, {}, { to: Infinity }]) {
      await expect(engine.execute({ timeRange })).rejects.toThrow();
    }
  });

  it("keeps explicit false, zero, empty and null values ahead of property fallbacks", async () => {
    const event = { flag: false, count: 0, text: "", empty: null, properties: { flag: true, count: 10, text: "fallback", empty: "fallback" } };
    const { engine } = fixture([event]);
    expect((await engine.execute({ where: { flag: false, count: 0, text: "", empty: null } })).data).toEqual([event]);
    expect((await engine.execute({ where: { flag: true } })).data).toEqual([]);
  });

  it("resolves nested explicit properties and shorthand paths without inherited fields", async () => {
    const event = { properties: { request: { status: 0, auth: { valid: false } } } };
    const { engine } = fixture([event]);
    expect((await engine.execute({ where: { "request.status": 0, "properties.request.auth.valid": false } })).data).toEqual([event]);
    expect((await engine.execute({ where: { "request.toString": { exists: true } } })).data).toEqual([]);
  });

  it("excludes missing/null/NaN fields from ordered and substring comparisons", async () => {
    const { engine } = fixture([{}, { value: null }, { value: NaN }]);
    for (const operator of ["gt", "gte", "lt", "lte"]) {
      expect((await engine.execute({ where: { value: { [operator]: 5 } } })).data).toEqual([]);
    }
    expect((await engine.execute({ where: { absent: { contains: "undefined" } } })).data).toEqual([]);
    expect((await engine.execute({ where: { value: { exists: false } } })).data).toEqual([{}, { value: null }]);
  });

  it("sorts a copy of stored arrays and preserves future insertion order", async () => {
    const events = [{ properties: { value: 2 } }, { properties: { value: 0 } }, { properties: { value: 1 } }];
    const { engine, storage } = fixture(events);
    const ordered = await engine.execute({ orderBy: { field: "properties.value", direction: "asc" }, limit: 2 });
    expect(ordered.data).toEqual([events[1], events[2]]);
    expect(storage.getAll()).toEqual(events);
    expect((await engine.execute({})).data).toEqual(events);
  });

  it("does not sort specialized storage results in place", async () => {
    const events = Object.freeze([{ rank: 2 }, { rank: 1 }]);
    const engine = new QueryEngine({ add() {}, query: () => [], executeQuery: async () => events } as any);
    expect((await engine.execute({ orderBy: { field: "rank", direction: "asc" } })).data).toEqual([{ rank: 1 }, { rank: 2 }]);
  });
});

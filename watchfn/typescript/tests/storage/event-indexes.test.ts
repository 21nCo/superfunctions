import { describe, expect, it, vi } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters/memory";
import { DatabaseStorage, getWatchFnSchema } from "../../src/storage/database";
import { MemoryStorage } from "../../src/storage/memory-storage";
import { QueryEngine } from "../../src/query/query-engine";
import { eventProjectionWhere, projectEvent } from "../../src/storage/projection";

const bug = (id: string, app = "shop", severity = "high") => ({ id, type: "bug_report", timestamp: "2026-10-20T10:00:00+05:30", app: { name: app }, sessionId: "session", replayId: "replay", report: { severity, tags: ["checkout"] }, integration: { issueId: "42" } });

describe("canonical event projections", () => {
  it("mirrors nested own-property precedence and keeps raw payload intact", async () => {
    const input = { ...bug("one"), app: null, properties: { app: { name: "must-not-fallback" } } };
    expect(projectEvent(input)).toMatchObject({ eventApp: null, eventTimestamp: Date.parse(input.timestamp), eventSeverity: "high", eventIssueId: "42" });
    expect(projectEvent({ properties: { app: { name: "fallback" }, sessionId: "fallback-session" }, ts: 123 })).toMatchObject({ eventApp: "fallback", eventSessionId: "fallback-session", eventTimestamp: 123 });
    const storage = new DatabaseStorage(memoryAdapter()); await storage.add(input);
    expect(await storage.getAll()).toEqual([input]);
  });
  it("pushes only supported exact strings and finite resolved time bounds", () => {
    expect(eventProjectionWhere({ where: { type: { contains: "bug" }, "app.name": null, sessionId: { neq: "x" }, replayId: false, "report.tags": { contains: "checkout" } }, timeRange: "last-1h" })).toEqual([]);
    expect(eventProjectionWhere({ where: { type: { eq: "bug_report", exists: true } }, resolvedTimeRange: { from: -Infinity, to: 123 } })).toEqual([{ field: "eventType", operator: "eq", value: "bug_report" }, { field: "eventTimestamp", operator: "lte", value: 123 }]);
  });
  it("narrows DB reads while preserving postfilter, timezones, aggregations and limits", async () => {
    const db = memoryAdapter(); const storage = new DatabaseStorage(db); const engine = new QueryEngine(storage);
    await storage.add(bug("one")); await storage.add(bug("two", "other")); await storage.add(bug("three", "shop", "low"));
    const read = vi.spyOn(db, "findMany");
    const result = await engine.execute({ where: { type: "bug_report", "app.name": "shop", "report.severity": { eq: "high" }, "report.tags": { contains: "checkout" } }, timeRange: { from: "2026-10-20T04:30:00Z", to: "2026-10-20T04:30:00Z" }, limit: 1 });
    expect(result.data).toEqual([bug("one")]);
    expect(read.mock.calls[0][0].where).toContainEqual({ field: "eventApp", operator: "eq", value: "shop" });
    expect(read.mock.calls[0][0].where).toContainEqual({ field: "eventTimestamp", operator: "gte", value: Date.parse("2026-10-20T04:30:00Z") });
    expect((await engine.execute({ where: { "app.name": "shop" }, aggregations: { total: { operation: "count" } } })).data).toEqual([{ total: 2 }]);
  });
  it("includes legacy, partial and unknown projection versions until offline backfill", async () => {
    const db = memoryAdapter(); const storage = new DatabaseStorage(db); const engine = new QueryEngine(storage);
    for (const [id, projectionVersion] of [["a", null], ["b", 99], ["c", "invalid"]] as const) {
      await db.create({ model: "watchfn_events", data: { id, payload: JSON.stringify(bug(id)), projectionVersion, eventApp: "wrong-partial-value" } });
    }
    expect((await engine.execute({ where: { "app.name": "shop" } })).data).toHaveLength(3);
    const first = await storage.backfillEventProjections({ limit: 2 }); expect(first).toEqual({ processed: 2, nextCursor: "b" });
    expect(await storage.backfillEventProjections({ limit: 2, after: first.nextCursor! })).toEqual({ processed: 1, nextCursor: null });
    expect(await storage.backfillEventProjections()).toEqual({ processed: 3, nextCursor: null });
    expect((await engine.execute({ where: { "app.name": "shop" } })).data).toHaveLength(3);
  });
  it("retains all matching pages and does not apply caller limits to storage", async () => {
    const db = memoryAdapter(); const storage = new DatabaseStorage(db);
    for (let index = 0; index < 1002; index++) await storage.add(bug(String(index)));
    expect(await storage.executeQuery({ where: { type: "bug_report" }, limit: 1 })).toHaveLength(1002);
  });
  it("preserves long legacy strings through the scan fallback and bounds custom index names", async () => {
    const storage = new DatabaseStorage(memoryAdapter()); const event = bug("long", "a".repeat(256));
    await storage.add(event);
    expect(projectEvent(event)).toMatchObject({ projectionVersion: 0, eventApp: null });
    expect((await new QueryEngine(storage).execute({ where: { "app.name": event.app.name } })).data).toEqual([event]);
    const table = "a".repeat(63); const indexes = getWatchFnSchema(table)[table].indexes!;
    expect(indexes.every(index => index.name.length <= 63)).toBe(true);
    expect(new Set(indexes.map(index => index.name)).size).toBe(indexes.length);
  });
  it("matches the unindexed query engine across mixed predicates and timestamp forms", async () => {
    const storage = new DatabaseStorage(memoryAdapter()); const memory = new MemoryStorage();
    const events = [bug("a"), bug("b", "other", "low"), { ...bug("c"), app: null, timestamp: 123, properties: { app: { name: "shop" } } }, { ...bug("d"), timestamp: "invalid" }, { ...bug("e"), timestamp: undefined, ts: 123 }, { properties: { type: "bug_report", app: { name: "shop" } }, timestamp: 123 }];
    for (const input of events) { const event = JSON.parse(JSON.stringify(input)); await storage.add(event); memory.add(event); }
    const queries = [
      { where: { "app.name": "shop", "report.severity": { neq: "low" } } },
      { where: { type: { contains: "bug" }, "app.name": { exists: true } } },
      { where: { "app.name": { eq: "shop", contains: "h" } }, timeRange: { from: 0, to: 200 } },
      { where: { app: null } }, { timeRange: { from: 0 } },
      { where: { type: "bug_report" }, metric: "missing" },
    ];
    for (const query of queries) {
      const actual = (await new QueryEngine(storage).execute(query)).data;
      const expected = (await new QueryEngine(memory).execute(query)).data;
      expect(actual.map(value => JSON.stringify(value)).sort()).toEqual(expected.map(value => JSON.stringify(value)).sort());
    }
  });
  it("retries a partially completed backfill page without changing payloads", async () => {
    const db = memoryAdapter(); const storage = new DatabaseStorage(db);
    for (const id of ["a", "b", "c"]) await db.create({ model: "watchfn_events", data: { id, payload: JSON.stringify(bug(id)), projectionVersion: null } });
    const update = db.updateMany.bind(db); let writes = 0;
    const spy = vi.spyOn(db, "updateMany").mockImplementation(async params => { if (++writes === 2) throw new Error("interrupted"); return update(params); });
    await expect(storage.backfillEventProjections({ limit: 3 })).rejects.toThrow("interrupted");
    spy.mockRestore();
    expect(await storage.backfillEventProjections({ limit: 3 })).toEqual({ processed: 3, nextCursor: "c" });
    expect(await storage.backfillEventProjections({ after: "c", limit: 3 })).toEqual({ processed: 0, nextCursor: null });
    expect(await storage.getAll()).toEqual([bug("a"), bug("b"), bug("c")]);
  });
  it("surfaces backfill failures without claiming completion and rejects invalid page sizes", async () => {
    const db = memoryAdapter(); const storage = new DatabaseStorage(db); await storage.add(bug("one"));
    vi.spyOn(db, "updateMany").mockRejectedValue(new Error("write failed"));
    await expect(storage.backfillEventProjections()).rejects.toThrow("write failed");
    for (const limit of [0, -1, 1001, NaN, 1.1]) await expect(storage.backfillEventProjections({ limit })).rejects.toThrow("Invalid");
    await expect(new DatabaseStorage({ insertEvent: async () => {}, queryEvents: async () => [] }).backfillEventProjections()).rejects.toThrow("shared DB");
  });
});

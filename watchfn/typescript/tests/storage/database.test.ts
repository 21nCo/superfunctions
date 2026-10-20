import { describe, expect, it, vi } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters/memory";
import { DatabaseStorage, getWatchFnSchema } from "../../src/storage/database";
import { WatchFn } from "../../src/core/watch-fn";

const event = { id: "producer", name: "log", type: "log", timestamp: "2026-10-20T00:00:00Z",
  traceId: "trace", ctx: { nested: ["文", true, null] }, properties: { count: 4 } };

describe("shared DB event storage", () => {
  it("owns its JSON schema and snapshots payloads without consumer adapterSchema", async () => {
    const db = memoryAdapter();
    const storage = new DatabaseStorage(db);
    const input = structuredClone(event);
    await storage.add(input);
    input.ctx.nested[0] = "changed";
    expect(await storage.getAll()).toEqual([event]);
    expect(storage.getSchema()).toEqual(getWatchFnSchema());
    await storage.add(event);
    expect(await storage.getAll()).toHaveLength(2);
    expect(await storage.query(value => value.name === "absent")).toEqual([]);
  });

  it("round trips metadata through HTTP ingest and canonical query filtering", async () => {
    const watch = new WatchFn({ name: "test", storage: "database", database: memoryAdapter(), infra: { enabled: false } } as any);
    watch.start();
    try {
      const response = await watch.httpRouter.handle(new Request("http://local/ingest", {
        method: "POST", body: JSON.stringify({ events: [event, { ...event, name: "other", type: "other" }] }),
      }));
      expect(response.status).toBe(202);
      expect(await watch.query({ metric: "log", where: { "ctx.nested.0": "文", count: { gt: 3 } } })).toEqual([event]);
      expect(await watch.query({ timeRange: { from: "2026-10-21", to: "2026-10-22" } })).toEqual([]);
    } finally { watch.stop(); }
  });

  it("loads all pages before applying query filters", async () => {
    const storage = new DatabaseStorage(memoryAdapter());
    for (let index = 0; index < 1002; index++) await storage.add({ ...event, sequence: index });
    expect(await storage.getAll()).toHaveLength(1002);
    expect(await storage.query(value => value.sequence === 1001)).toHaveLength(1);
  });

  it("propagates storage failures and rejects invalid adapters/table names", async () => {
    const db = memoryAdapter();
    vi.spyOn(db, "create").mockRejectedValue(new Error("storage failed"));
    await expect(new DatabaseStorage(db).add(event)).rejects.toThrow("storage failed");
    vi.spyOn(db, "findMany").mockRejectedValue(new Error("query failed"));
    await expect(new DatabaseStorage(db).getAll()).rejects.toThrow("query failed");
    expect(() => new DatabaseStorage({} as any)).toThrow("Database must");
    expect(() => getWatchFnSchema("bad;name")).toThrow("Invalid table");
  });

  it("retains the explicit legacy compatibility path and applies query callbacks", async () => {
    const legacy = { insertEvent: vi.fn(async () => {}), queryEvents: vi.fn(async () => [event]) };
    const storage = new DatabaseStorage(legacy);
    await storage.add(event);
    expect(legacy.insertEvent).toHaveBeenCalledWith(event);
    expect(await storage.query(value => value.name === "absent")).toEqual([]);
    const options = { metric: "log" };
    expect(await storage.executeQuery(options)).toEqual([event]);
    expect(legacy.queryEvents).toHaveBeenLastCalledWith(options);
  });
});

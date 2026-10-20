import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters/memory";
import { DatabaseStorage } from "../../src/storage/database";
import { WatchFn } from "../../src/core/watch-fn";
import { DEFAULT_EVENT_TTL_MS } from "../../src/storage/event-retention";
import { BUG_ISSUES_TABLE } from "../../src/integrations/botfn/schema";

const now = 1_800_000_000_000;
const bug = (id = "one", app = "web") => ({ id, type: "bug_report", timestamp: "2100-01-01T00:00:00Z", app: { name: app }, sessionId: "session", report: { title: "Bug", severity: "high" }, context: {} });
const watches: WatchFn[] = [];
afterEach(async () => { for (const watch of watches.splice(0)) { await watch.flush().catch(() => {}); await watch.stop().catch(() => {}); } vi.restoreAllMocks(); });
function setup(db = memoryAdapter(), namespace = "one", client: any = { request: vi.fn(async (_path: string, options: RequestInit) => ({ number: 7, html_url: "https://github.com/acme/bugs/issues/7", body: JSON.parse(options.body as string).body })) }) {
  const watch = new WatchFn({ name: "test", storage: "database", database: db, auth: { apiKey: "key" }, infra: { enabled: false }, retention: { apps: ["web"], defaultTtlMs: 100 }, botfn: { namespace, routes: [{ app: "web", target: "github", project: "acme/bugs", client }] } } as any);
  watch.start(); watches.push(watch); return { watch, db, client };
}

describe("canonical event retention", () => {
  it("uses server arrival time and defaults to30days with a separate bug TTL", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const db = memoryAdapter(); const storage = new DatabaseStorage(db, "watchfn_events", undefined, { apps: ["web"], bugReportTtlMs: 10 });
    await storage.add({ ...bug(), receivedAt: 0 }); await storage.add({ type: "log", app: { name: "web" }, timestamp: 0 });
    expect((await db.findMany({ model: "watchfn_events", where: [] })).every(row => row.receivedAt === now)).toBe(true);
    clock.mockReturnValue(now + 10); expect((await storage.cleanupRetention()).deleted).toBe(0);
    clock.mockReturnValue(now + 11); expect((await storage.cleanupRetention()).deleted).toBe(1);
    expect((await storage.getAll())[0].type).toBe("log");
    clock.mockReturnValue(now + DEFAULT_EVENT_TTL_MS + 1); expect((await storage.cleanupRetention()).deleted).toBe(1);
    expect((await storage.cleanupRetention()).deleted).toBe(0);
  });
  it("retains unconfigured apps, missing identities and invalid/historical arrival times", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const db = memoryAdapter(); const storage = new DatabaseStorage(db, "watchfn_events", undefined, { apps: ["web"], defaultTtlMs: 1 });
    for (const [id, payload, receivedAt] of [["other", bug("a", "other"), 1], ["no-app", { type: "log", properties: { app: { name: "web" } } }, 1], ["old", bug(), null], ["invalid", bug(), -1], ["future", bug(), now + 1], ["string", bug(), "1"]] as const) await db.create({ model: "watchfn_events", data: { id, payload: JSON.stringify(payload), receivedAt } });
    expect(await storage.cleanupRetention()).toMatchObject({ scanned: 6, deleted: 0, retained: 6 });
  });
  it("initializes historical arrival times with one explicit anchor without resetting existing timestamps", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const db = memoryAdapter(); const storage = new DatabaseStorage(db);
    for (const id of ["a", "b", "c"]) await db.create({ model: "watchfn_events", data: { id, payload: JSON.stringify(bug(id)), receivedAt: id === "c" ? 7 : null } });
    expect(await storage.backfillReceivedAt({ receivedAt: now, limit: 2 })).toEqual({ processed: 2, initialized: 2, nextCursor: "b" });
    expect(await storage.backfillReceivedAt({ receivedAt: now, after: "b", limit: 2 })).toEqual({ processed: 1, initialized: 0, nextCursor: null });
    expect((await storage.backfillReceivedAt({ receivedAt: now - 1 })).initialized).toBe(0);
    expect((await db.findOne({ model: "watchfn_events", where: [{ field: "id", operator: "eq", value: "c" }] }))?.receivedAt).toBe(7);
    await expect(storage.backfillReceivedAt({ receivedAt: now + 1 })).rejects.toThrow("anchor");
  });
  it("expires linked payloads but retains receipt deduplication, conflicts and provider status", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now); const { watch, client, db } = setup();
    await watch.ingest([bug()]); await watch.processBugIssues();
    clock.mockReturnValue(now + 101); expect((await watch.cleanupRetention()).deleted).toBe(1);
    expect(await watch.query({})).toEqual([]);
    await watch.ingest([bug()]); await watch.processBugIssues();
    expect(await watch.query({})).toEqual([]); expect(client.request).toHaveBeenCalledTimes(1);
    expect(await watch.getBugIssueStatus({ app: "web", reportId: "one" })).toMatchObject({ state: "linked", issueId: "7" });
    await expect(watch.ingest([{ ...bug(), report: { ...bug().report, title: "changed" } }])).rejects.toThrow("conflicts");
    expect(await db.findMany({ model: BUG_ISSUES_TABLE, where: [] })).toHaveLength(1);
  });
  it("protects pending, processing, reconciliation, foreign and missing managed receipts", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now); const { watch, db } = setup();
    for (const id of ["pending", "processing", "reconciliation", "foreign", "missing"]) await watch.ingest([bug(id)]);
    for (const state of ["processing", "reconciliation"]) await db.updateMany({ model: BUG_ISSUES_TABLE, where: [{ field: "reportId", operator: "eq", value: state }], data: { state } });
    await db.updateMany({ model: BUG_ISSUES_TABLE, where: [{ field: "reportId", operator: "eq", value: "foreign" }], data: { state: "linked", namespace: "other" } });
    await db.deleteMany({ model: BUG_ISSUES_TABLE, where: [{ field: "reportId", operator: "eq", value: "missing" }] });
    clock.mockReturnValue(now + 101); expect(await watch.cleanupRetention()).toMatchObject({ scanned: 5, deleted: 0, retained: 5 });
    const noOutbox = new DatabaseStorage(db, "watchfn_events", undefined, { apps: ["web"], defaultTtlMs: 1 });
    expect((await noOutbox.cleanupRetention()).deleted).toBe(0);
  });
  it("uses bounded resumable scans, including retained-only pages, without touching other apps", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now); const db = memoryAdapter(); const storage = new DatabaseStorage(db, "watchfn_events", undefined, { apps: ["web"], defaultTtlMs: 1 });
    for (const id of ["a", "b", "c", "d", "e"]) await db.create({ model: "watchfn_events", data: { id, payload: JSON.stringify(bug(id, id < "c" ? "other" : "web")), receivedAt: now } });
    clock.mockReturnValue(now + 2);
    expect(await storage.cleanupRetention({ limit: 2 })).toEqual({ scanned: 2, deleted: 0, retained: 2, nextCursor: "b" });
    expect(await storage.cleanupRetention({ after: "b", limit: 2 })).toEqual({ scanned: 2, deleted: 2, retained: 0, nextCursor: "d" });
    expect(await storage.cleanupRetention({ after: "d", limit: 2 })).toEqual({ scanned: 1, deleted: 1, retained: 0, nextCursor: null });
    expect((await storage.getAll()).map(row => row.id)).toEqual(["a", "b"]);
    await expect(storage.cleanupRetention({ limit: 1001 })).rejects.toThrow("Invalid");
  });
  it("drains admitted cleanup on stop and keeps partial failure retryable", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now); const { watch, db } = setup();
    await watch.ingest([{ type: "log", app: { name: "web" } }, { type: "log", app: { name: "web" } }]);
    clock.mockReturnValue(now + 101);
    const transaction = db.transaction.bind(db); let attempts = 0;
    const faulty = vi.spyOn(db, "transaction").mockImplementation(callback => transaction(tx => callback({ ...tx, deleteMany: async params => { if (++attempts === 2) throw new Error("delete interrupted"); return tx.deleteMany(params); } } as any)));
    await expect(watch.cleanupRetention()).rejects.toThrow("delete interrupted");
    await expect(watch.flush()).rejects.toThrow("storage operations failed");
    expect(await watch.query({})).toHaveLength(1); faulty.mockRestore();
    let release!: () => void;
    vi.spyOn(db, "transaction").mockImplementation(async callback => { await new Promise<void>(resolve => { release = resolve; }); return transaction(callback); });
    const cleanup = watch.cleanupRetention(); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    let stopped = false; const stop = watch.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    release(); expect((await cleanup).deleted).toBe(1); await stop;
    expect(await watch.query({})).toEqual([]); await expect(watch.cleanupRetention()).rejects.toThrow("unavailable");
  });
  it("snapshots the trusted app allowlist and TTL instead of following caller mutations", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now); const config = { apps: ["web"], defaultTtlMs: 1 };
    const storage = new DatabaseStorage(memoryAdapter(), "watchfn_events", undefined, config);
    await storage.add(bug("web")); await storage.add(bug("other", "other"));
    config.apps[0] = "other"; config.defaultTtlMs = 100000;
    clock.mockReturnValue(now + 2);
    expect((await storage.cleanupRetention()).deleted).toBe(1);
    expect((await storage.getAll()).map(row => row.id)).toEqual(["other"]);
  });
  it("fails closed for unsupported storage/config and observes cleanup failure through flush", async () => {
    const db = memoryAdapter();
    expect(() => new DatabaseStorage({ ...db, capabilities: { transactions: { supported: false } } } as any, "watchfn_events", undefined, { apps: ["web"] })).toThrow("transactional");
    expect(() => new WatchFn({ name: "bad", retention: { apps: ["web"] } } as any)).toThrow("database");
    for (const config of [{ apps: [] }, { apps: ["web"], defaultTtlMs: 0 }, { apps: ["web"], bugReportTtlMs: NaN }]) expect(() => new DatabaseStorage(db, "watchfn_events", undefined, config)).toThrow();
    const { watch } = setup(db); vi.spyOn(db, "findMany").mockRejectedValue(new Error("storage unavailable"));
    await expect(watch.cleanupRetention()).rejects.toThrow("storage unavailable");
    await expect(watch.flush()).rejects.toThrow("storage operations failed");
  });
});

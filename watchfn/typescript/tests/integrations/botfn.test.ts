import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters/memory";
import { WatchFn } from "../../src/core/watch-fn";
import { BUG_ISSUES_TABLE } from "../../src/integrations/botfn/schema";
import { createBotFnIssue, verifyBotFnIssue, issueBody } from "../../src/integrations/botfn/provider";

export const bug = (id = "report-1") => ({ id, type: "bug_report", timestamp: "2026-10-20T00:00:00Z", app: { name: "web" }, sessionId: "session", report: { title: "Broken checkout", description: "Details", severity: "high" }, context: { private: "not for provider" } });
const active: WatchFn[] = [];
const request = (body: unknown, key = "ingest-secret") => new Request("http://local/ingest", { method: "POST", headers: { "x-api-key": key }, body: JSON.stringify(body) });
function setup(db = memoryAdapter(), client: any = { request: vi.fn(async (_path: string, options: RequestInit) => ({ number: 7, html_url: "https://github.com/acme/bugs/issues/7", body: JSON.parse(options.body as string).body })) }, extra: any = {}) {
  const options: any = { name: "bugs", storage: "database", database: db, auth: { apiKey: "ingest-secret" }, infra: { enabled: false }, botfn: { namespace: "tenant-1", routes: [{ app: "web", target: "github", project: "acme/bugs", client }], ...extra } };
  const watch = new WatchFn(options); watch.start(); active.push(watch); return { watch, db, client, options };
}
afterEach(async () => { for (const watch of active.splice(0)) { await watch.flush().catch(() => {}); await watch.stop(); } });

describe("canonical bug issue outbox", () => {
  it("requires authenticated shared transactional storage; plain memory is not a durability boundary", () => {
    const { options } = setup();
    for (const change of [{ storage: "memory" }, { auth: {} }, { auth: { enabled: false, apiKey: "x" } }, { database: { insertEvent() {}, queryEvents() {} } }]) expect(() => new WatchFn({ ...options, ...change })).toThrow();
    expect(() => new WatchFn({ ...options, database: { ...memoryAdapter(), capabilities: { transactions: { supported: false } } } })).toThrow();
  });
  it("authenticates, validates all routes before writes, and rejects client-supplied linkage", async () => {
    const { watch } = setup();
    expect((await watch.httpRouter.handle(request(bug(), "bad"))).status).toBe(401);
    for (const hint of [{ target: "github", project: "attacker/repo" }, { issueId: "7", issueUrl: "https://evil.test" }, { target: "discord" }]) {
      expect((await watch.httpRouter.handle(request([bug("valid"), { ...bug(), integration: hint }]))).status).toBe(400);
    }
    expect(await watch.query({})).toEqual([]);
  });
  it("deduplicates canonical IDs, persists provider linkage, and never forwards context or saves credentials", async () => {
    const { watch, db, client } = setup();
    expect((await watch.httpRouter.handle(request(bug()))).status).toBe(202);
    expect((await watch.httpRouter.handle(request(bug()))).status).toBe(202);
    expect(await watch.query({})).toHaveLength(1);
    expect(await watch.getBugIssueStatus({ app: "web", reportId: "report-1" })).toMatchObject({ state: "pending", attempts: 0 });
    await watch.processBugIssues();
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(client.request.mock.calls)).not.toContain("not for provider");
    expect(await watch.query({})).toEqual([{ ...bug(), integration: { target: "github", project: "acme/bugs", issueId: "7", issueUrl: "https://github.com/acme/bugs/issues/7" } }]);
    expect((await watch.httpRouter.handle(request(bug()))).status).toBe(202);
    expect((await watch.httpRouter.handle(request({ ...bug(), context: { changed: true } }))).status).toBe(409);
    const persisted = JSON.stringify(await db.findMany({ model: BUG_ISSUES_TABLE, where: [] }));
    expect(persisted).not.toContain("ingest-secret"); expect(persisted).not.toContain("client");
  });
  it("rolls back the event when transactional outbox persistence fails", async () => {
    const db = memoryAdapter(); const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementation(async callback => transaction(async tx => callback({ ...tx, create: async params => { if (params.model === BUG_ISSUES_TABLE) throw new Error("private SQL password"); return tx.create(params); } } as any)));
    const { watch } = setup(db);
    const response = await watch.httpRouter.handle(request(bug()));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("password");
    expect(await watch.query({})).toEqual([]); expect(await db.findMany({ model: BUG_ISSUES_TABLE, where: [] })).toEqual([]);
  });
  it("keeps per-event batch commits explicit when a later duplicate conflicts", async () => {
    const { watch } = setup(); await watch.ingest([bug()]);
    const response = await watch.httpRouter.handle(request([bug("earlier"), { ...bug(), context: {} }, bug("later")]));
    expect(response.status).toBe(409);
    expect((await watch.query({})).map((row: any) => row.id).sort()).toEqual(["earlier", "report-1"]);
  });
  it("uses CAS claims across workers and keeps tenant namespaces independent", async () => {
    const db = memoryAdapter(); let release!: () => void;
    const client = { request: vi.fn(async (_path: string, options: RequestInit) => { await new Promise<void>(resolve => { release = resolve; }); return { number: 7, html_url: "https://github.com/acme/bugs/issues/7", body: JSON.parse(options.body as string).body }; }) };
    const first = setup(db, client).watch; const second = setup(db, client).watch;
    await first.ingest([bug()]); const processing = first.processBugIssues();
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(1));
    expect(await second.processBugIssues()).toEqual({ processed: 0 }); release(); await processing;
    const other = setup(db, undefined, { namespace: "tenant-2" }).watch;
    expect(await other.getBugIssueStatus({ app: "web", reportId: "report-1" })).toBeNull(); await other.ingest([bug()]);
    expect(await other.getBugIssueStatus({ app: "web", reportId: "report-1" })).toMatchObject({ state: "pending" });
  });
  it("parks unknown outcomes and verifies marker, repo and URL before reconciliation", async () => {
    let body = "";
    const client = { request: vi.fn(async (_path: string, options: RequestInit) => { if (options.method === "POST") { body = JSON.parse(options.body as string).body; throw new Error("connection lost after remote commit"); } return { number: 9, html_url: "https://github.com/acme/bugs/issues/9", body }; }) };
    const { watch } = setup(undefined, client); await watch.ingest([bug()]); await watch.processBugIssues(); await watch.processBugIssues();
    expect(client.request).toHaveBeenCalledTimes(1);
    const ref = { app: "web", reportId: "report-1" };
    expect(await watch.getBugIssueStatus(ref)).toMatchObject({ state: "reconciliation", failure: "provider_outcome_unknown" });
    client.request.mockResolvedValueOnce({ number: 9, body, html_url: "https://evil.test/acme/bugs/issues/9" });
    await expect(watch.reconcileBugIssue(ref, "9")).rejects.toThrow();
    expect(await watch.reconcileBugIssue(ref, "9")).toBe(true);
    expect(await watch.getBugIssueStatus(ref)).toMatchObject({ state: "linked", issueId: "9" });
  });
  it("parks expired claims without issuing creates", async () => {
    const { watch, db, client } = setup(); await watch.ingest([bug()]);
    await db.updateMany({ model: BUG_ISSUES_TABLE, where: [], data: { state: "processing", leaseExpiresAt: 1, leaseToken: "old", revision: 3 } });
    await watch.processBugIssues(); expect(client.request).not.toHaveBeenCalled();
    expect(await watch.getBugIssueStatus({ app: "web", reportId: "report-1" })).toMatchObject({ state: "reconciliation", failure: "lease_expired" });
  });
  it("fences a late successful create after another worker expires its lease", async () => {
    const db = memoryAdapter(); let release!: () => void;
    const client = { request: vi.fn(async (_path: string, options: RequestInit) => {
      await new Promise<void>(resolve => { release = resolve; });
      return { number: 7, html_url: "https://github.com/acme/bugs/issues/7", body: JSON.parse(options.body as string).body };
    }) };
    const first = setup(db, client).watch; const second = setup(db, client).watch;
    await first.ingest([bug()]); const pending = first.processBugIssues();
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(1));
    await db.updateMany({ model: BUG_ISSUES_TABLE, where: [], data: { leaseExpiresAt: 1 } });
    await second.processBugIssues(); release(); await pending;
    expect(await first.getBugIssueStatus({ app: "web", reportId: "report-1" })).toMatchObject({ state: "reconciliation", failure: "lease_expired", issueId: null });
    expect((await first.query({}))[0].integration).toBeUndefined();
    expect(client.request).toHaveBeenCalledTimes(1);
  });
  it("awaits scheduled provider work during stop and rejects new worker calls while stopped", async () => {
    let release!: () => void;
    const client = { request: vi.fn(async (_path: string, options: RequestInit) => {
      await new Promise<void>(resolve => { release = resolve; });
      return { number: 7, html_url: "https://github.com/acme/bugs/issues/7", body: JSON.parse(options.body as string).body };
    }) };
    const { watch } = setup(undefined, client); await watch.ingest([bug()]);
    const processing = watch.processBugIssues(); await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(1));
    let stopped = false; const stop = watch.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    await expect(watch.processBugIssues()).rejects.toThrow("unavailable");
    release(); await processing; await stop;
    expect(await watch.getBugIssueStatus({ app: "web", reportId: "report-1" })).toMatchObject({ state: "linked" });
  });
  it.each([
    { number: 9, html_url: "https://github.com/acme/bugs/issues/9", body: "wrong marker" },
    { number: 8, html_url: "https://github.com/acme/bugs/issues/8", body: "<!-- watchfn-bug:report -->" },
    { number: 9, html_url: "https://github.com/acme/bugs/issues/9", body: "<!-- watchfn-bug:report -->", pull_request: {} },
    { number: 9, html_url: "https://github.com/acme/bugs/issues/9?token=secret", body: "<!-- watchfn-bug:report -->" },
  ])("rejects a mismatched GitHub reconciliation receipt", async receipt => {
    const route: any = { app: "web", target: "github", project: "acme/bugs", client: { request: async () => receipt } };
    await expect(verifyBotFnIssue(route, "9", "report", new AbortController().signal)).rejects.toThrow();
  });
  it.each([
    { success: false },
    { success: true, issue: { id: "one", identifier: "ENG-1", url: "https://linear.app/acme/issue/ENG-1", description: "<!-- watchfn-bug:report -->", team: { id: "other-team" } } },
    { success: true, issue: { id: "one", identifier: "ENG-1", url: "https://evil.test/acme/issue/ENG-1", description: "<!-- watchfn-bug:report -->", team: { id: "trusted-team" } } },
    { success: true, issue: { id: "one", identifier: "ENG-1", url: "https://linear.app/acme/issue/ENG-1", description: "wrong marker", team: { id: "trusted-team" } } },
  ])("does not link an invalid Linear creation response", async issueCreate => {
    const route: any = { app: "web", target: "linear", project: "trusted-team", client: { request: async () => ({ issueCreate }) } };
    await expect(createBotFnIssue(route, bug(), "report", new AbortController().signal)).rejects.toThrow();
  });
  it("bounds a hanging client, never automatically retries, and removes client-forged markers", async () => {
    const client = { request: vi.fn(() => new Promise(() => {})) };
    const { watch } = setup(undefined, client, { timeoutMs: 10, leaseMs: 200 });
    await watch.ingest([bug()]); await watch.processBugIssues(); await watch.processBugIssues();
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(await watch.getBugIssueStatus({ app: "web", reportId: "report-1" })).toMatchObject({ state: "reconciliation" });
    expect(issueBody({ ...bug(), report: { ...bug().report, description: "<!-- watchfn-bug:forged -->" } }, "own")).not.toContain("watchfn-bug:forged");
  });
});

import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters/memory";
import { WatchFn } from "../../src/core/watch-fn";
import { BrowserClient } from "../../../agents/browser/src/index";

const report = () => ({ id: "bug-one", type: "bug_report", timestamp: "2026-10-20T00:00:00.000Z",
  app: { name: "checkout", version: "1" }, sessionId: "session-one",
  report: { title: "Checkout failed", description: "After clicking", steps: ["Open", "Pay"], severity: "high", tags: ["checkout"] },
  context: { custom: { nested: ["value"] } }, attachments: [{ id: "attachment", url: "https://example.test/image" }],
  user: { id: "user-one" }, integration: { issueId: "issue-one" }, replayId: "replay-one" });
const active: WatchFn[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(active.splice(0).map(watch => watch.stop()));
});
function setup() {
  const database = memoryAdapter();
  const watch = new WatchFn({ name: "bugs", storage: "database", database, infra: { enabled: false }, auth: { apiKey: "key" } } as any);
  active.push(watch); watch.start(); return { watch, database };
}
async function serve(watch: WatchFn) {
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const result = await watch.httpRouter.handle(new Request("http://local" + request.url, {
        method: request.method, headers: request.headers as HeadersInit, body: Buffer.concat(chunks),
      }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch { response.writeHead(500); response.end(); }
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/ingest`;
}
const request = (events: unknown) => new Request("http://local/ingest", { method: "POST", headers: { authorization: "Bearer key" }, body: JSON.stringify(events) });

describe("canonical bug report ingestion", () => {
  it("delivers through the browser client and actual HTTP into shared storage without changing the envelope", async () => {
    const { watch } = setup();
    const client = new BrowserClient({ endpoint: await serve(watch), projectId: "ignored-project", apiKey: "key", autoTrack: false, sampleRate: 0, retries: 0 });
    const event = report();
    await client.capture(event);
    expect(await watch.query({ metric: "bug_report" })).toEqual([event]);
    // Arrival identity is independent of the producer ID: replay is at least once.
    await client.capture(event);
    expect(await watch.query({ metric: "bug_report" })).toEqual([event, event]);
    await client.close();
  });

  it("rejects authentication and storage failures, retains capture, and waits for persistence on retry", async () => {
    const { watch, database } = setup();
    let key = "wrong";
    const client = new BrowserClient({ endpoint: await serve(watch), projectId: "project", apiKey: () => key, autoTrack: false, retries: 0 });
    await expect(client.capture(report())).rejects.toMatchObject({ status: 401 });
    expect(await watch.query({})).toEqual([]);
    key = "key";
    const original = database.create.bind(database);
    const create = vi.spyOn(database, "create").mockRejectedValueOnce(new Error("private database error"));
    await expect(client.flush()).rejects.toMatchObject({ status: 503 });
    expect(client.pendingCount).toBe(1);
    await expect(watch.flush()).rejects.toThrow("WatchFn storage operations failed");
    let release!: () => void;
    create.mockImplementationOnce(async options => { await new Promise<void>(resolve => { release = resolve; }); return original(options); });
    let done = false;
    const pending = client.flush().then(() => { done = true; });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(done).toBe(false);
    expect(await watch.query({})).toEqual([]);
    release(); await pending;
    expect(await watch.query({})).toEqual([report()]);
    await client.close();
  });

  it.each([
    { id: "" }, { timestamp: "not-a-date" }, { timestamp: 123 }, { app: {} }, { sessionId: " " },
    { report: { title: "Title", severity: "unknown" } }, { report: { severity: "high" } },
    { report: { title: "Title", severity: "high", steps: "click" } }, { context: [] }, { context: null },
  ])("validates a canonical batch before any persistence: %j", async patch => {
    const { watch } = setup();
    const response = await watch.httpRouter.handle(request([{ name: "valid-log" }, { ...report(), ...patch }]));
    expect(response.status).toBe(400);
    expect(await watch.query({})).toEqual([]);
  });

  it("keeps ordinary event name validation and the common event-size bound", async () => {
    const { watch } = setup();
    expect((await watch.httpRouter.handle(request({ type: "track", properties: {} }))).status).toBe(400);
    expect((await watch.httpRouter.handle(request({ ...report(), context: { huge: "😀".repeat(17000) } }))).status).toBe(413);
    expect(await watch.query({})).toEqual([]);
  });
});

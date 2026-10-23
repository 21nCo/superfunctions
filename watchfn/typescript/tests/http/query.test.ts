import { afterEach, expect, it, vi } from "vitest";
import { WatchFn } from "../../src/core/watch-fn";

const active: WatchFn[] = [];
function setup(options: Record<string, unknown> = {}) {
  const watch = new WatchFn({ name: "query-test", storage: "memory", infra: { enabled: false }, auth: { enabled: false }, ...options } as any);
  active.push(watch); watch.start(); return watch;
}
function request(body: unknown, headers?: HeadersInit) {
  return new Request("http://localhost/query", { method: "POST", headers, body: JSON.stringify(body) });
}
afterEach(() => { for (const watch of active.splice(0)) watch.stop(); });

it("returns actual stored events with canonical filtering, ordering and limits", async () => {
  const watch = setup();
  await watch.ingest([
    { name: "duration", timestamp: "2026-10-20T00:00:00Z", properties: { duration: 10, endpoint: "/users" }, traceId: "a" },
    { name: "duration", timestamp: "2026-10-20T01:00:00Z", properties: { duration: 20, endpoint: "/users" }, traceId: "b" },
    { name: "duration", timestamp: "2026-10-19T01:00:00Z", properties: { duration: 30, endpoint: "/other" }, traceId: "c" },
  ]);
  const options = { metric: "duration", where: { endpoint: "/users", duration: { gt: 5 } },
    timeRange: { from: "2026-10-20T00:00:00Z", to: "2026-10-20T23:59:59Z" },
    orderBy: { field: "duration", direction: "desc" }, limit: 1 };
  const response = await watch.httpRouter.handle(request(options));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ results: await watch.query(options) });
  const empty = await watch.httpRouter.handle(request({ metric: "absent" }));
  expect(empty.status).toBe(200); expect(await empty.json()).toEqual({ results: [] });
});

it("checks configured keys before reading query bodies or accessing storage", async () => {
  const watch = setup({ auth: { apiKey: "secret" } });
  const query = vi.spyOn(watch, "query");
  const req = new Request("http://localhost/query", { method: "POST", body: "invalid" });
  expect((await watch.httpRouter.handle(req)).status).toBe(401);
  expect(req.bodyUsed).toBe(false); expect(query).not.toHaveBeenCalled();
  for (const headers of [{ authorization: "Bearer secret" }, { "x-api-key": "secret" }]) {
    expect((await watch.httpRouter.handle(request({}, headers))).status).toBe(200);
  }
});

it("fails closed when authentication is enabled without a key", async () => {
  const watch = setup({ auth: { enabled: true } });
  const query = vi.spyOn(watch, "query");
  expect((await watch.httpRouter.handle(request({}))).status).toBe(401);
  expect(query).not.toHaveBeenCalled();
});

it.each([null, [], "query", 1])("rejects non-object query %j without executing", async body => {
  const watch = setup(); const query = vi.spyOn(watch, "query");
  expect((await watch.httpRouter.handle(request(body))).status).toBe(400);
  expect(query).not.toHaveBeenCalled();
});

it.each([{ limit: -1 }, { orderBy: { field: "name", direction: "invalid" } },
  { timeRange: "invalid-range" }, { timeRange: { from: "2026-10-21", to: "2026-10-20" } },
  { where: { name: { unknown: true } } }])("returns 400 for invalid query semantics %j", async body => {
  const queryEvents = vi.fn(async () => []);
  const watch = setup({ storage: "database", database: { insertEvent: async () => {}, queryEvents } });
  const response = await watch.httpRouter.handle(request(body));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Invalid query" });
  expect(queryEvents).not.toHaveBeenCalled();
});

it("awaits the database and sanitizes storage failures", async () => {
  let reject!: (error: Error) => void;
  const queryEvents = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
  const watch = setup({ storage: "database", database: { insertEvent: async () => {}, queryEvents } });
  let finished = false;
  const pending = watch.httpRouter.handle(request({})).then(response => { finished = true; return response; });
  await vi.waitFor(() => expect(queryEvents).toHaveBeenCalledTimes(1));
  expect(finished).toBe(false); reject(new Error("secret connection credentials"));
  const response = await pending;
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "Query unavailable" });
});

it("bounds streamed bytes and rejects invalid JSON before query execution", async () => {
  const watch = setup(); const query = vi.spyOn(watch, "query");
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)); controller.close(); } });
  const large = new Request("http://localhost/query", { method: "POST", body, duplex: "half" } as RequestInit);
  expect((await watch.httpRouter.handle(large)).status).toBe(413);
  const invalid = new Request("http://localhost/query", { method: "POST", body: "{" });
  expect((await watch.httpRouter.handle(invalid)).status).toBe(400);
  expect(query).not.toHaveBeenCalled();
});

it("returns named aggregation rows from the shared query engine", async () => {
  const watch = setup();
  await watch.ingest([
    { name: "latency", properties: { endpoint: "/users", duration: 10 } },
    { name: "latency", properties: { endpoint: "/users", duration: 20 } },
  ]);
  const response = await watch.httpRouter.handle(request({ metric: "latency", groupBy: "endpoint",
    aggregations: { count: { operation: "count" }, mean: { operation: "avg", field: "duration" } } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ results: [{ endpoint: "/users", count: 2, mean: 15 }] });
});

it.each([{ storage: "hybrid" }, { storage: "database" }])("reports unavailable query backend as 503: %j", async config => {
  const watch = setup(config);
  const response = await watch.httpRouter.handle(request({}));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Query unavailable" });
});

it("permits stored readback after collection stops", async () => {
  const watch = setup();
  const event = { name: "retained", properties: { value: 1 } };
  await watch.ingest([event]); watch.stop();
  const response = await watch.httpRouter.handle(request({ metric: "retained" }));
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ results: [event] });
});

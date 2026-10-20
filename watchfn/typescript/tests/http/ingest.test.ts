import { afterEach, describe, expect, it, vi } from "vitest";
import { WatchFn } from "../../src/core/watch-fn";

const active: WatchFn[] = [];
function setup(options: Record<string, unknown> = {}) {
  const insertEvent = vi.fn(async (_event: unknown) => {});
  const watch = new WatchFn({ name: "ingest-test", storage: "database", database: {
    insertEvent, queryEvents: async () => [],
  }, infra: { enabled: false }, ...options } as any);
  active.push(watch);
  watch.start();
  return { watch, insertEvent };
}
function request(body: unknown, headers?: HeadersInit) {
  return new Request("http://localhost/ingest", { method: "POST", headers, body: JSON.stringify(body) });
}
afterEach(() => { for (const watch of active.splice(0)) watch.stop(); });

describe("HTTP ingestion", () => {
  it("preserves the complete envelope in all supported batch shapes", async () => {
    const { watch, insertEvent } = setup();
    const event = { name: "log", type: "log", v: 0, timestamp: "2026-10-20T00:00:00Z",
      message: "hello", level: "info", traceId: "abc", requestId: "req", ctx: { x: 1 }, tags: ["test"] };
    for (const body of [event, [event], { events: [event] }]) {
      const result = await watch.httpRouter.handle(request(body));
      expect(result.status).toBe(202);
      expect(await result.json()).toEqual({ accepted: 1 });
    }
    expect(insertEvent.mock.calls.map(([value]) => value)).toEqual([event, event, event]);
  });

  it("does not acknowledge until every persistence promise completes", async () => {
    const { watch, insertEvent } = setup();
    let release!: () => void;
    insertEvent.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    let settled = false;
    const response = watch.httpRouter.handle(request([{ name: "first" }, { name: "second" }]))
      .then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(insertEvent).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    release();
    expect((await response).status).toBe(202);
    expect(insertEvent).toHaveBeenCalledTimes(2);
  });

  it("returns 503 on storage rejection without exposing the error", async () => {
    const { watch, insertEvent } = setup();
    insertEvent.mockRejectedValueOnce(new Error("secret database credentials"));
    const result = await watch.httpRouter.handle(request({ name: "event" }));
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "Storage unavailable" });
  });

  it("reports partial persistence as failure and stops the remaining writes", async () => {
    const { watch, insertEvent } = setup();
    insertEvent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("offline"));
    const result = await watch.httpRouter.handle(request([
      { name: "first" }, { name: "second" }, { name: "third" },
    ]));
    expect(result.status).toBe(503);
    expect(insertEvent.mock.calls).toEqual([[{ name: "first" }], [{ name: "second" }]]);
  });

  it.each(["stopped", "missing"])("returns 503 for %s storage", async mode => {
    const { watch, insertEvent } = setup(mode === "missing" ? { storage: "hybrid" } : {});
    if (mode === "stopped") watch.stop();
    expect((await watch.httpRouter.handle(request({ name: "event" }))).status).toBe(503);
    expect(insertEvent).not.toHaveBeenCalled();
  });

  it("checks API keys before reading the body", async () => {
    const { watch, insertEvent } = setup({ auth: { apiKey: "secret" } });
    const bad = new Request("http://localhost/ingest", { method: "POST", body: "invalid json" });
    expect((await watch.httpRouter.handle(bad)).status).toBe(401);
    expect(bad.bodyUsed).toBe(false);
    expect(insertEvent).not.toHaveBeenCalled();
    for (const headers of [{ authorization: "Bearer secret" }, { "x-api-key": "secret" }]) {
      expect((await watch.httpRouter.handle(request({ name: "event" }, headers))).status).toBe(202);
    }
  });

  it("fails closed when authentication is enabled without a key", async () => {
    const { watch, insertEvent } = setup({ auth: { enabled: true } });
    expect((await watch.httpRouter.handle(request({ name: "event" }))).status).toBe(401);
    expect(insertEvent).not.toHaveBeenCalled();
  });

  it.each([null, [], { events: "invalid" }, [{ name: "valid" }, { name: " " }],
    [{ name: "valid" }, null], Array.from({ length: 501 }, () => ({ name: "event" }))])
    ("validates the whole batch before any write: %j", async body => {
      const { watch, insertEvent } = setup();
      expect((await watch.httpRouter.handle(request(body))).status).toBe(400);
      expect(insertEvent).not.toHaveBeenCalled();
    });

  it("enforces the per-event UTF-8 byte limit before writing any event", async () => {
    const { watch, insertEvent } = setup();
    const result = await watch.httpRouter.handle(request([{ name: "valid" }, { name: "large", message: "😀".repeat(17000) }]));
    expect(result.status).toBe(413);
    expect(insertEvent).not.toHaveBeenCalled();
  });

  it("limits streamed request bytes even without Content-Length", async () => {
    const { watch, insertEvent } = setup();
    const chunk = new TextEncoder().encode(" ".repeat(1024 * 1024));
    const body = new ReadableStream({ start(controller) {
      for (let i = 0; i < 9; i++) controller.enqueue(chunk);
      controller.close();
    } });
    const req = new Request("http://localhost/ingest", { method: "POST", body, duplex: "half" } as RequestInit);
    expect((await watch.httpRouter.handle(req)).status).toBe(413);
    expect(insertEvent).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON without persisting", async () => {
    const { watch, insertEvent } = setup();
    const req = new Request("http://localhost/ingest", { method: "POST", body: "{" });
    expect((await watch.httpRouter.handle(req)).status).toBe(400);
    expect(insertEvent).not.toHaveBeenCalled();
  });
});

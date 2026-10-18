import { describe, expect, it, vi } from "vitest";
import { watchLogsHandler } from "./watch.js";

const event = { ts: "2026-01-14T12:00:00.000Z", level: "info", msg: "saved", name: "test", version: "0" };
const request = (events: unknown[] = [event]) => new Request("https://example.test/watch/logs", {
  method: "POST", body: JSON.stringify({ events }),
});

describe("durable ingestion boundary", () => {
  it("does not acknowledge an unconfigured destination", async () => {
    expect((await watchLogsHandler()(request())).status).toBe(503);
  });
  it("waits for persistence and forwards authenticated request context", async () => {
    let finish!: () => void;
    const saved = new Promise<void>(resolve => { finish = resolve; });
    const ingest = vi.fn(() => saved);
    const req = request();
    const handler = watchLogsHandler({ ingest, auth: { verifyToken: async () => true } });
    let completed = false;
    const response = handler(req).then(value => { completed = true; return value; });
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledWith([event], req));
    expect(completed).toBe(false);
    finish();
    expect((await response).status).toBe(202);
  });
  it("reports the submitted count even if the destination consumes its array", async () => {
    const handler = watchLogsHandler({ ingest: events => { events.splice(0); } });
    expect(await (await handler(request())).json()).toEqual({ accepted: 1 });
  });
  it("fails closed on rejected auth and does not call the destination", async () => {
    const ingest = vi.fn();
    const handler = watchLogsHandler({ ingest, auth: { verifyToken: async () => { throw Error("secret"); } } });
    const response = await handler(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret");
    expect(ingest).not.toHaveBeenCalled();
  });
  it("returns retryable failure without leaking storage errors and allows a retry", async () => {
    const ingest = vi.fn().mockRejectedValueOnce(Error("db password")).mockResolvedValueOnce(undefined);
    const handler = watchLogsHandler({ ingest });
    const failed = await handler(request());
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("password");
    expect((await handler(request())).status).toBe(202);
    expect(ingest).toHaveBeenCalledTimes(2);
  });
  it.each([
    { level: "bogus" }, { ts: "yesterday" }, { ctx: [] }, { tags: [42] },
    { traceId: 42 }, { level: "toString" }, { tags: Array(21).fill("x") },
  ])("rejects the whole batch before writing an invalid event %j", async patch => {
    const ingest = vi.fn();
    expect((await watchLogsHandler({ ingest })(request([event, { ...event, ...patch }]))).status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });
  it("enforces UTF-8 byte limits even without Content-Length", async () => {
    const ingest = vi.fn();
    const body = JSON.stringify({ events: [{ ...event, msg: "🙂".repeat(100) }] });
    const handler = watchLogsHandler({ ingest, maxBodyBytes: body.length });
    const response = await handler(new Request("https://example.test", { method: "POST", body }));
    expect(response.status).toBe(413);
    expect(ingest).not.toHaveBeenCalled();
  });
  it("rejects unsupported methods before authentication or ingestion", async () => {
    const ingest = vi.fn();
    const verifyToken = vi.fn();
    const result = await watchLogsHandler({ ingest, auth: { verifyToken } })(new Request("https://example.test"));
    expect(result.status).toBe(405);
    expect(result.headers.get("Allow")).toBe("POST");
    expect(verifyToken).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });
  it.each([0, -1, Infinity, NaN, 1.5])("rejects invalid limits %s", value => {
    expect(() => watchLogsHandler({ maxBatch: value })).toThrow(RangeError);
    expect(() => watchLogsHandler({ maxBodyBytes: value })).toThrow(RangeError);
  });
});

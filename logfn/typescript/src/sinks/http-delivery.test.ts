import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sinkHttp } from "./http.js";
import type { LogEvent } from "../types.js";
const event = (msg: string): LogEvent => ({ ts: new Date().toISOString(), level: "info", msg, name: "delivery", version: "0" });
describe("HTTP delivery lifecycle", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
  it("flush waits for automatic delivery and drains logs appended while sending", async () => {
    let complete!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }))
      .mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    const sink = sinkHttp({ url: "https://example.test", batch: 1 });
    sink([event("first")]);
    sink([event("second")]);
    let finished = false;
    const flushed = sink.flush!().then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    complete(new Response(null, { status: 202 }));
    await flushed;
    expect(fetch.mock.calls.map(([, options]) => JSON.parse(options.body).events[0].msg)).toEqual(["first", "second"]);
  });
  it("manual flush exposes failure and retries the retained batch", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(Error("offline")).mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    const sink = sinkHttp({ url: "https://example.test", batch: 20, retry: { attempts: 1 } });
    sink([event("retained")]);
    await expect(sink.flush!()).rejects.toThrow("offline");
    await sink.flush!();
    expect(fetch.mock.calls.map(([, options]) => JSON.parse(options.body).events[0].msg)).toEqual(["retained", "retained"]);
  });
  it("does not retry permanent 4xx even when multiple attempts are configured", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    const sink = sinkHttp({ url: "https://example.test", batch: 20, retry: { attempts: 5 } });
    sink([event("bad")]);
    await expect(sink.flush!()).rejects.toThrow("400");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([408, 429, 503])("retries transient HTTP %s", async status => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status })).mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    const sink = sinkHttp({ url: "https://example.test", batch: 20, retry: { attempts: 2, backoffMs: 0 } });
    sink([event("retry")]);
    const flushed = sink.flush!();
    await vi.runAllTimersAsync();
    await flushed;
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("gives every retry a fresh timeout and abort signal", async () => {
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_url, options) => {
      signals.push(options.signal);
      if (signals.length === 2) return Promise.resolve(new Response(null, { status: 202 }));
      return new Promise<Response>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("expired", "AbortError"))));
    });
    vi.stubGlobal("fetch", fetch);
    const sink = sinkHttp({ url: "https://example.test", batch: 20, timeoutMs: 10, retry: { attempts: 2, backoffMs: 0 } });
    sink([event("timeout")]);
    const flushed = sink.flush!();
    await vi.runAllTimersAsync();
    await flushed;
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });
  it("never sends more events than the configured batch size", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    const sink = sinkHttp({ url: "https://example.test", batch: 2 });
    sink(Array.from({ length: 5 }, (_, i) => event(String(i))));
    await sink.flush!();
    expect(fetch.mock.calls.map(([, options]) => JSON.parse(options.body).events.length)).toEqual([2, 2, 1]);
  });
});

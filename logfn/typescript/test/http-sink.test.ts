import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sinkHttp, type HttpSinkFetch, type HttpSinkRequest, type LogEvent } from "../src/index.js";

const URL = "https://logs.example.com/ingest";

const event = (msg: string, overrides: Partial<LogEvent> = {}): LogEvent => ({
  ts: "2026-01-14T12:00:00.000Z",
  level: "info",
  msg,
  name: "test",
  version: "0",
  ...overrides,
});

type Reply = { ok: boolean; status: number; statusText?: string } | Error | "hang";

function scriptedFetch(...replies: Reply[]) {
  const requests: HttpSinkRequest[] = [];
  const fetch = vi.fn<HttpSinkFetch>((_url, init) => {
    requests.push(init);
    const reply = replies.length > 1 ? replies.shift()! : replies[0] ?? { ok: true, status: 200 };
    if (reply === "hang") return new Promise(() => {});
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(reply);
  });
  const sentMessages = () =>
    requests.map((request) => (JSON.parse(request.body) as { events: LogEvent[] }).events.map((e) => e.msg));
  return { fetch, requests, sentMessages };
}

const ok = { ok: true, status: 200 };

describe("sinkHttp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("construction", () => {
    it("performs no request until events are queued and due", async () => {
      const { fetch } = scriptedFetch(ok);
      const sink = sinkHttp({ url: URL, fetch });
      await vi.runAllTimersAsync();
      await sink.flush();
      expect(fetch).not.toHaveBeenCalled();
      expect(sink.stats()).toEqual({ queued: 0, inFlight: 0, sent: 0, dropped: 0, failedBatches: 0 });
    });

    it.each([
      ["relative url", { url: "/ingest" }, /absolute http\(s\) URL/],
      ["non-http url", { url: "ftp://logs.example.com" }, /absolute http\(s\) URL/],
      ["url credentials", { url: "https://user:pw@logs.example.com" }, /must not contain credentials/],
      ["zero batch", { url: URL, batch: 0 }, /batch must be a positive integer/],
      ["fractional queue", { url: URL, maxQueue: 1.5 }, /maxQueue must be a positive integer/],
      ["zero attempts", { url: URL, retry: { attempts: 0 } }, /retry.attempts/],
      ["negative timeout", { url: URL, timeoutMs: -1 }, /timeoutMs/],
    ])("rejects %s", (_name, options, message) => {
      expect(() => sinkHttp(options)).toThrow(message);
    });
  });

  describe("batching", () => {
    it("sends a full batch immediately and a partial batch after the interval", async () => {
      const { fetch, sentMessages } = scriptedFetch(ok);
      const sink = sinkHttp({ url: URL, fetch, batch: 3, flushIntervalMs: 1000 });

      sink([event("1")]);
      sink([event("2")]);
      expect(fetch).not.toHaveBeenCalled();
      sink([event("3")]);
      await vi.advanceTimersByTimeAsync(0);
      expect(sentMessages()).toEqual([["1", "2", "3"]]);

      sink([event("4")]);
      await vi.advanceTimersByTimeAsync(999);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sentMessages()).toEqual([["1", "2", "3"], ["4"]]);
      expect(sink.stats().sent).toBe(4);
    });

    it("posts JSON with auth and custom headers", async () => {
      const { fetch, requests } = scriptedFetch(ok);
      const sink = sinkHttp({ url: URL, fetch, batch: 1, auth: { token: "tok" }, headers: { "X-Custom": "v" } });
      sink([event("m")]);
      await sink.flush();
      expect(fetch).toHaveBeenCalledWith(URL, expect.objectContaining({ method: "POST" }));
      expect(requests[0].headers).toEqual({
        "Content-Type": "application/json",
        "X-Custom": "v",
        Authorization: "Bearer tok",
      });
      expect(JSON.parse(requests[0].body)).toEqual({ events: [event("m")] });
    });

    it("sends the token only in secretHeader when one is configured", async () => {
      const { fetch, requests } = scriptedFetch(ok);
      const sink = sinkHttp({ url: URL, fetch, batch: 1, auth: { token: "k-1", secretHeader: "X-API-Key" } });
      sink([event("m")]);
      await sink.flush();
      expect(requests[0].headers["X-API-Key"]).toBe("k-1");
      expect(requests[0].headers.Authorization).toBeUndefined();
    });

    it("splits a large flush into batch-sized requests", async () => {
      const { sentMessages, fetch } = scriptedFetch(ok);
      const sink = sinkHttp({ url: URL, fetch, batch: 2, flushIntervalMs: 60_000 });
      sink([event("a")]);
      sink([event("b")]);
      sink([event("c"), event("d"), event("e")]);
      await sink.flush();
      expect(sentMessages()).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    });
  });

  describe("bounded queue", () => {
    it("drops the oldest events beyond maxQueue and reports them", async () => {
      const { fetch, sentMessages } = scriptedFetch(ok);
      const onDrop = vi.fn();
      const sink = sinkHttp({ url: URL, fetch, batch: 100, maxQueue: 3, onDrop });
      for (const msg of ["1", "2", "3", "4", "5"]) sink([event(msg)]);
      expect(sink.stats()).toMatchObject({ queued: 3, dropped: 2 });
      expect(onDrop).toHaveBeenCalledWith(1, "queue_full");
      await sink.flush();
      expect(sentMessages()).toEqual([["3", "4", "5"]]);
      expect(sink.stats()).toMatchObject({ queued: 0, sent: 3, dropped: 2 });
    });

    it("stays bounded while the collector is down", async () => {
      const { fetch } = scriptedFetch(new Error("ECONNREFUSED"));
      const onError = vi.fn();
      const sink = sinkHttp({ url: URL, fetch, batch: 10, maxQueue: 25, retry: { attempts: 2, backoffMs: 10 }, onError });
      for (let i = 0; i < 1000; i++) {
        sink([event(String(i))]);
        expect(sink.stats().queued).toBeLessThanOrEqual(25);
      }
      await vi.runAllTimersAsync();
      await sink.flush();
      const stats = sink.stats();
      expect(stats.queued + stats.inFlight).toBe(0);
      expect(stats.sent).toBe(0);
      expect(stats.dropped).toBe(1000);
      expect(onError).toHaveBeenCalled();
    });
  });

  describe("retries", () => {
    it("retries 5xx, 429 and network errors with backoff, then succeeds", async () => {
      const { fetch } = scriptedFetch(
        { ok: false, status: 503 },
        { ok: false, status: 429 },
        new Error("socket hang up"),
        ok
      );
      const sink = sinkHttp({ url: URL, fetch, batch: 1, retry: { attempts: 5, backoffMs: 100 } });
      sink([event("m")]);
      await vi.runAllTimersAsync();
      await sink.flush();
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(sink.stats()).toMatchObject({ sent: 1, dropped: 0, failedBatches: 0 });
    });

    it("does not retry other 4xx responses and drops the batch", async () => {
      const { fetch } = scriptedFetch({ ok: false, status: 400, statusText: "Bad Request" });
      const onError = vi.fn();
      const onDrop = vi.fn();
      const sink = sinkHttp({ url: URL, fetch, batch: 1, onError, onDrop });
      sink([event("m")]);
      await sink.flush();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "HTTP 400: Bad Request" }));
      expect(onDrop).toHaveBeenCalledWith(1, "delivery_failed");
      expect(sink.stats()).toMatchObject({ sent: 0, dropped: 1, failedBatches: 1 });
    });

    it("times out each attempt separately", async () => {
      const { fetch } = scriptedFetch("hang", "hang", ok);
      const sink = sinkHttp({ url: URL, fetch, batch: 1, timeoutMs: 50, retry: { attempts: 3, backoffMs: 10 } });
      sink([event("m")]);
      await vi.runAllTimersAsync();
      await sink.flush();
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(sink.stats()).toMatchObject({ sent: 1, dropped: 0 });
    });
  });

  describe("failure isolation", () => {
    it("never throws into the caller when fetch throws synchronously", async () => {
      const fetch = vi.fn<HttpSinkFetch>(() => {
        throw new Error("boom");
      });
      const onError = vi.fn();
      const sink = sinkHttp({ url: URL, fetch, batch: 1, retry: { attempts: 1 }, onError });
      expect(() => sink([event("m")])).not.toThrow();
      await expect(sink.flush()).resolves.toBeUndefined();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));
    });

    it("ignores failures in onError and onDrop callbacks", async () => {
      const { fetch } = scriptedFetch({ ok: false, status: 400 });
      const sink = sinkHttp({
        url: URL,
        fetch,
        batch: 1,
        maxQueue: 1,
        onError: () => {
          throw new Error("handler broke");
        },
        onDrop: () => {
          throw new Error("handler broke");
        },
      });
      expect(() => sink([event("1"), event("2")])).not.toThrow();
      await expect(sink.flush()).resolves.toBeUndefined();
    });

    it("reports a missing fetch instead of throwing", async () => {
      vi.stubGlobal("fetch", undefined);
      const onError = vi.fn();
      const sink = sinkHttp({ url: URL, batch: 1, onError });
      sink([event("m")]);
      await sink.flush();
      vi.unstubAllGlobals();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("fetch is not available") }));
      expect(sink.stats().dropped).toBe(1);
    });
  });

  describe("flush and close", () => {
    it("flush waits for an in-flight request and then sends what was queued meanwhile", async () => {
      let release!: () => void;
      const requests: string[][] = [];
      const fetch = vi.fn<HttpSinkFetch>((_url, init) => {
        requests.push((JSON.parse(init.body) as { events: LogEvent[] }).events.map((e) => e.msg));
        if (requests.length === 1) return new Promise((resolve) => (release = () => resolve(ok)));
        return Promise.resolve(ok);
      });
      const sink = sinkHttp({ url: URL, fetch, batch: 1, timeoutMs: 60_000 });
      sink([event("first")]);
      await vi.advanceTimersByTimeAsync(0);
      expect(sink.stats().inFlight).toBe(1);
      sink([event("second")]);
      const flushed = sink.flush();
      release();
      await flushed;
      expect(requests).toEqual([["first"], ["second"]]);
      expect(sink.stats()).toMatchObject({ queued: 0, inFlight: 0, sent: 2 });
    });

    it("close flushes and then drops later events", async () => {
      const { fetch, sentMessages } = scriptedFetch(ok);
      const onDrop = vi.fn();
      const sink = sinkHttp({ url: URL, fetch, onDrop });
      sink([event("before")]);
      await sink.close();
      sink([event("after")]);
      await sink.flush();
      expect(sentMessages()).toEqual([["before"]]);
      expect(onDrop).toHaveBeenCalledWith(1, "closed");
    });
  });

  it("queues redacted copies and leaves the caller's event untouched", async () => {
    const { fetch, requests } = scriptedFetch(ok);
    const sink = sinkHttp({ url: URL, fetch, batch: 1 });
    const original = event("token=abc", { ctx: { password: "pw" } });
    sink([original]);
    await sink.flush();
    expect(original).toEqual(event("token=abc", { ctx: { password: "pw" } }));
    expect(requests[0].body).not.toContain("abc");
    expect(requests[0].body).not.toContain('"pw"');
  });
});

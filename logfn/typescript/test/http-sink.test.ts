import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  MAX_EVENT_SIZE,
  sinkHttp,
  type HttpSinkFetch,
  type HttpSinkRequest,
  type LogEvent,
} from "../src/index.js";

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
      ["zero timeout", { url: URL, timeoutMs: 0 }, /timeoutMs must be a positive number/],
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

    it("prepares only the newest maxQueue events of an oversized batch", async () => {
      const { fetch, sentMessages } = scriptedFetch(ok);
      const onDrop = vi.fn();
      const sink = sinkHttp({ url: URL, fetch, batch: 100, maxQueue: 3, onDrop });
      let prepared = 0;
      const batch = ["1", "2", "3", "4", "5"].map((msg) =>
        event(msg, {
          ctx: {
            get counted() {
              prepared += 1;
              return msg;
            },
          },
        })
      );
      sink(batch);
      expect(prepared).toBe(3);
      expect(onDrop.mock.calls).toEqual([[2, "queue_full"]]);
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

  describe("response release", () => {
    function cancellable(status: number, type?: string) {
      const cancel = vi.fn(async () => {});
      return { response: { ok: status >= 200 && status < 300, status, type, body: { cancel } }, cancel };
    }

    it.each([
      ["2xx", [200]],
      ["retried 5xx then 2xx", [503, 200]],
      ["4xx", [400]],
      ["3xx", [302]],
      ["opaque redirect", [0]],
    ])("cancels the unread body of every %s response", async (_name, statuses) => {
      const replies = statuses.map((status) => cancellable(status, status === 0 ? "opaqueredirect" : undefined));
      const fetch = vi.fn<HttpSinkFetch>(async () => replies.shift()!.response);
      const cancels = replies.map((reply) => reply.cancel);
      const sink = sinkHttp({ url: URL, fetch, batch: 1, retry: { attempts: 2, backoffMs: 1 }, onError: () => {} });
      sink([event("m")]);
      await vi.runAllTimersAsync();
      await sink.flush();
      expect(fetch).toHaveBeenCalledTimes(statuses.length);
      for (const cancel of cancels) expect(cancel).toHaveBeenCalledTimes(1);
    });

    it("aborts a timed-out request and cancels a response that arrives after the timeout", async () => {
      let respond: (response: Awaited<ReturnType<HttpSinkFetch>>) => void = () => {};
      let signal: AbortSignal | undefined;
      const fetch = vi.fn<HttpSinkFetch>((_url, init) => {
        signal = init.signal;
        return new Promise((resolve) => (respond = resolve));
      });
      const sink = sinkHttp({ url: URL, fetch, batch: 1, timeoutMs: 50, retry: { attempts: 1 }, onError: () => {} });
      sink([event("m")]);
      await vi.advanceTimersByTimeAsync(60);
      await sink.flush();
      expect(signal?.aborted).toBe(true);
      expect(sink.stats()).toMatchObject({ sent: 0, dropped: 1 });
      const late = cancellable(200);
      respond(late.response);
      await vi.runAllTimersAsync();
      expect(late.cancel).toHaveBeenCalledTimes(1);
    });

    it("tolerates bodies that cannot be cancelled", async () => {
      const replies = [
        { ok: true, status: 200, body: { cancel: () => Promise.reject(new Error("locked")) } },
        { ok: true, status: 200, body: { cancel: () => { throw new Error("locked"); } } },
        { ok: true, status: 200, body: null },
      ];
      const fetch = vi.fn<HttpSinkFetch>(async () => replies.shift()!);
      const sink = sinkHttp({ url: URL, fetch, batch: 1 });
      for (const name of ["a", "b", "c"]) sink([event(name)]);
      await vi.runAllTimersAsync();
      await sink.flush();
      expect(sink.stats()).toMatchObject({ sent: 3, dropped: 0 });
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

    it("an event logged while flush awaits an in-flight batch is sent after the interval", async () => {
      let release!: () => void;
      const requests: string[][] = [];
      const fetch = vi.fn<HttpSinkFetch>((_url, init) => {
        requests.push((JSON.parse(init.body) as { events: LogEvent[] }).events.map((e) => e.msg));
        if (requests.length === 1) return new Promise((resolve) => (release = () => resolve(ok)));
        return Promise.resolve(ok);
      });
      const sink = sinkHttp({ url: URL, fetch, batch: 10, flushIntervalMs: 1000, timeoutMs: 60_000 });
      sink([event("first")]);
      const flushed = sink.flush();
      await vi.advanceTimersByTimeAsync(0);
      sink([event("during flush")]);
      release();
      await flushed;
      expect(requests).toEqual([["first"]]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(requests).toEqual([["first"], ["during flush"]]);
      expect(sink.stats()).toMatchObject({ queued: 0, sent: 2 });
    });

    it("flush settles events queued before the call even when a drain hands them to the next one", async () => {
      let release!: () => void;
      const requests: string[][] = [];
      const fetch = vi.fn<HttpSinkFetch>((_url, init) => {
        requests.push((JSON.parse(init.body) as { events: LogEvent[] }).events.map((e) => e.msg));
        if (requests.length === 1) return new Promise((resolve) => (release = () => resolve(ok)));
        return new Promise((resolve) => setTimeout(() => resolve(ok), 50));
      });
      const sink = sinkHttp({ url: URL, fetch, batch: 2, flushIntervalMs: 60_000, timeoutMs: 60_000 });
      sink([event("1"), event("2")]);
      sink([event("3"), event("4")]);
      await vi.advanceTimersByTimeAsync(0);
      expect(sink.stats()).toMatchObject({ queued: 2, inFlight: 2 });
      // Stats are read the moment flush resolves, not after the timers ran.
      const settled = sink.flush().then(() => sink.stats());
      release();
      await vi.advanceTimersByTimeAsync(100);
      expect(await settled).toMatchObject({ queued: 0, inFlight: 0, sent: 4, dropped: 0 });
      expect(requests).toEqual([["1", "2"], ["3", "4"]]);
    });

    it("close settles a handed-over batch through its retries before resolving", async () => {
      let release!: () => void;
      let calls = 0;
      const fetch = vi.fn<HttpSinkFetch>(() => {
        calls += 1;
        if (calls === 1) return new Promise((resolve) => (release = () => resolve(ok)));
        if (calls === 2) return Promise.resolve({ ok: false, status: 503 });
        return Promise.resolve(ok);
      });
      const onError = vi.fn();
      const sink = sinkHttp({ url: URL, fetch, batch: 2, flushIntervalMs: 60_000, onError });
      sink([event("1"), event("2")]);
      sink([event("3"), event("4")]);
      await vi.advanceTimersByTimeAsync(0);
      const closed = sink.close().then(() => sink.stats());
      release();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await closed).toEqual({ queued: 0, inFlight: 0, sent: 4, dropped: 0, failedBatches: 0 });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(onError).not.toHaveBeenCalled();
    });

    it("close resolves only after a failing handed-over batch is dropped and reported", async () => {
      let release!: () => void;
      let calls = 0;
      const fetch = vi.fn<HttpSinkFetch>(() => {
        calls += 1;
        if (calls === 1) return new Promise((resolve) => (release = () => resolve(ok)));
        return new Promise((resolve) => setTimeout(() => resolve({ ok: false, status: 400 }), 50));
      });
      const onError = vi.fn();
      const onDrop = vi.fn();
      const sink = sinkHttp({ url: URL, fetch, batch: 2, flushIntervalMs: 60_000, onError, onDrop });
      sink([event("1"), event("2")]);
      sink([event("3"), event("4")]);
      await vi.advanceTimersByTimeAsync(0);
      const closed = sink.close().then(() => sink.stats());
      release();
      await vi.advanceTimersByTimeAsync(100);
      expect(await closed).toEqual({ queued: 0, inFlight: 0, sent: 2, dropped: 2, failedBatches: 1 });
      expect(onDrop).toHaveBeenCalledWith(2, "delivery_failed");
      expect(onError).toHaveBeenCalledTimes(1);
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

    it("drops events of a batch whose preparation closed the sink", async () => {
      // Caller code run during preparation (a getter) can start close()
      // while a batch is being enqueued.
      const { fetch } = scriptedFetch(ok);
      const onDrop = vi.fn();
      const sink = sinkHttp({ url: URL, fetch, onDrop, batch: 1 });
      let closing: Promise<void> | undefined;
      const ctx = {
        get trigger() {
          closing = sink.close();
          return 1;
        },
      };
      sink([event("closing", { ctx }), event("after")]);
      await closing;
      await sink.flush();
      expect(fetch).not.toHaveBeenCalled();
      expect(onDrop.mock.calls).toEqual([[1, "closed"], [1, "closed"]]);
      expect(sink.stats()).toMatchObject({ queued: 0, sent: 0, dropped: 2 });
    });

    // fetch runs synchronously inside the drain, before its first await, so an
    // instrumented fetch that logs to the same sink must join that drain.
    it.each(["flush", "close"] as const)(
      "%s waits for an event a fetch logged to the same sink",
      async (method) => {
        let release!: () => void;
        const messages: string[][] = [];
        let sink!: ReturnType<typeof sinkHttp>;
        const fetch = vi.fn<HttpSinkFetch>((_url, init) => {
          messages.push((JSON.parse(init.body) as { events: LogEvent[] }).events.map((e) => e.msg));
          if (messages.length === 1) {
            sink([event("logged-by-fetch")]);
            return Promise.resolve(ok);
          }
          return new Promise((resolve) => (release = () => resolve(ok)));
        });
        sink = sinkHttp({ url: URL, fetch, batch: 1, timeoutMs: 60_000, onError: vi.fn() });
        sink([event("first")]);
        let settled = false;
        const done = sink[method]().then(() => {
          settled = true;
          return sink.stats();
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(settled).toBe(false);
        expect(sink.stats()).toEqual({ queued: 0, inFlight: 1, sent: 1, dropped: 0, failedBatches: 0 });
        release();
        expect(await done).toEqual({ queued: 0, inFlight: 0, sent: 2, dropped: 0, failedBatches: 0 });
        expect(messages).toEqual([["first"], ["logged-by-fetch"]]);
      }
    );

    it.each(["flush", "close"] as const)(
      "a fetch that calls %s on its own sink does not deadlock or miscount",
      async (method) => {
        let sink!: ReturnType<typeof sinkHttp>;
        let reentrant: Promise<void> | undefined;
        let reentrantSettled = false;
        const fetch = vi.fn<HttpSinkFetch>(() => {
          if (!reentrant) {
            sink([event("logged-by-fetch")]);
            reentrant = sink[method]().then(() => {
              reentrantSettled = true;
            });
          }
          return Promise.resolve(ok);
        });
        const onDrop = vi.fn();
        sink = sinkHttp({ url: URL, fetch, batch: 1, onDrop, onError: vi.fn() });
        sink([event("first")]);
        await vi.advanceTimersByTimeAsync(0);
        await reentrant;
        await sink.flush();
        expect(reentrantSettled).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(onDrop).not.toHaveBeenCalled();
        expect(sink.stats()).toEqual({ queued: 0, inFlight: 0, sent: 2, dropped: 0, failedBatches: 0 });
      }
    );

    it("an onError callback that logs and closes during a drain settles both events", async () => {
      let sink!: ReturnType<typeof sinkHttp>;
      let closing: Promise<void> | undefined;
      const { fetch, sentMessages } = scriptedFetch({ ok: false, status: 400 }, ok);
      const onDrop = vi.fn();
      sink = sinkHttp({
        url: URL,
        fetch,
        batch: 1,
        onDrop,
        onError: () => {
          sink([event("logged-by-onError")]);
          closing ??= sink.close();
        },
      });
      sink([event("first")]);
      await vi.advanceTimersByTimeAsync(0);
      await closing;
      expect(sentMessages()).toEqual([["first"], ["logged-by-onError"]]);
      expect(onDrop.mock.calls).toEqual([[1, "delivery_failed"]]);
      expect(sink.stats()).toEqual({ queued: 0, inFlight: 0, sent: 1, dropped: 1, failedBatches: 1 });
    });
  });

  describe("browser keepalive", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("is used only when the UTF-8 body is at most 60,000 bytes", async () => {
      vi.stubGlobal("window", {});
      const { fetch, requests } = scriptedFetch(ok);
      const sink = sinkHttp({ url: URL, fetch, batch: 2, flushIntervalMs: 60_000 });
      sink([event("small")]);
      await sink.flush();
      // 24,000 characters but 72,000 bytes: two events of 12,000 euro signs.
      sink([event("€".repeat(12_000)), event("€".repeat(12_000))]);
      await sink.flush();
      expect(requests.map((request) => request.keepalive)).toEqual([true, undefined]);
      expect(requests[1].body.length).toBeLessThan(60_000);
      expect(new TextEncoder().encode(requests[1].body).length).toBeGreaterThan(60_000);
    });
  });

  describe("what is sent is what was redacted", () => {
    it("redacts every field of a direct call, non-string values and keys included", async () => {
      const { fetch, requests } = scriptedFetch(ok);
      const sink = sinkHttp({ url: URL, fetch, batch: 1 });
      const leaky = { toJSON: () => "password=TOJSON_SECRET" };
      sink([
        {
          ...event("m"),
          tags: [{ token: "TAG_SECRET" }] as unknown as string[],
          userId: { password: "USER_SECRET" } as unknown as string,
          requestId: "access_token=REQ_SECRET",
          ctx: { leaky, count: 10n, ["https://u:KEY_PW@h.test"]: 1 },
          extra: { password: "EXTRA_SECRET" },
        } as LogEvent,
      ]);
      await sink.flush();
      expect(requests).toHaveLength(1);
      const body = requests[0].body;
      for (const secret of ["TOJSON_SECRET", "TAG_SECRET", "USER_SECRET", "REQ_SECRET", "KEY_PW", "EXTRA_SECRET"]) {
        expect(body).not.toContain(secret);
      }
      const [sent] = (JSON.parse(body) as { events: Array<Record<string, unknown>> }).events;
      expect(sent.ctx).toEqual({ leaky: { toJSON: "[unserializable]" }, count: "[unserializable]", "https://[redacted]@h.test": 1 });
      expect(sent.userId).toEqual({ password: "[redacted]" });
      expect(sent.extra).toEqual({ password: "[redacted]" });
    });

    it("sends no byte of binary data, called directly or through a logger", async () => {
      const text = (secret: string) => new TextEncoder().encode(`password=${secret}`);
      const binary = () => ({
        buffer: Buffer.from("password=BUFFER_SECRET"),
        u8: text("U8_SECRET"),
        f64: new Float64Array(text("F64_SECRET").buffer.slice(0, 16)),
        view: new DataView(text("VIEW_SECRET").buffer),
        array: text("ARRAYBUFFER_SECRET").buffer,
        shared: new SharedArrayBuffer(8),
        list: [text("LIST_SECRET")],
      });
      const unserializable = {
        buffer: "[unserializable]",
        u8: "[unserializable]",
        f64: "[unserializable]",
        view: "[unserializable]",
        array: "[unserializable]",
        shared: "[unserializable]",
        list: ["[unserializable]"],
      };
      const { fetch, requests } = scriptedFetch(ok);
      const sink = sinkHttp({ url: URL, fetch, batch: 1 });
      sink([{ ...event("direct"), ctx: binary(), tags: [text("TAG_SECRET")] as unknown as string[] }]);
      createLogger({ name: "svc", sinks: [sink] }).info("logged", binary());
      await sink.flush();
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        // Neither the text nor the bytes as numbers ("p", "a", "s" are 112, 97, 115).
        for (const secret of ["SECRET", "112,97,115"]) expect(request.body).not.toContain(secret);
        const [sent] = (JSON.parse(request.body) as { events: LogEvent[] }).events;
        expect(sent.ctx).toEqual(unserializable);
      }
      const [direct] = (JSON.parse(requests[0].body) as { events: LogEvent[] }).events;
      expect(direct.tags).toEqual(['"[unserializable]"']);
    });

    it("bounds the size of each queued event", async () => {
      const { fetch, requests } = scriptedFetch(ok);
      const sink = sinkHttp({ url: URL, fetch, batch: 1 });
      sink([event("m", { name: "n".repeat(70_000), requestId: "r".repeat(70_000) })]);
      await sink.flush();
      const [sent] = (JSON.parse(requests[0].body) as { events: LogEvent[] }).events;
      expect(new TextEncoder().encode(JSON.stringify(sent)).length).toBeLessThanOrEqual(MAX_EVENT_SIZE);
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

describe("sinkHttp against a real collector", () => {
  const servers: Server[] = [];

  async function listen(handler: (request: IncomingMessage, body: string) => [number, Record<string, string>?]) {
    const received: Array<{ method?: string; headers: IncomingMessage["headers"]; body: string }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received.push({ method: request.method, headers: request.headers, body });
        const [status, headers] = handler(request, body);
        response.writeHead(status, headers).end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/ingest`, received };
  }

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
      })
    );
  });

  // A collector that sends the status and the start of a body, then never
  // ends it. Tracks its unfinished responses and the open connections that
  // carried a request (fetch's dispatcher may also open spare connections that
  // never carry one and close on their own; those hold nothing of the sink's).
  async function listenHolding(statuses: number[]) {
    const sockets = new Set<Socket>();
    const responses = new Set<ServerResponse>();
    const server = createServer((request, response) => {
      const socket = request.socket;
      if (!socket.destroyed) {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      }
      request.resume();
      request.on("end", () => {
        const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
        response.writeHead(status, status >= 300 && status < 400 ? { Location: "http://127.0.0.1:1/" } : {});
        response.write("partial");
        responses.add(response);
        response.on("close", () => responses.delete(response));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/ingest`, sockets, responses };
  }

  async function settled(check: () => boolean, ms = 3000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    return check();
  }

  it.each([
    ["2xx", [200], { sent: 5, dropped: 0 }],
    ["5xx after retries", [503], { sent: 0, dropped: 5 }],
    ["5xx retried to 2xx", [503, 200, 503, 200, 503, 200, 503, 200, 503, 200], { sent: 5, dropped: 0 }],
    ["3xx", [302], { sent: 0, dropped: 5 }],
  ] as const)("releases every response and connection after a %s with a body held open", async (_name, statuses, stats) => {
    const collector = await listenHolding([...statuses]);
    const sink = sinkHttp({ url: collector.url, batch: 1, retry: { attempts: 2, backoffMs: 1 }, onError: () => {} });
    for (let index = 0; index < 5; index++) {
      sink([event(`m${index}`)]);
      await sink.flush();
    }
    await sink.close();
    expect(sink.stats()).toMatchObject(stats);
    expect(await settled(() => collector.responses.size === 0 && collector.sockets.size === 0)).toBe(true);
  });

  it.each([301, 302, 303, 307, 308])("does not follow a %i redirect to another origin", async (status) => {
    const other = await listen(() => [204]);
    const collector = await listen(() => [status, { Location: other.url }]);
    const onError = vi.fn();
    const onDrop = vi.fn();
    const sink = sinkHttp({
      url: collector.url,
      batch: 1,
      auth: { token: "COLLECTOR_TOKEN", secretHeader: "X-Api-Key" },
      retry: { attempts: 3, backoffMs: 1 },
      onError,
      onDrop,
    });
    sink([event("redirected")]);
    await sink.flush();
    expect(collector.received).toHaveLength(1);
    expect(collector.received[0].headers["x-api-key"]).toBe("COLLECTOR_TOKEN");
    expect(other.received).toEqual([]);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: `HTTP ${status}: redirects are not followed` })
    );
    expect(onDrop).toHaveBeenCalledWith(1, "delivery_failed");
    expect(sink.stats()).toMatchObject({ sent: 0, dropped: 1, failedBatches: 1 });
  });
});

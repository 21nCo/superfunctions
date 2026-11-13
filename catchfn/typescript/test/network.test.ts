import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkCollector } from "../src/collectors/network.js";
import { expectValidEvents } from "./schema-helper.js";

const SENSITIVE_HEADERS = ["authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token", "x-access-token"];

// A minimal XMLHttpRequest stand-in: open/send on the prototype, loadend
// dispatched when the test calls respond().
class FakeXhr extends EventTarget {
  status = 0;
  statusText = "";
  opened?: unknown[];
  sent?: unknown;
  respond(status: number, statusText: string) {
    this.status = status;
    this.statusText = statusText;
    this.dispatchEvent(new Event("loadend"));
  }
}
const pageOpen = vi.fn(function (this: FakeXhr, ...args: unknown[]) {
  this.opened = args;
});
const pageSend = vi.fn(function (this: FakeXhr, body?: unknown) {
  this.sent = body;
});
const proto = FakeXhr.prototype as unknown as { open: unknown; send: unknown };
Object.assign(proto, { open: pageOpen, send: pageSend });

const savedFetch = globalThis.fetch;
let pageFetch: ReturnType<typeof vi.fn>;
let collector: NetworkCollector;

beforeEach(() => {
  pageFetch = vi.fn(async () => new Response("ok", { status: 201, statusText: "Created", headers: { "set-cookie": "s=1", "x-trace": "t" } }));
  globalThis.fetch = pageFetch as unknown as typeof fetch;
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXhr;
  pageOpen.mockClear();
  pageSend.mockClear();
  proto.open = pageOpen;
  proto.send = pageSend;
  collector = new NetworkCollector();
});

afterEach(() => {
  expectValidEvents(collector.collect());
  collector.stop();
  globalThis.fetch = savedFetch;
  delete (globalThis as Record<string, unknown>).XMLHttpRequest;
});

describe("NetworkCollector fetch capture", () => {
  it("passes the page's fetch its original arguments while the captured URL omits the secret", async () => {
    collector.start();
    const response = await fetch("/api?token=relative-secret&safe=visible");
    expect(pageFetch.mock.calls).toEqual([["/api?token=relative-secret&safe=visible"]]);
    expect(response.status).toBe(201);
    const [event] = collector.collect();
    expect(event!.url).not.toContain("relative-secret");
    expect(event!.url).toContain("safe=visible");
    expect(event).toMatchObject({ schemaVersion: 1, kind: "network", transport: "fetch", method: "GET", status: 201, statusText: "Created" });
  });

  it("resolves to the page's own response object", async () => {
    const response = new Response("same");
    pageFetch.mockResolvedValue(response);
    collector.start();
    expect(await fetch("/same")).toBe(response);
  });

  it("does not consume one-shot iterable headers the application passes", async () => {
    collector.start();
    function* pairs() {
      yield ["authorization", "Bearer generated"] as [string, string];
    }
    const iterators: Array<Iterable<[string, string]>> = [
      new Map([["authorization", "Bearer map"]]).entries(),
      pairs(),
      new Headers({ authorization: "Bearer headers" }).entries(),
    ];
    for (const headers of iterators) await fetch("/api", { headers: headers as unknown as HeadersInit });
    const received = pageFetch.mock.calls.map(([, init]) => [...new Headers((init as RequestInit).headers)]);
    expect(received).toEqual([[["authorization", "Bearer map"]], [["authorization", "Bearer generated"]], [["authorization", "Bearer headers"]]]);
    // The request is still recorded, without the headers it could not read safely.
    expect(collector.collect().map((event) => event.requestHeaders)).toEqual([undefined, undefined, undefined]);
  });

  it("leaves an unhandled fetch rejection unhandled, once, with its original reason", async () => {
    const reason = new TypeError("offline");
    const seen: unknown[] = [];
    const record = (value: unknown) => seen.push(value);
    const saved = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", record);
    try {
      pageFetch.mockImplementation(() => Promise.reject(reason));
      collector.start();
      void fetch("/unhandled");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seen).toEqual([reason]);
      seen.length = 0;
      await fetch("/handled").catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seen).toEqual([]);
      expect(collector.size()).toBe(2);
    } finally {
      process.off("unhandledRejection", record);
      for (const listener of saved) process.on("unhandledRejection", listener);
    }
  });

  it("raises nothing of its own when the page's fetch resolves to a non-Response", async () => {
    const seen: unknown[] = [];
    const record = (value: unknown) => seen.push(value);
    const saved = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", record);
    try {
      pageFetch.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ status: "bad", get headers() { throw new Error("no"); } });
      collector.start();
      expect(await fetch("/nothing")).toBeUndefined();
      await fetch("/odd-response");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seen).toEqual([]);
      const events = collector.collect();
      expect(events).toHaveLength(2);
      for (const event of events) expect(event).not.toHaveProperty("status");
    } finally {
      process.off("unhandledRejection", record);
      for (const listener of saved) process.on("unhandledRejection", listener);
    }
  });

  it("redacts every listed sensitive request and response header", async () => {
    collector.start();
    const headers = Object.fromEntries(SENSITIVE_HEADERS.map((name) => [name, `${name}-secret`]));
    await fetch("https://example.com/", { method: "POST", headers: { ...headers, "X-Trace": "visible" } });
    const [event] = collector.collect();
    for (const name of SENSITIVE_HEADERS) expect(event!.requestHeaders?.[name]).toBe("[REDACTED]");
    expect(event!.requestHeaders?.["x-trace"]).toBe("visible");
    expect(JSON.stringify(event)).not.toContain("-secret");
    expect(event!.method).toBe("POST");
    // Response headers go through the same redaction.
    expect(event!.responseHeaders).toMatchObject({ "x-trace": "t" });
    expect(JSON.stringify(event!.responseHeaders)).not.toContain("s=1");
  });

  it("reads method and headers from a Request and supports overlapping collectors", async () => {
    const a = new NetworkCollector();
    const b = new NetworkCollector();
    try {
      a.start();
      b.start();
      a.stop();
      await fetch(new Request("https://example.com/?token=private", { method: "POST", headers: { Authorization: "secret", "X-Trace": "visible" } }));
      expect(a.size()).toBe(0);
      expect(b.collect()[0]).toMatchObject({ method: "POST", requestHeaders: { authorization: "[REDACTED]", "x-trace": "visible" } });
      expect(b.collect()[0]!.url).not.toContain("private");
      expectValidEvents(b.collect());
      b.stop();
      expect(globalThis.fetch).toBe(pageFetch);
    } finally {
      a.stop();
      b.stop();
    }
  });

  it("records a failed request without a status and rethrows to the caller", async () => {
    pageFetch.mockRejectedValue(new TypeError("offline"));
    collector.start();
    await expect(fetch("/down")).rejects.toThrow("offline");
    const [event] = collector.collect();
    expect(event).toMatchObject({ url: "/down", method: "GET" });
    expect(event).not.toHaveProperty("status");
    expect(event!.duration).toBeGreaterThanOrEqual(0);
  });

  it("still makes the application's call when the request headers are invalid", async () => {
    collector.start();
    await fetch("/odd", { headers: [["bad header", "x"]] as unknown as HeadersInit });
    expect(pageFetch).toHaveBeenCalledTimes(1);
    const [event] = collector.collect();
    expect(event).toMatchObject({ url: "/odd", status: 201 });
    expect(event).not.toHaveProperty("requestHeaders");
  });

  it("applies URL and header filters and the size bound", async () => {
    const filtered = new NetworkCollector(2, { blockUrls: ["/health"], allowUrls: [/\/api\//g], blockedHeaders: ["X-Drop"], allowedHeaders: ["x-keep", "x-drop"] });
    try {
      filtered.start();
      for (const path of ["/api/1", "/health/api/", "/other", "/api/2", "/api/3"]) {
        await fetch(path, { headers: { "x-keep": "k", "x-drop": "d", "x-other": "o" } });
      }
      const events = filtered.collect();
      expect(events.map((event) => event.url)).toEqual(["/api/2", "/api/3"]);
      expect(events[0]!.requestHeaders).toEqual({ "x-keep": "k" });
      expectValidEvents(events);
    } finally {
      filtered.stop();
    }
  });
});

describe("NetworkCollector XMLHttpRequest capture", () => {
  it("records open/send/loadend with a redacted URL and leaves the request unchanged", () => {
    collector.start();
    const xhr = new XMLHttpRequest() as unknown as FakeXhr;
    (xhr as unknown as XMLHttpRequest).open("PUT", "/upload?api_key=k-secret&id=7");
    (xhr as unknown as XMLHttpRequest).send("body");
    expect(xhr.opened).toEqual(["PUT", "/upload?api_key=k-secret&id=7"]);
    expect(xhr.sent).toBe("body");
    expect(collector.size()).toBe(0);
    xhr.respond(404, "Not Found");
    const [event] = collector.collect();
    expect(event).toMatchObject({ transport: "xhr", method: "PUT", status: 404, statusText: "Not Found" });
    expect(event!.url).not.toContain("k-secret");
    expect(event!.url).toContain("id=7");
  });
});

describe("NetworkCollector stop()", () => {
  it("restores exactly the fetch and XHR functions it replaced", () => {
    collector.start();
    expect(globalThis.fetch).not.toBe(pageFetch);
    expect(proto.open).not.toBe(pageOpen);
    collector.stop();
    expect(globalThis.fetch).toBe(pageFetch);
    expect(proto.open).toBe(pageOpen);
    expect(proto.send).toBe(pageSend);
  });

  it("stays chained and inert when another library patched fetch and XHR after start()", async () => {
    collector.start();
    const ourFetch = globalThis.fetch;
    const ourOpen = proto.open as (...args: unknown[]) => void;
    const laterFetch = vi.fn((...args: Parameters<typeof fetch>) => ourFetch(...args));
    const laterOpen = vi.fn(function (this: unknown, ...args: unknown[]) {
      return ourOpen.apply(this, args);
    });
    globalThis.fetch = laterFetch as unknown as typeof fetch;
    proto.open = laterOpen;

    collector.stop();
    expect(globalThis.fetch).toBe(laterFetch);
    expect(proto.open).toBe(laterOpen);
    // send was not re-patched by the other library, so it is restored.
    expect(proto.send).toBe(pageSend);

    await fetch("/after-stop?token=t");
    expect(pageFetch.mock.calls).toEqual([["/after-stop?token=t"]]);
    const xhr = new XMLHttpRequest() as unknown as FakeXhr;
    (xhr as unknown as XMLHttpRequest).open("GET", "/x");
    expect(pageOpen).toHaveBeenCalledTimes(1);
    expect(collector.size()).toBe(0);

    // A new collector captures each request once through the chain.
    const next = new NetworkCollector();
    next.start();
    await fetch("/again");
    expect(next.collect().map((event) => event.url)).toEqual(["/again"]);
    expectValidEvents(next.collect());
    next.stop();
    expect(globalThis.fetch).toBe(laterFetch);
  });
});

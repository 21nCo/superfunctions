import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkCollector, UNREAD_METHOD, UNREAD_URL } from "../src/collectors/network.js";
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

  it("hands back a page result that is not a thenable, or whose then throws, as is", () => {
    const plain = { not: "a promise" };
    const throwing = Object.defineProperty({}, "then", {
      get() {
        throw new Error("then");
      },
    });
    const refusing = { then: () => { throw new Error("call"); } };
    pageFetch.mockReturnValueOnce(plain).mockReturnValueOnce(throwing).mockReturnValueOnce(refusing);
    collector.start();
    expect(fetch("/plain")).toBe(plain);
    expect(fetch("/throwing")).toBe(throwing);
    expect(fetch("/refusing")).toBe(refusing);
    expect(collector.size()).toBe(0);
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

// Each case builds fresh application arguments whose reads are stateful: an
// extra read by the collector changes what the platform sends.
interface Case {
  name: string;
  args: () => [unknown, unknown?];
  /** What the event records instead of the part it may not read. */
  unread: "headers" | "url" | "method" | "none";
}

type Trap = "ownKeys" | "getOwnPropertyDescriptor" | "getPrototypeOf";
/**
 * A Proxy whose `trap` answers honestly for the first `honest` calls (as many
 * as the platform's own Request construction makes) and alters the request
 * through `alter` on every later one, so any read observation makes before
 * the platform's changes what is sent.
 */
function stateful<T extends object>(target: T, trap: Trap, honest: number, alter: () => void): T {
  let calls = 0;
  return new Proxy(target, {
    [trap]: (...args: unknown[]) => {
      calls += 1;
      if (calls > honest) alter();
      return (Reflect[trap] as (...values: unknown[]) => unknown)(...args);
    },
  });
}

/** A headers record behind a stateful trap. */
function trappedRecord(trap: Trap, honest: number, value: string): Case["args"] {
  return () => {
    const target = { authorization: value };
    return ["https://example.com/p", { headers: stateful(target, trap, honest, () => (target.authorization = "Bearer altered")) }];
  };
}
const CASES: Case[] = [
  {
    name: "an array of pairs with its own one-shot iterator",
    unread: "headers",
    args: () => {
      const headers = [["authorization", "Bearer A"]];
      let used = false;
      Object.defineProperty(headers, Symbol.iterator, {
        value(this: unknown[]) {
          if (used) return [][Symbol.iterator]();
          used = true;
          return Array.prototype[Symbol.iterator].call(this);
        },
      });
      return ["https://example.com/a", { headers }];
    },
  },
  {
    name: "an array holding a generator pair",
    unread: "headers",
    args: () => {
      function* pair() {
        yield "authorization";
        yield "Bearer B";
      }
      return ["https://example.com/b", { headers: [pair()] }];
    },
  },
  {
    name: "a record with a stateful getter",
    unread: "headers",
    args: () => {
      let reads = 0;
      return ["https://example.com/c", { headers: { get authorization() { return reads++ === 0 ? "Bearer C" : ""; } } }];
    },
  },
  {
    name: "an init whose headers is an accessor",
    unread: "headers",
    args: () => {
      let reads = 0;
      return ["https://example.com/d", { get headers() { return reads++ === 0 ? { authorization: "Bearer D" } : {}; } }];
    },
  },
  {
    name: "an input object with a stateful toString",
    unread: "url",
    args: () => {
      let reads = 0;
      const input = { toString: () => (reads++ === 0 ? "https://example.com/e" : "https://other.example/e") };
      return [input, { headers: { authorization: "Bearer E" } }];
    },
  },
  {
    name: "an init whose method is an accessor",
    unread: "method",
    args: () => {
      let reads = 0;
      return ["https://example.com/f", { get method() { return reads++ === 0 ? "POST" : "DELETE"; }, headers: { authorization: "Bearer F" } }];
    },
  },
];

// Proxy traps on the application's objects: the platform runs some of them
// itself, observation must run none before the platform has read the request.
CASES.push(
  { name: "a headers Proxy with a stateful ownKeys trap", unread: "none", args: trappedRecord("ownKeys", 1, "Bearer G") },
  { name: "a headers Proxy with a stateful getOwnPropertyDescriptor trap", unread: "none", args: trappedRecord("getOwnPropertyDescriptor", 1, "Bearer H") },
  { name: "a headers Proxy with a stateful getPrototypeOf trap", unread: "none", args: trappedRecord("getPrototypeOf", 0, "Bearer I") },
  {
    name: "a Proxy array of header pairs with a stateful getPrototypeOf trap",
    unread: "none",
    args: () => {
      const target = [["authorization", "Bearer J"]];
      return ["https://example.com/j", { headers: stateful(target, "getPrototypeOf", 0, () => (target[0]![1] = "Bearer altered")) }];
    },
  },
  {
    name: "a Proxy header pair with a stateful getPrototypeOf trap",
    unread: "none",
    args: () => {
      const pair = ["authorization", "Bearer K"];
      return ["https://example.com/k", { headers: [stateful(pair, "getPrototypeOf", 0, () => (pair[1] = "Bearer altered"))] }];
    },
  },
  {
    name: "an init Proxy with a stateful getOwnPropertyDescriptor trap",
    unread: "none",
    args: () => {
      const init: { headers: Record<string, string> } = { headers: { authorization: "Bearer L" } };
      return ["https://example.com/l", stateful(init, "getOwnPropertyDescriptor", 0, () => (init.headers = { authorization: "Bearer altered" }))];
    },
  },
  {
    name: "an input Proxy with a stateful getPrototypeOf trap",
    unread: "url",
    args: () => {
      let url = "https://example.com/n";
      const input = stateful({ toString: () => url }, "getPrototypeOf", 1, () => (url = "https://other.example/n"));
      return [input, { headers: { authorization: "Bearer N" } }];
    },
  }
);

describe("NetworkCollector at a native Request boundary", () => {
  // The page's fetch builds a platform Request, as a real fetch does, and
  // records what it would transmit.
  let sent: Array<{ url: string; method: string; authorization: string | null }>;
  beforeEach(() => {
    sent = [];
    pageFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push({ url: request.url, method: request.method, authorization: request.headers.get("authorization") });
      return new Response("ok", { status: 200 });
    });
  });

  async function transmit(test: Case) {
    const [input, init] = test.args();
    await fetch(input as RequestInfo, init as RequestInit);
    return sent.pop();
  }

  async function baseline(test: Case) {
    expect(globalThis.fetch).toBe(pageFetch);
    const result = await transmit(test);
    expect(result?.authorization).toMatch(/^Bearer [A-Z]$/);
    return result;
  }

  for (const test of CASES) {
    it(`sends the same request with the collector running: ${test.name}`, async () => {
      const expected = await baseline(test);
      collector.start();
      expect(await transmit(test)).toEqual(expected);
      const [event] = collector.collect();
      // Recorded, without the parts it could not read safely.
      expect(event).toMatchObject({ kind: "network", transport: "fetch", status: 200 });
      if (test.unread === "headers") expect(event).not.toHaveProperty("requestHeaders");
      else expect(event!.requestHeaders).toEqual({ authorization: "[REDACTED]" });
      expect(event!.url === UNREAD_URL).toBe(test.unread === "url");
      expect(event!.method === UNREAD_METHOD).toBe(test.unread === "method");
    });

    it(`sends the same request through a stopped wrapper a later patcher kept: ${test.name}`, async () => {
      const expected = await baseline(test);
      collector.start();
      const ours = globalThis.fetch;
      const later = vi.fn((...args: Parameters<typeof fetch>) => ours(...args));
      globalThis.fetch = later as unknown as typeof fetch;
      collector.stop();
      expect(globalThis.fetch).toBe(later);
      expect(await transmit(test)).toEqual(expected);
      expect(later).toHaveBeenCalledTimes(1);
      expect(collector.size()).toBe(0);
    });
  }

  it("records a fixed placeholder for an input it does not read, and still reads a Request and a URL", async () => {
    collector.start();
    let reads = 0;
    await fetch({ toString: () => (reads++, "https://example.com/plain?token=x") } as unknown as RequestInfo);
    expect(reads).toBe(1); // only the platform's own conversion
    await fetch(new URL("https://example.com/url?token=secret&ok=1"));
    await fetch(new Request("https://example.com/req", { method: "PUT", headers: { "x-trace": "r" } }), { method: 7 as unknown as string });
    const events = collector.collect();
    expect(events.map((event) => event.url)).toEqual([UNREAD_URL, expect.stringContaining("ok=1"), "https://example.com/req"]);
    expect(events[1]!.url).not.toContain("secret");
    expect(events[2]).toMatchObject({ method: UNREAD_METHOD, requestHeaders: { "x-trace": "r" } });
  });

  it("sends the same request through a page fetch that defers the native call, for every non-Proxy form", async () => {
    // A wrapper installed before start() that awaits before calling the
    // native fetch: observation's reads come first, and must not matter.
    pageFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      await Promise.resolve();
      const request = new Request(input, init);
      sent.push({ url: request.url, method: request.method, authorization: request.headers.get("authorization") });
      return new Response("ok", { status: 200 });
    });
    for (const test of CASES.filter((entry) => !entry.name.includes("Proxy"))) {
      collector.stop();
      const expected = await baseline(test);
      collector.start();
      expect(await transmit(test), test.name).toEqual(expected);
    }
  });

  it("records a URL input as it was sent, even if converting it changes it", async () => {
    const filtered = new NetworkCollector(5, { allowUrls: ["/sent"] });
    filtered.start();
    const input = new URL("https://example.com/sent?token=u-secret");
    Object.defineProperty(input, "toString", {
      value(this: URL) {
        const href = this.href;
        this.pathname = "/mutated";
        return href;
      },
    });
    await fetch(input);
    const events = filtered.collect();
    filtered.stop();
    expect(sent.map((request) => request.url)).toEqual(["https://example.com/sent?token=u-secret"]);
    expect(events.map((event) => event.url)).toEqual([expect.stringContaining("https://example.com/sent?")]);
    expect(events[0]!.url).not.toContain("u-secret");
    expectValidEvents(events);
  });

  it("runs no trap of the application's arguments before the page's fetch has run", async () => {
    const trapped: string[] = [];
    const traps = ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor", "has", "get"] as const;
    const watch = <T extends object>(label: string, target: T): T =>
      new Proxy(
        target,
        Object.fromEntries(
          traps.map((trap) => [
            trap,
            (...args: unknown[]) => {
              trapped.push(`${label}.${trap}`);
              return (Reflect[trap] as (...values: unknown[]) => unknown)(...args);
            },
          ])
        )
      );
    let before: string[] | undefined;
    pageFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      before = [...trapped];
      new Request(input, init);
      return new Response("ok", { status: 200 });
    });
    const forms: Array<() => [unknown, unknown?]> = [
      () => [watch("input", { toString: () => "https://example.com/i" })],
      () => ["https://example.com/init", watch("init", { method: "POST", headers: { a: "1" } })],
      () => ["https://example.com/record", { headers: watch("record", { authorization: "Bearer x" }) }],
      () => ["https://example.com/pairs", { headers: watch("pairs", [["authorization", "Bearer x"]]) }],
      () => ["https://example.com/pair", { headers: [watch("pair", ["authorization", "Bearer x"])] }],
    ];
    collector.start();
    for (const form of forms) {
      trapped.length = 0;
      before = undefined;
      const [input, init] = form();
      await fetch(input as RequestInfo, init as RequestInit);
      expect(before).toEqual([]);
      expect(trapped.length).toBeGreaterThan(0); // The platform did read it.
    }
    expect(collector.size()).toBe(forms.length);
  });

  it("captures plain arrays, plain records and platform Headers, but not a Headers subclass", async () => {
    class Custom extends Headers {
      *[Symbol.iterator](): HeadersIterator<[string, string]> {
        yield ["authorization", "Bearer custom"];
      }
    }
    collector.start();
    await fetch("https://example.com/1", { headers: [["x-a", "1"]] });
    await fetch("https://example.com/2", { headers: { "x-b": "2" } });
    await fetch("https://example.com/3", { headers: new Headers({ "x-c": "3" }) });
    await fetch("https://example.com/4", { headers: new Custom({ "x-d": "4" }) });
    expect(collector.collect().map((event) => event.requestHeaders)).toEqual([{ "x-a": "1" }, { "x-b": "2" }, { "x-c": "3" }, undefined]);
    expect(sent.map((request) => request.authorization)).toEqual([null, null, null, "Bearer custom"]);
  });
});

describe("NetworkCollector XMLHttpRequest after stop()", () => {
  it("passes open and send through unread when a later patcher kept the stopped wrappers", () => {
    collector.start();
    const ourOpen = proto.open as (...args: unknown[]) => void;
    const ourSend = proto.send as (...args: unknown[]) => void;
    proto.open = function (this: unknown, ...args: unknown[]) {
      return ourOpen.apply(this, args);
    };
    proto.send = function (this: unknown, ...args: unknown[]) {
      return ourSend.apply(this, args);
    };
    collector.stop();
    const listen = vi.spyOn(EventTarget.prototype, "addEventListener");
    try {
      let reads = 0;
      const method = { toString: () => (reads++, "GET") };
      const url = { toString: () => (reads++, "/x") };
      const xhr = new XMLHttpRequest() as unknown as FakeXhr;
      (xhr as unknown as { open: (...args: unknown[]) => void }).open(method, url, true);
      (xhr as unknown as { send: (...args: unknown[]) => void }).send("body", "extra");
      expect(xhr.opened).toEqual([method, url, true]);
      expect(pageSend.mock.calls).toEqual([["body", "extra"]]);
      expect(reads).toBe(0);
      expect(listen).not.toHaveBeenCalled();
      xhr.respond(200, "OK");
      expect(collector.size()).toBe(0);
    } finally {
      listen.mockRestore();
    }
  });

  it("runs no trap of open() or send() arguments before the page's open and send run", () => {
    const trapped: string[] = [];
    const watch = <T extends object>(label: string, target: T): T =>
      new Proxy(target, {
        getPrototypeOf: (value) => (trapped.push(`${label}.getPrototypeOf`), Reflect.getPrototypeOf(value)),
        get: (value, key, receiver) => (trapped.push(`${label}.get`), Reflect.get(value, key, receiver)),
        ownKeys: (value) => (trapped.push(`${label}.ownKeys`), Reflect.ownKeys(value)),
      });
    const order: string[] = [];
    pageOpen.mockImplementationOnce(function (this: FakeXhr, ...args: unknown[]) {
      order.push(`open after [${trapped.join(",")}]`);
      this.opened = args;
    });
    pageSend.mockImplementationOnce(function (this: FakeXhr, body?: unknown) {
      order.push(`send after [${trapped.join(",")}]`);
      this.sent = body;
    });
    collector.start();
    const xhr = new XMLHttpRequest() as unknown as FakeXhr;
    const method = watch("method", { toString: () => "GET" });
    const url = watch("url", { toString: () => "/x" });
    (xhr as unknown as { open: (...args: unknown[]) => void }).open(method, url);
    trapped.length = 0;
    (xhr as unknown as { send: (...args: unknown[]) => void }).send(watch("body", { data: 1 }));
    expect(order).toEqual(["open after []", "send after []"]);
    xhr.respond(200, "OK");
    expect(collector.collect()[0]).toMatchObject({ method: UNREAD_METHOD, url: UNREAD_URL, status: 200 });
  });

  it("attributes a send() made from open()'s readystatechange to that open(), and lets a nested open() win", () => {
    // Like the platform, the page's open() dispatches readystatechange before it returns.
    const throwing = new SyntaxError("bad method");
    pageOpen.mockImplementation(function (this: FakeXhr, ...args: unknown[]) {
      if (args[0] === "BAD") throw throwing;
      this.opened = args;
      this.dispatchEvent(new Event("readystatechange"));
    });
    try {
      collector.start();
      const fake = new XMLHttpRequest() as unknown as FakeXhr;
      const xhr = fake as unknown as XMLHttpRequest;
      let onOpen: (() => void) | undefined;
      fake.addEventListener("readystatechange", () => {
        const handle = onOpen;
        onOpen = undefined;
        handle?.();
      });
      // A fresh request, then the same object reused after it completed.
      onOpen = () => xhr.send();
      xhr.open("GET", "/first");
      fake.respond(200, "OK");
      onOpen = () => xhr.send("body");
      xhr.open("POST", "/second");
      fake.respond(201, "Created");
      // An open() nested in the outer open()'s dispatch is the one sent.
      onOpen = () => {
        onOpen = () => xhr.send();
        xhr.open("PUT", "/inner");
      };
      xhr.open("DELETE", "/outer");
      fake.respond(202, "Accepted");
      // An open() the platform rejects leaves the earlier request's record.
      xhr.open("PATCH", "/kept");
      expect(() => xhr.open("BAD", "/rejected")).toThrow(throwing);
      xhr.send();
      fake.respond(204, "No Content");
      expect(collector.collect().map(({ method, url, status }) => [method, url, status])).toEqual([
        ["GET", "/first", 200],
        ["POST", "/second", 201],
        ["PUT", "/inner", 202],
        ["PATCH", "/kept", 204],
      ]);
    } finally {
      pageOpen.mockImplementation(function (this: FakeXhr, ...args: unknown[]) {
        this.opened = args;
      });
    }
  });

  it("records a URL object's address for a request that completes during open()'s readystatechange", () => {
    pageOpen.mockImplementation(function (this: FakeXhr, ...args: unknown[]) {
      this.opened = args;
      this.dispatchEvent(new Event("readystatechange"));
    });
    try {
      const filtered = new NetworkCollector(5, { allowUrls: ["/api/"] });
      filtered.start();
      const fake = new XMLHttpRequest() as unknown as FakeXhr;
      const xhr = fake as unknown as XMLHttpRequest;
      // A synchronous request: send() completes inside the readystatechange of open().
      fake.addEventListener("readystatechange", () => {
        xhr.send();
        fake.respond(200, "OK");
      }, { once: true });
      xhr.open("GET", new URL("https://example.com/api/obj?token=t-secret") as unknown as string, false);
      const events = filtered.collect();
      filtered.stop();
      expectValidEvents(events);
      expect(events.map((event) => event.url)).toEqual([expect.stringContaining("https://example.com/api/obj")]);
      expect(events[0]!.url).not.toContain("t-secret");
    } finally {
      pageOpen.mockImplementation(function (this: FakeXhr, ...args: unknown[]) {
        this.opened = args;
      });
    }
  });

  it("records a placeholder for a non-string method or URL without converting it", () => {
    collector.start();
    let reads = 0;
    const xhr = new XMLHttpRequest() as unknown as FakeXhr;
    (xhr as unknown as { open: (...args: unknown[]) => void }).open({ toString: () => (reads++, "GET") }, { toString: () => (reads++, "/x") });
    (xhr as unknown as XMLHttpRequest).send();
    xhr.respond(200, "OK");
    expect(reads).toBe(0);
    expect(collector.collect()[0]).toMatchObject({ method: UNREAD_METHOD, url: UNREAD_URL, status: 200 });
  });
});

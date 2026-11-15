import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { expectValidEvents } from "./schema-helper.js";

// Node 18.17's Headers.prototype.forEach is `for (const [name, value] of this)`,
// which runs the live Symbol.iterator. Model that forEach before catchfn
// loads, so the collector captures it as the platform's own.
const nativeForEach = Object.getOwnPropertyDescriptor(Headers.prototype, "forEach")!;
Object.defineProperty(Headers.prototype, "forEach", {
  ...nativeForEach,
  value(this: Headers, callback: (value: string, name: string, headers: Headers) => void, thisArg?: unknown) {
    for (const [name, value] of this) callback.call(thisArg, value, name, this);
  },
});
const { NetworkCollector } = await import("../src/collectors/network.js");
afterAll(() => {
  Object.defineProperty(Headers.prototype, "forEach", nativeForEach);
});

const savedFetch = globalThis.fetch;
let collector: InstanceType<typeof NetworkCollector>;

beforeEach(() => {
  globalThis.fetch = (async () => new Response("ok", { status: 200, headers: { "x-trace": "t" } })) as unknown as typeof fetch;
  collector = new NetworkCollector();
});

afterEach(() => {
  expectValidEvents(collector.collect());
  collector.stop();
  globalThis.fetch = savedFetch;
});

describe("NetworkCollector headers, with a forEach that runs the iterator", () => {
  it("records Request and response headers while the iterator is the platform's", async () => {
    collector.start();
    await fetch(new Request("https://example.com/r", { headers: { authorization: "Bearer secret", "x-a": "1" } }));
    expect(collector.collect()[0]).toMatchObject({ requestHeaders: { authorization: "[REDACTED]", "x-a": "1" }, responseHeaders: { "x-trace": "t" } });
  });

  it("never runs a replaced Headers iterator, and records the request without headers", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Headers.prototype, Symbol.iterator)!;
    const original = descriptor.value as (this: Headers) => HeadersIterator<[string, string]>;
    let replacementRuns = 0;
    const request = new Request("https://example.com/r", { headers: { authorization: "Bearer secret" } });
    Object.defineProperty(Headers.prototype, Symbol.iterator, {
      ...descriptor,
      value(this: Headers) {
        replacementRuns += 1;
        return original.call(this);
      },
    });
    try {
      collector.start();
      await fetch(request);
      await fetch("https://example.com/p", { headers: [["x-pairs", "1"]] });
    } finally {
      Object.defineProperty(Headers.prototype, Symbol.iterator, descriptor);
    }
    expect(replacementRuns).toBe(0);
    const events = collector.collect();
    expect(events.map((event) => event.status)).toEqual([200, 200]);
    for (const event of events) {
      expect(event).not.toHaveProperty("requestHeaders");
      expect(event).not.toHaveProperty("responseHeaders");
    }
  });
});

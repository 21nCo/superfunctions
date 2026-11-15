import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { expectValidEvents } from "./schema-helper.js";

// Node 18.17's URL href getter checks its brand with
// ObjectPrototypeHasOwnProperty(this, context), which runs a Proxy's
// getOwnPropertyDescriptor trap. Model that getter before catchfn loads, so
// the collector captures it as the platform's own.
const nativeHref = Object.getOwnPropertyDescriptor(URL.prototype, "href")!;
Object.defineProperty(URL.prototype, "href", {
  ...nativeHref,
  get(this: URL) {
    Object.prototype.hasOwnProperty.call(this, "href");
    return nativeHref.get!.call(this);
  },
});
const { NetworkCollector, UNREAD_URL } = await import("../src/collectors/network.js");
afterAll(() => {
  Object.defineProperty(URL.prototype, "href", nativeHref);
});

/** A URL-like input whose descriptor trap changes the address it converts to. */
function trappedInput() {
  let address = "https://example.com/original";
  const input = new Proxy(
    { toString: () => address },
    {
      getOwnPropertyDescriptor(target, key) {
        address = "https://example.com/altered";
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    }
  );
  return input;
}

const savedFetch = globalThis.fetch;
let sent: string[];
let collector: InstanceType<typeof NetworkCollector>;

beforeEach(() => {
  sent = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Request(input, init).url);
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  collector = new NetworkCollector();
});

afterEach(() => {
  expectValidEvents(collector.collect());
  collector.stop();
  globalThis.fetch = savedFetch;
  delete (globalThis as Record<string, unknown>).XMLHttpRequest;
});

describe("NetworkCollector before the page's call, with a trap-running URL brand check", () => {
  it("sends the same fetch request with and without the collector", async () => {
    await fetch(trappedInput() as unknown as RequestInfo);
    collector.start();
    await fetch(trappedInput() as unknown as RequestInfo);
    expect(sent).toEqual(["https://example.com/original", "https://example.com/original"]);
    expect(collector.collect().map((event) => event.url)).toEqual([UNREAD_URL]);
  });

  it("opens the same XMLHttpRequest URL with and without the collector", () => {
    const opened: string[] = [];
    class FakeXhr extends EventTarget {}
    Object.assign(FakeXhr.prototype, {
      open(_method: unknown, url: unknown) {
        opened.push(String(url));
      },
      send() {},
    });
    (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXhr;
    const open = (xhr: unknown) => (xhr as { open: (...args: unknown[]) => void }).open("GET", trappedInput());
    open(new FakeXhr());
    collector.start();
    const xhr = new FakeXhr();
    open(xhr);
    (xhr as unknown as { send: () => void }).send();
    xhr.dispatchEvent(new Event("loadend"));
    expect(opened).toEqual(["https://example.com/original", "https://example.com/original"]);
    expect(collector.collect().map((event) => event.url)).toEqual([UNREAD_URL]);
  });
});

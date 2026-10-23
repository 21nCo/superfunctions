import { describe, expect, it, vi } from "vitest";
import { safeSerialize, estimateSize, trimArray } from "../src/utils/serialization.js";
import { redactObject, redactUrl } from "../src/utils/redaction.js";
import { limitPayloadSize } from "../src/utils/size-limiter.js";
import { ConsoleCollector } from "../src/collectors/console.js";
import { NetworkCollector } from "../src/collectors/network.js";

describe("capture privacy and lifecycle", () => {
  it("snapshots repeated references, cyclic errors, and own __proto__ data safely", () => {
    const shared = { value: 1 };
    const error: any = new Error("failure"); error.cause = error;
    const input = JSON.parse('{"__proto__":{"secret":"hidden"}}');
    const value = safeSerialize({ a: shared, b: shared, input, error, count: 2n });
    expect(value.a).toEqual(value.b);
    expect(value.error.cause).toBe("[Circular Reference]");
    expect(Object.hasOwn(value.input, "__proto__")).toBe(true);
    expect(value.count).toBe("2");
    expect(() => JSON.stringify(value)).not.toThrow();
    expect(redactObject(input).__proto__.secret).toBe("[REDACTED]");
  });
  it("scrubs case-insensitive URL credentials and sensitive values before transport", () => {
    const value = redactObject({ url: "https://user:pass@example.com/?TOKEN=secret", message: "card 4111 1111 1111 1111" });
    expect(value.url).not.toContain("secret");
    expect(value.url).not.toContain("user");
    expect(value.message).not.toContain("4111");
    expect(redactUrl("https://example.com/#access_token=secret")).not.toContain("secret");
  });
  it.each(['/api?TOKEN=relative-secret&ok=1', '../api?token=relative-secret', '?%74oken=relative-secret', '//user:relative-secret@example.com/api?key=relative-secret', '/api#access_token=relative-secret', '/api#%74oken=relative-secret', '/api#token%=relative-secret', 'https://user:relative-secret@[invalid/?token=relative-secret'])('scrubs relative or malformed network URL %s', url => {
    expect(redactUrl(url)).not.toContain('relative-secret');
    expect(redactUrl(url)).not.toContain('catchfn.invalid');
    expect(redactObject({ networkLogs: [{ url }] }).networkLogs[0].url).not.toContain('relative-secret');
  });
  it('keeps relative fetch requests unchanged while redacting captured metadata', async () => {
    const original = globalThis.fetch;
    const fetcher = vi.fn(async () => new Response('ok'));
    globalThis.fetch = fetcher;
    const collector = new NetworkCollector();
    try {
      collector.start();
      await fetch('/api?token=relative-secret&safe=visible');
      expect(fetcher).toHaveBeenCalledWith('/api?token=relative-secret&safe=visible', undefined);
      expect(collector.collect()[0].url).not.toContain('relative-secret');
      expect(collector.collect()[0].url).toContain('safe=visible');
    } finally { collector.stop(); globalThis.fetch = original; }
  });
  it("enforces UTF-8 payload bounds and zero-sized buffers", () => {
    expect(trimArray([1,2], 0)).toEqual([]);
    const payload = { title: "small", consoleLogs: Array.from({length:30}, (_, id) => ({id, message:"🙂".repeat(20)})) };
    const limited = limitPayloadSize(payload, 256);
    expect(estimateSize(limited)).toBeLessThanOrEqual(256);
    expect(limited.consoleLogs.at(-1).id).toBe(29);
    expect(() => limitPayloadSize({title:"x".repeat(1000)}, 100)).toThrow(/maxPayloadSize/);
  });
  it("supports overlapping console collectors stopped out of order", () => {
    const original = console.info;
    const a = new ConsoleCollector(), b = new ConsoleCollector();
    try {
      a.start(); b.start(); a.stop(); console.info("after first stop");
      expect(a.size()).toBe(0); expect(b.size()).toBe(1);
      b.stop(); expect(console.info).toBe(original);
    } finally { a.stop(); b.stop(); }
  });
  it("preserves fetch Request method/headers and overlapping lifetimes", async () => {
    const original = globalThis.fetch;
    const fetcher = vi.fn(async () => new Response("ok"));
    globalThis.fetch = fetcher;
    const a = new NetworkCollector(), b = new NetworkCollector();
    try {
      a.start(); b.start(); a.stop();
      await fetch(new Request("https://example.com/?token=private", {method:"POST", headers:{Authorization:"secret", "X-Trace":"visible"}}));
      expect(a.size()).toBe(0);
      expect(b.collect()[0]).toMatchObject({method:"POST", requestHeaders:{authorization:"[REDACTED]", "x-trace":"visible"}});
      expect(b.collect()[0].url).not.toContain("private");
      b.stop(); expect(globalThis.fetch).toBe(fetcher);
    } finally { a.stop(); b.stop(); globalThis.fetch = original; }
  });
});

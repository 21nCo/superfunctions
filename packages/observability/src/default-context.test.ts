import { afterEach, describe, expect, it, vi } from "vitest";

// Cloudflare Workers expose no Node `process` unless nodejs_compat is on; the
// Workers-only WebSocketPair global identifies them (see runtime.ts).
function stubWorkersScope(): void {
  vi.stubGlobal("process", undefined);
  vi.stubGlobal("WebSocketPair", class {});
}

// Import a fresh module (its AsyncLocalStorage loader is memoized per module)
// before stubbing globals: the test runner needs `process` to load modules.
async function freshObservability(stubScope: () => void) {
  vi.resetModules();
  const { createObservability } = await import("./index.js");
  stubScope();
  return createObservability();
}

describe("default request context outside Node", () => {
  afterEach(() => {
    vi.doUnmock("node:async_hooks");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("keeps the request across await on Cloudflare Workers with AsyncLocalStorage", async () => {
    const observer = await freshObservability(stubWorkersScope);
    const requests = ["one", "two"].map(requestId => observer.startRequest({ requestId }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await Promise.all(requests.map((request, index) => observer.runWithRequest(request, async () => {
      if (index === 1) release();
      await gate;
      expect(observer.getCurrentRequest()).toBe(request);
    })));
    expect(observer.getCurrentRequest()).toBeUndefined();
  });

  it("falls back to the synchronous context on Cloudflare Workers without node:async_hooks", async () => {
    vi.doMock("node:async_hooks", () => { throw new Error("No such module"); });
    const observer = await freshObservability(stubWorkersScope);
    const request = observer.startRequest({ requestId: "workers" });
    const seen: unknown[] = [];
    await observer.runWithRequest(request, async () => {
      seen.push(observer.getCurrentRequest());
      await Promise.resolve();
      seen.push(observer.getCurrentRequest());
    });
    expect(seen).toEqual([request, undefined]);
    expect(observer.getCurrentRequest()).toBeUndefined();
  });

  it("does not import node:async_hooks in a browser page", async () => {
    const loader = vi.fn(() => { throw new Error("browser import"); });
    vi.doMock("node:async_hooks", loader);
    const observer = await freshObservability(() => {
      vi.stubGlobal("process", undefined);
      vi.stubGlobal("document", {});
    });
    const request = observer.startRequest({ requestId: "page" });
    await observer.runWithRequest(request, () => {
      expect(observer.getCurrentRequest()).toBe(request);
    });
    expect(loader).not.toHaveBeenCalled();
  });
});

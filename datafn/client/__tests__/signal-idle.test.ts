/**
 * A live query no one subscribes to doesn't re-run on writes; it re-reads
 * once when someone subscribes again. Pages left in the last few minutes
 * used to keep re-fetching their lists on every edit until their signals
 * were evicted.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatafnClient } from "../src/client.js";
import { LiveSignal } from "../src/signals/liveSignal.js";
import { DefaultHttpTransport } from "../src/transport/http.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const clients: Array<{ destroy?: () => Promise<void> | void }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.destroy?.();
});

function mockRemote() {
  const queried: string[] = [];
  vi.spyOn(DefaultHttpTransport.prototype, "query").mockImplementation(async (q: any) => {
    queried.push(q?.resource);
    return { ok: true, result: { data: [], nextCursor: null } } as any;
  });
  vi.spyOn(DefaultHttpTransport.prototype, "mutation").mockImplementation(
    async (m: any) =>
      ({
        ok: true,
        result: { ok: true, mutationId: m?.mutationId ?? "m", affectedIds: [], errors: [], deduped: false },
      }) as any,
  );
  return queried;
}

function createClient() {
  const client = createDatafnClient({
    schema: {
      resources: [{ name: "note", version: 1, fields: [{ name: "label", type: "string", required: false }] }],
    },
    sync: { remote: "http://example.com" },
    clientId: "test-client",
  });
  clients.push(client as any);
  return client;
}

describe("idle live queries", () => {
  it("don't re-run on writes and re-read once when subscribed again", async () => {
    const queried = mockRemote();
    const client = createClient();
    const list = client.table("note").signal({ sort: ["label"] } as any);
    const unsubscribe = list.subscribe(() => {});
    await settle();
    unsubscribe();
    queried.length = 0;

    for (let i = 0; i < 3; i++) {
      await client.table("note").mutate({ operation: "insert", id: `note:n${i}`, record: { label: `n${i}` } } as any);
    }
    await settle();
    expect(queried.filter((resource) => resource === "note")).toEqual([]);

    const again = list.subscribe(() => {});
    await settle();
    expect(queried.filter((resource) => resource === "note")).toHaveLength(1);
    again();
  });

  it("re-read once when the returning reader subscribes another during delivery", async () => {
    const queried = mockRemote();
    const client = createClient();
    const list = client.table("note").signal({ sort: ["label"] } as any);
    list.subscribe(() => {})();
    await settle();
    queried.length = 0;
    await client.table("note").mutate({ operation: "insert", id: "note:a", record: { label: "a" } } as any);
    await settle();
    expect(queried.filter((resource) => resource === "note")).toEqual([]);

    // Reach the raw query signal directly: its first handler subscribes a
    // second reader while the cached value is delivered.
    const raw = (list as any).raw;
    let nested: (() => void) | undefined;
    const outer = raw.subscribe(() => {
      nested ??= raw.subscribe(() => {});
    });
    await settle();
    expect(queried.filter((resource) => resource === "note")).toHaveLength(1);
    outer();
    nested?.();
  });

  it("don't retry a failed first read on writes while no one subscribes", async () => {
    const queried = mockRemote();
    let fail = true;
    (DefaultHttpTransport.prototype.query as any).mockImplementation(async (q: any) => {
      queried.push(q?.resource);
      if (fail) throw Object.assign(new Error("offline"), { code: "NETWORK" });
      return { ok: true, result: { data: [], nextCursor: null } };
    });
    const client = createClient();
    const list = client.table("note").signal({ sort: ["label"] } as any);
    const unsubscribe = list.subscribe(() => {});
    unsubscribe();
    await settle();
    expect(list.error).not.toBeNull();
    queried.length = 0;

    await client.table("note").mutate({ operation: "insert", id: "note:a", record: { label: "a" } } as any);
    await settle();
    expect(queried.filter((resource) => resource === "note")).toEqual([]);

    fail = false;
    const values: unknown[] = [];
    const again = list.subscribe((value) => values.push(value));
    await settle();
    expect(queried.filter((resource) => resource === "note")).toHaveLength(1);
    expect(values.at(-1)).toEqual([]);
    again();
  });

  it("deliver a combined signal's value once to a returning reader", async () => {
    mockRemote();
    const client = createClient();
    const counts = (client as any).resourceCountsSignal({ resources: ["note"] });
    const first: unknown[] = [];
    const unsubscribe = counts.subscribe((value: unknown) => first.push(value));
    await settle();
    expect(first.length).toBeGreaterThan(0);
    unsubscribe();
    await settle();

    const returning: unknown[] = [];
    const again = counts.subscribe((value: unknown) => returning.push(value));
    await settle();
    expect(returning).toEqual([{ note: 0 }]);
    again();
  });

  it("still re-run on writes while subscribed", async () => {
    const queried = mockRemote();
    const client = createClient();
    const list = client.table("note").signal({ sort: ["label"] } as any);
    const unsubscribe = list.subscribe(() => {});
    await settle();
    queried.length = 0;
    await client.table("note").mutate({ operation: "insert", id: "note:a", record: { label: "a" } } as any);
    await settle();
    expect(queried.filter((resource) => resource === "note").length).toBeGreaterThan(0);
    unsubscribe();
  });
});

function rawSignal(value: unknown) {
  const subs = new Set<(v: any) => void>();
  return {
    subs,
    get: () => value,
    subscribe(handler: (v: any) => void) {
      subs.add(handler);
      handler(value);
      return () => subs.delete(handler);
    },
    loading: false,
    error: null,
    refreshing: false,
    refresh: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
}

describe("idle LiveSignal", () => {
  it("stops following its raw signal while no one subscribes", async () => {
    const raw = rawSignal({ n: 1 });
    const signal = new LiveSignal(() => raw as any, () => {});
    const received: unknown[] = [];
    const unsubscribe = signal.subscribe((v) => received.push(v));
    expect(raw.subs.size).toBe(1);
    await Promise.resolve();
    raw.refresh.mockClear();
    unsubscribe();
    expect(raw.subs.size).toBe(0);

    signal.subscribe((v) => received.push(v));
    expect(raw.subs.size).toBe(1);
    // The cached value reaches the returning reader once, not again from the
    // raw signal's own delivery on re-attach.
    expect(received).toEqual([{ n: 1 }, { n: 1 }]);
    await Promise.resolve();
    expect(raw.refresh).toHaveBeenCalledTimes(1);
  });

  it("delivers once to a returning reader when the raw signal builds a new value on subscribe", async () => {
    // Derived signals (sync status, mapSignal, combineSignals) deliver a new,
    // equal object to every subscriber.
    let built = 0;
    const subs = new Set<(v: any) => void>();
    const raw = {
      subs,
      loading: false,
      error: null,
      refreshing: false,
      get: () => ({ n: built }),
      subscribe(handler: (v: any) => void) {
        subs.add(handler);
        handler({ n: ++built });
        return () => subs.delete(handler);
      },
      refresh: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    const signal = new LiveSignal(() => raw as any, () => {});
    const first: unknown[] = [];
    signal.subscribe((v) => first.push(v))();
    expect(first).toEqual([{ n: 1 }]);
    expect(subs.size).toBe(0);

    const returning: unknown[] = [];
    signal.subscribe((v) => returning.push(v));
    expect(subs.size).toBe(1);
    expect(returning).toEqual([{ n: 2 }]);
    expect(signal.get()).toEqual({ n: 2 });
  });

  it("loads a raw signal rebound while idle, then stops following it", () => {
    const raws: Array<ReturnType<typeof pendingRawSignal>> = [];
    const signal = new LiveSignal(
      () => {
        const raw = pendingRawSignal();
        raws.push(raw);
        return raw as any;
      },
      () => {},
    );
    raws[0].deliver({ n: 1 });
    signal.subscribe(() => {})();
    expect(raws[0].subs.size).toBe(0);

    signal.rebind();
    // The new context's read runs now, so get() moves off the old context.
    expect(raws[1].subs.size).toBe(1);
    raws[1].deliver({ n: 2 });
    expect(signal.get()).toEqual({ n: 2 });
    expect(raws[1].subs.size).toBe(0);
  });

  it("stops following once settled when its readers left before the first result", () => {
    const raw = pendingRawSignal();
    const signal = new LiveSignal(() => raw as any, () => {});
    signal.subscribe(() => {})();
    expect(raw.subs.size).toBe(1);
    raw.deliver({ n: 1 });
    expect(raw.subs.size).toBe(0);
    expect(signal.get()).toEqual({ n: 1 });
  });

  it("stops following when its readers left and the first read failed", () => {
    const raw = pendingRawSignal();
    const signal = new LiveSignal(() => raw as any, () => {});
    signal.subscribe(() => {})();
    raw.fail();
    expect(raw.subs.size).toBe(0);
    // The next reader follows it again, which retries the read.
    signal.subscribe(() => {});
    expect(raw.subs.size).toBe(1);
  });

  it("keeps following a signal no one has subscribed to yet", () => {
    const raw = pendingRawSignal();
    new LiveSignal(() => raw as any, () => {});
    raw.deliver({ n: 1 });
    expect(raw.subs.size).toBe(1);
  });
});

function pendingRawSignal() {
  let value: unknown;
  const subs = new Set<(v: any) => void>();
  const raw = {
    subs,
    loading: true,
    get: () => value,
    subscribe(handler: (v: any) => void) {
      subs.add(handler);
      if (value !== undefined) handler(value);
      return () => subs.delete(handler);
    },
    deliver(next: unknown) {
      value = next;
      raw.loading = false;
      subs.forEach((fn) => fn(next));
    },
    fail() {
      raw.loading = false;
      raw.error = { code: "INTERNAL", message: "failed" };
      subs.forEach((fn) => fn(undefined));
    },
    error: null as unknown,
    refreshing: false,
    refresh: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  return raw;
}

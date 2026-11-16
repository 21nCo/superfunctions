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

  it("leaves a raw signal rebound while idle unfollowed until someone subscribes", () => {
    const raws: Array<ReturnType<typeof rawSignal>> = [];
    const signal = new LiveSignal(
      () => {
        const raw = rawSignal({ n: raws.length + 1 });
        raws.push(raw);
        return raw as any;
      },
      () => {},
    );
    signal.subscribe(() => {})();
    signal.rebind();
    expect(raws).toHaveLength(2);
    expect(raws[1].subs.size).toBe(0);

    const received: unknown[] = [];
    signal.subscribe((v) => received.push(v));
    expect(raws[1].subs.size).toBe(1);
    expect(received.at(-1)).toEqual({ n: 2 });
  });
});

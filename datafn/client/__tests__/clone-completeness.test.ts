/**
 * Full clone ("first sync") completeness:
 * - a paginated table stays "hydrating" until its last page is applied, and an
 *   interrupted clone starts that table again instead of treating it as done;
 * - a clone the server capped (SCA-002 auto-pagination) continues page by page;
 * - clone pages are written with the adapter's bulk upsert when it has one;
 * - rate-limited clone requests are retried, honouring Retry-After.
 */

import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import type { DatafnSchema } from "@datafn/core";
import { EventBus } from "../src/events/bus.js";
import { MemoryStorageAdapter } from "../src/adapters/memoryStorage.js";
import { IndexedDbStorageAdapter } from "../src/adapters/indexedDbStorage.js";
import { SyncEngine } from "../src/sync/engine.js";
import { DefaultHttpTransport } from "../src/transport/http.js";
import { GLOBAL_CURSOR_KEY } from "../src/sync/apply.js";
import type { DatafnSyncConfig } from "../src/client.js";

const schema: DatafnSchema = {
  resources: [
    {
      name: "notes",
      version: 1,
      fields: [{ name: "title", type: "string", required: false }],
    },
  ],
  relations: [],
};

const ALL_NOTES = ["n1", "n2", "n3", "n4", "n5"].map((id) => ({ id, title: id }));

type ClonePayload = {
  tables?: string[];
  page?: { table: string; afterId: string | null; limit: number };
};

function pageResponse(afterId: string | null, limit: number, cursor = "10") {
  const start = afterId === null ? 0 : ALL_NOTES.findIndex((n) => n.id === afterId) + 1;
  const records = ALL_NOTES.slice(start, start + limit);
  const last = start + limit >= ALL_NOTES.length;
  return {
    ok: true,
    result: {
      ok: true,
      data: { notes: records },
      cursors: { notes: cursor },
      next: { notes: last ? null : records[records.length - 1].id },
    },
  };
}

function createEngine(
  storage: MemoryStorageAdapter,
  clone: (payload: ClonePayload) => Promise<unknown>,
  config: DatafnSyncConfig = {},
  searchProvider?: unknown,
) {
  const remote = {
    clone: vi.fn(clone),
    query: vi.fn(),
    mutation: vi.fn(),
    transact: vi.fn(),
    seed: vi.fn(),
    pull: vi.fn(async () => ({
      ok: true,
      result: { ok: true, records: {}, deleted: {}, cursors: {} },
    })),
    push: vi.fn(),
    reconcile: vi.fn(),
  };
  const engine = new SyncEngine(
    storage,
    remote as any,
    new EventBus(),
    "client-1",
    schema,
    config,
    [],
    undefined,
    searchProvider as any,
  );
  return { engine, remote };
}

describe("paginated clone completeness", () => {
  it("keeps the table hydrating until the last page, then marks it ready", async () => {
    const storage = new MemoryStorageAdapter();
    const statesSeenByLaterPages: string[] = [];
    const { engine, remote } = createEngine(
      storage,
      async (payload) => {
        if (payload.page?.afterId) {
          statesSeenByLaterPages.push(await storage.getHydrationState("notes"));
        }
        return pageResponse(payload.page!.afterId, payload.page!.limit);
      },
      { hydration: { bootResources: ["notes"], clonePageSize: 2 } },
    );

    await engine.cloneNow();

    expect(remote.clone).toHaveBeenCalledTimes(3);
    expect(statesSeenByLaterPages).toEqual(["hydrating", "hydrating"]);
    expect(await storage.getHydrationState("notes")).toBe("ready");
    expect((await storage.listRecords("notes")).map((r) => r.id)).toEqual(
      ALL_NOTES.map((n) => n.id),
    );
  });

  it("re-clones a table whose clone was interrupted after some pages", async () => {
    const storage = new MemoryStorageAdapter();
    const config: DatafnSyncConfig = {
      hydration: { bootResources: ["notes"], clonePageSize: 2 },
    };
    const first = createEngine(
      storage,
      async (payload) => {
        if (payload.page?.afterId === "n2") throw new Error("network down");
        return pageResponse(payload.page!.afterId, payload.page!.limit);
      },
      config,
    );

    await expect(first.engine.initializeSync()).rejects.toThrow("network down");
    expect(await storage.getHydrationState("notes")).not.toBe("ready");
    expect(await storage.listRecords("notes")).toHaveLength(2);

    const second = createEngine(
      storage,
      async (payload) => pageResponse(payload.page!.afterId, payload.page!.limit),
      config,
    );
    await second.engine.initializeSync();

    expect(second.remote.clone.mock.calls[0][0]).toMatchObject({
      page: { table: "notes", afterId: null },
    });
    expect(second.remote.pull).not.toHaveBeenCalled();
    expect(await storage.getHydrationState("notes")).toBe("ready");
    expect(await storage.listRecords("notes")).toHaveLength(ALL_NOTES.length);
  });

  it("keeps the earliest cursor across an interrupted and a resumed pass", async () => {
    const storage = new MemoryStorageAdapter();
    const config: DatafnSyncConfig = {
      hydration: { bootResources: ["notes"], clonePageSize: 2 },
    };
    // Pass 1 stores page 1 at seq 5 and page 2 at seq 6, then fails.
    const first = createEngine(
      storage,
      async (payload) => {
        if (payload.page?.afterId === "n4") throw new Error("network down");
        return pageResponse(
          payload.page!.afterId,
          payload.page!.limit,
          payload.page!.afterId === null ? "5" : "6",
        );
      },
      config,
    );
    await expect(first.engine.initializeSync()).rejects.toThrow("network down");
    expect(await storage.getCursor("notes")).toBe("5");

    let seq = 8;
    const second = createEngine(
      storage,
      async (payload) => {
        seq += 1;
        return pageResponse(payload.page!.afterId, payload.page!.limit, String(seq));
      },
      config,
    );
    await second.engine.initializeSync();

    // A pull from 5 replays changes (e.g. deletions) made to the records the
    // interrupted pass stored, which a cursor of 9 or later would skip.
    expect(await storage.getCursor("notes")).toBe("5");
    expect(await storage.getHydrationState("notes")).toBe("ready");
  });

  it("keeps an older stored cursor when a capped clone restarts the table", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.setCursor("notes", "3");
    const { engine } = createEngine(storage, async (payload) => {
      if (!payload.page) {
        return {
          ok: true,
          result: {
            ok: true,
            paginated: true,
            data: { notes: ALL_NOTES.slice(0, 2) },
            cursors: { notes: "10" },
            next: { notes: "n2" },
          },
        };
      }
      return pageResponse(payload.page.afterId, payload.page.limit, "11");
    });

    await engine.cloneNow();

    expect(await storage.getCursor("notes")).toBe("3");
  });

  it("keeps an older stored cursor when an uncapped clone restarts the table", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.setCursor("notes", "3");
    const { engine } = createEngine(storage, async () => pageResponse(null, 10, "12"));

    await engine.cloneNow();

    expect(await storage.getCursor("notes")).toBe("3");
    expect(await storage.getHydrationState("notes")).toBe("ready");
  });

  it("does not advance the global cursor past a kept earliest cursor", async () => {
    const storage = new MemoryStorageAdapter();
    let seq = 30;
    const { engine } = createEngine(
      storage,
      async (payload) => {
        seq += 1;
        return pageResponse(payload.page!.afterId, payload.page!.limit, String(seq));
      },
      { hydration: { bootResources: ["notes"], clonePageSize: 2 } },
    );
    await engine.cloneNow();
    const global = await storage.getCursor(GLOBAL_CURSOR_KEY);
    expect(global === null || Number(global) <= 31).toBe(true);
  });

  it("sets a fresh table's cursor to its first page's sequence", async () => {
    const storage = new MemoryStorageAdapter();
    let seq = 20;
    const { engine } = createEngine(
      storage,
      async (payload) => {
        seq += 1;
        return pageResponse(payload.page!.afterId, payload.page!.limit, String(seq));
      },
      { hydration: { bootResources: ["notes"], clonePageSize: 2 } },
    );
    await engine.cloneNow();
    expect(await storage.getCursor("notes")).toBe("21");
  });

  it("continues a clone the server capped instead of treating it as complete", async () => {
    const storage = new MemoryStorageAdapter();
    const { engine, remote } = createEngine(storage, async (payload) => {
      if (!payload.page) {
        return {
          ok: true,
          result: {
            ok: true,
            paginated: true,
            data: { notes: ALL_NOTES.slice(0, 2) },
            cursors: { notes: "10" },
            next: { notes: "n2" },
          },
        };
      }
      expect(await storage.getHydrationState("notes")).toBe("hydrating");
      return pageResponse(payload.page.afterId, payload.page.limit);
    });

    await engine.cloneNow();

    expect(remote.clone.mock.calls[1][0]).toMatchObject({
      page: { table: "notes", afterId: "n2" },
    });
    expect(await storage.getHydrationState("notes")).toBe("ready");
    expect(await storage.listRecords("notes")).toHaveLength(ALL_NOTES.length);
  });

  it("keeps the search index incomplete when the capped batch failed to index", async () => {
    const storage = new MemoryStorageAdapter();
    const searchProvider = {
      updateIndices: vi.fn(async ({ records }: { records: Array<{ id: string }> }) => {
        if (records.some((r) => r.id === "n1")) throw new Error("index failed");
      }),
    };
    const { engine } = createEngine(
      storage,
      async (payload) => {
        if (!payload.page) {
          return {
            ok: true,
            result: {
              ok: true,
              paginated: true,
              data: { notes: ALL_NOTES.slice(0, 2) },
              cursors: { notes: "10" },
              next: { notes: "n2" },
            },
          };
        }
        return pageResponse(payload.page.afterId, payload.page.limit);
      },
      {},
      searchProvider,
    );
    const marked = vi.spyOn(engine as any, "markSearchIndexComplete");

    await engine.cloneNow();

    expect(searchProvider.updateIndices).toHaveBeenCalledTimes(2);
    expect(marked.mock.calls.filter(([resource]) => resource === "notes")).toEqual([]);
    expect(await storage.getHydrationState("notes")).toBe("ready");
  });

  it("writes each page with the adapter's bulk upsert", async () => {
    const storage = new MemoryStorageAdapter();
    const bulkWrites: string[][] = [];
    (storage as any).upsertRecords = vi.fn(
      async (resource: string, records: Array<Record<string, unknown>>) => {
        bulkWrites.push(records.map((r) => r.id as string));
        for (const record of records) await storage.upsertRecord(resource, record);
      },
    );
    const single = vi.spyOn(storage, "upsertRecord");
    const { engine } = createEngine(
      storage,
      async (payload) => pageResponse(payload.page!.afterId, payload.page!.limit),
      { hydration: { bootResources: ["notes"], clonePageSize: 2 } },
    );

    await engine.cloneNow();

    expect(bulkWrites).toEqual([["n1", "n2"], ["n3", "n4"], ["n5"]]);
    // Only the bulk method itself called upsertRecord.
    expect(single).toHaveBeenCalledTimes(ALL_NOTES.length);
  });
});

describe("pulls during a clone", () => {
  it("leaves a table being cloned to the clone, then pulls it afterwards", async () => {
    const storage = new MemoryStorageAdapter();
    const pullPayloads: Array<Record<string, string>> = [];
    let engineRef: SyncEngine | undefined;
    const { engine, remote } = createEngine(
      storage,
      async (payload) => {
        if (payload.page?.afterId === "n2") {
          // A pull runs between two pages and sees a newer change to n4.
          await engineRef!.pullNow();
          return pageResponse(payload.page!.afterId, payload.page!.limit, "6");
        }
        return pageResponse(payload.page!.afterId, payload.page!.limit, "5");
      },
      { hydration: { bootResources: ["notes"], clonePageSize: 2 } },
    );
    engineRef = engine;
    remote.pull.mockImplementation(async (payload: any) => {
      pullPayloads.push({ ...payload.cursors });
      return {
        ok: true,
        result: {
          ok: true,
          records: { notes: [{ id: "n4", title: "from pull" }] },
          deleted: { notes: [] },
          cursors: { notes: "8", __datafn_actor_feed__: "20" },
          // More is pending, but a pull that left a table to the clone stops.
          hasMore: pullPayloads.length === 1,
        },
      };
    });

    await engine.cloneNow();
    // The pull scheduled once the clone ends.
    await vi.waitFor(() => expect(pullPayloads).toHaveLength(2));

    // During the clone the pull neither asked for nor wrote the table.
    expect(pullPayloads[0]).not.toHaveProperty("notes");
    // Afterwards it pulls from the earliest cursor the clone stored, and
    // re-reads the actor feed (share/unshare effects for the skipped table).
    expect(pullPayloads[1].notes).toBe("5");
    expect(pullPayloads[1].__datafn_actor_feed__).toBe(pullPayloads[0].__datafn_actor_feed__);
    expect(remote.pull).toHaveBeenCalledTimes(2);
  });
});

describe("pulls racing the end of a clone", () => {
  it("pulls again when the clone ends while a pull that left it out is in flight", async () => {
    const storage = new MemoryStorageAdapter();
    const pullPayloads: Array<Record<string, string>> = [];
    let releasePull: (() => void) | undefined;
    let pullDuringClone: Promise<void> | undefined;
    let engineRef: SyncEngine | undefined;
    const { engine, remote } = createEngine(
      storage,
      async (payload) => {
        if (payload.page?.afterId === "n2") {
          // A pull starts (leaving notes out) and is still waiting for its
          // response when the clone ends.
          pullDuringClone = engineRef!.pullNow();
          await vi.waitFor(() => expect(pullPayloads).toHaveLength(1));
        }
        return pageResponse(payload.page!.afterId, payload.page!.limit, "5");
      },
      { hydration: { bootResources: ["notes"], clonePageSize: 2 } },
    );
    engineRef = engine;
    remote.pull.mockImplementation(async (payload: any) => {
      pullPayloads.push({ ...payload.cursors });
      if (pullPayloads.length === 1) {
        await new Promise<void>((resolve) => {
          releasePull = resolve;
        });
      }
      return { ok: true, result: { ok: true, records: {}, deleted: {}, cursors: {} } };
    });

    await engine.cloneNow();
    releasePull!();
    await pullDuringClone;
    await vi.waitFor(() => expect(pullPayloads).toHaveLength(2));

    expect(pullPayloads[0]).not.toHaveProperty("notes");
    expect(pullPayloads[1].notes).toBe("5");
  });
});

describe("pulls and clones that overlap", () => {
  it("drops a pull's rows for a table cloned while the pull was out", async () => {
    const storage = new MemoryStorageAdapter();
    const pullPayloads: Array<Record<string, string>> = [];
    let engineRef: SyncEngine | undefined;
    const { engine, remote } = createEngine(storage, async () => pageResponse(null, 10, "9"));
    engineRef = engine;
    remote.pull.mockImplementation(async (payload: any) => {
      pullPayloads.push({ ...payload.cursors });
      if (pullPayloads.length === 1) {
        // A whole clone starts and ends while this response is in flight.
        await engineRef!.cloneNow();
        return {
          ok: true,
          result: {
            ok: true,
            records: { notes: [{ id: "n1", title: "stale" }] },
            deleted: { notes: [] },
            cursors: { notes: "3" },
          },
        };
      }
      return { ok: true, result: { ok: true, records: {}, deleted: {}, cursors: {} } };
    });

    await engine.pullNow();
    await vi.waitFor(() => expect(pullPayloads).toHaveLength(2));

    expect((await storage.getRecord("notes", "n1"))?.title).toBe("n1");
    expect(pullPayloads[1].notes).toBe("9");
  });

  it("starts a clone that begins while a pull writes its rows only after those writes", async () => {
    const storage = new MemoryStorageAdapter();
    const { engine, remote } = createEngine(storage, async (payload) =>
      pageResponse(payload.page?.afterId ?? null, payload.page?.limit ?? 10),
    );
    remote.pull.mockImplementation(async () => ({
      ok: true,
      result: {
        ok: true,
        records: { notes: [{ id: "n1", title: "stale" }] },
        deleted: { notes: [] },
        cursors: { notes: "3" },
      },
    }));
    const upsertRecord = storage.upsertRecord.bind(storage);
    let clone: Promise<void> | undefined;
    vi.spyOn(storage, "upsertRecord").mockImplementation(async (resource: string, record: any) => {
      if (record.title === "stale" && !clone) {
        // The clone starts after the pull chose what to write; given the
        // chance, it would finish before the pull's write lands.
        clone = engine.cloneNow();
        await Promise.race([clone, new Promise((resolve) => setTimeout(resolve, 50))]);
      }
      return upsertRecord(resource, record);
    });

    await engine.pullNow();
    await clone;

    expect((await storage.getRecord("notes", "n1"))?.title).toBe("n1");
  });

  it("leaves join stores of a cloning table out, keyed as pull cursors are", async () => {
    const joinSchema: DatafnSchema = {
      resources: [
        { name: "notes", version: 1, fields: [{ name: "title", type: "string", required: false }] },
        { name: "tags", version: 1, fields: [{ name: "name", type: "string", required: false }] },
      ],
      // No `relation` name: the store key falls back to `inverse`.
      relations: [{ from: "notes", to: "tags", type: "many-many", inverse: "notes" } as any],
    };
    const storage = new MemoryStorageAdapter();
    const pullPayloads: Array<Record<string, string>> = [];
    let engineRef: SyncEngine | undefined;
    const remote = {
      clone: vi.fn(async (payload: ClonePayload) => {
        if (payload.page?.afterId === "n2") await engineRef!.pullNow();
        const page = pageResponse(payload.page!.afterId, payload.page!.limit);
        return { ...page, result: { ...page.result, cursors: { notes: "10" } } };
      }),
      pull: vi.fn(async (payload: any) => {
        pullPayloads.push({ ...payload.cursors });
        return { ok: true, result: { ok: true, records: {}, deleted: {}, cursors: {} } };
      }),
      query: vi.fn(), mutation: vi.fn(), transact: vi.fn(), seed: vi.fn(), push: vi.fn(), reconcile: vi.fn(),
    };
    const engine = new SyncEngine(
      storage,
      remote as any,
      new EventBus(),
      "client-1",
      joinSchema,
      { hydration: { bootResources: ["notes"], clonePageSize: 2 } },
      [],
    );
    engineRef = engine;

    await engine.cloneNow();

    expect(pullPayloads[0]).not.toHaveProperty("join_notes_notes_tags");
    expect(pullPayloads[0]).not.toHaveProperty("notes");
  });
});

describe("start() superseded by stop()", () => {
  it("does not clear the state of a newer start() when its initial sync fails", async () => {
    const storage = new MemoryStorageAdapter();
    const pending: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    const { engine } = createEngine(
      storage,
      () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    );

    const first = engine.start();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    engine.stop();
    const second = engine.start();
    await vi.waitFor(() => expect(pending).toHaveLength(2));

    pending[0].reject(new Error("network down"));
    await expect(first).rejects.toThrow("network down");
    // The newer start still owns the engine: a third start() is a no-op.
    expect((engine as any).started).toBe(true);

    pending[1].resolve(pageResponse(null, 10));
    await second;
    engine.stop();
  });
});

describe("rate-limited clone requests", () => {
  const rateLimited = (retryAfterMs?: number) => ({
    ok: false,
    error: {
      code: "RATE_LIMITED",
      message: "Too many requests",
      details: retryAfterMs === undefined ? { path: "$" } : { path: "$", retryAfterMs },
    },
  });

  it("waits and retries a 429 page, then finishes the table", async () => {
    const storage = new MemoryStorageAdapter();
    let limitedOnce = false;
    const { engine, remote } = createEngine(
      storage,
      async (payload) => {
        if (payload.page?.afterId === "n2" && !limitedOnce) {
          limitedOnce = true;
          return rateLimited(5);
        }
        return pageResponse(payload.page!.afterId, payload.page!.limit);
      },
      { hydration: { bootResources: ["notes"], clonePageSize: 2 } },
    );

    await engine.cloneNow();

    expect(remote.clone).toHaveBeenCalledTimes(4);
    expect(await storage.getHydrationState("notes")).toBe("ready");
    expect(await storage.listRecords("notes")).toHaveLength(ALL_NOTES.length);
  });

  it("honours Retry-After before retrying", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorageAdapter();
      let calls = 0;
      const { engine, remote } = createEngine(storage, async () => {
        calls += 1;
        return calls === 1 ? rateLimited(30_000) : pageResponse(null, 10);
      });

      const done = engine.cloneNow();
      await vi.advanceTimersByTimeAsync(29_000);
      expect(remote.clone).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await done;
      expect(remote.clone).toHaveBeenCalledTimes(2);
      expect(await storage.getHydrationState("notes")).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits the full Retry-After even when it exceeds maxDelayMs", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorageAdapter();
      let calls = 0;
      const { engine, remote } = createEngine(
        storage,
        async () => {
          calls += 1;
          return calls === 1 ? rateLimited(600_000) : pageResponse(null, 10);
        },
        { cloneRateLimitRetry: { maxDelayMs: 60_000 } },
      );

      const done = engine.cloneNow();
      await vi.advanceTimersByTimeAsync(599_000);
      expect(remote.clone).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await done;
      expect(remote.clone).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the configured retries and leaves the table incomplete", async () => {
    const storage = new MemoryStorageAdapter();
    const { engine, remote } = createEngine(storage, async () => rateLimited(), {
      hydration: { bootResources: ["notes"], clonePageSize: 2 },
      cloneRateLimitRetry: { maxRetries: 2, baseDelayMs: 1, jitterMs: 0 },
    });

    await expect(engine.cloneNow()).rejects.toThrow("Too many requests");
    expect(remote.clone).toHaveBeenCalledTimes(3);
    expect(await storage.getHydrationState("notes")).not.toBe("ready");
  });

  it("treats a NaN maxRetries as the default instead of retrying forever", async () => {
    const storage = new MemoryStorageAdapter();
    const { engine, remote } = createEngine(storage, async () => rateLimited(), {
      cloneRateLimitRetry: { maxRetries: Number.NaN, baseDelayMs: 0, jitterMs: 0 },
    });

    await expect(engine.cloneNow()).rejects.toThrow("Too many requests");
    expect(remote.clone).toHaveBeenCalledTimes(7);
  });

  it("reports a 429 without a DataFn error body as rate limited", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("<html>slow down</html>", {
        status: 429,
        headers: { "Content-Type": "text/html", "Retry-After": "2" },
      }),
    );
    const transport = new DefaultHttpTransport("http://localhost/datafn", {
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result: any = await transport.clone({ clientId: "c1" });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("RATE_LIMITED");
    expect(result.error.details.retryAfterMs).toBe(2000);
  });

  it("reports a 429 whose error body has no rate-limit code as rate limited", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "busy" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "1" },
      }),
    );
    const transport = new DefaultHttpTransport("http://localhost/datafn", {
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result: any = await transport.clone({ clientId: "c1" });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("RATE_LIMITED");
    expect(result.error.message).toBe("busy");
    expect(result.error.details.retryAfterMs).toBe(1000);
  });

  it("bounds the backoff when the configured delays are not finite", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorageAdapter();
      let calls = 0;
      const { engine, remote } = createEngine(
        storage,
        async () => {
          calls += 1;
          return calls === 1 ? rateLimited() : pageResponse(null, 10);
        },
        {
          cloneRateLimitRetry: {
            baseDelayMs: Number.POSITIVE_INFINITY,
            maxDelayMs: Number.POSITIVE_INFINITY,
            jitterMs: 0,
          },
        },
      );

      const done = engine.cloneNow();
      // Defaults apply: the first retry waits baseDelayMs (1000 ms).
      await vi.advanceTimersByTimeAsync(1_000);
      await done;
      expect(remote.clone).toHaveBeenCalledTimes(2);
      expect(await storage.getHydrationState("notes")).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces the Retry-After header of a 429 response as retryAfterMs", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: { code: "RATE_LIMITED", message: "Too many requests", details: { path: "$" } },
        }),
        { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "3" } },
      ),
    );
    const transport = new DefaultHttpTransport("http://localhost/datafn", {
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result: any = await transport.clone({ clientId: "c1" });

    expect(result.error.code).toBe("RATE_LIMITED");
    expect(result.error.details).toEqual({ path: "$", retryAfterMs: 3000 });
  });
});

describe("IndexedDbStorageAdapter.upsertRecords", () => {
  it("writes every record in one transaction", async () => {
    const storage = new IndexedDbStorageAdapter(
      `clone_bulk_${Math.random()}`,
      ["notes"],
      schema,
    );
    const db: IDBDatabase = await (storage as any).dbPromise;
    const transaction = vi.spyOn(db, "transaction");

    await storage.upsertRecords(
      "notes",
      ALL_NOTES.map((n) => ({ ...n })),
    );

    expect(
      transaction.mock.calls.filter(([stores, mode]) => stores === "notes" && mode === "readwrite"),
    ).toHaveLength(1);
    transaction.mockRestore();
    expect((await storage.listRecords("notes")).map((r) => r.id)).toEqual(
      ALL_NOTES.map((n) => n.id),
    );
  });

  it("stores none of the records when one of them cannot be written", async () => {
    const storage = new IndexedDbStorageAdapter(
      `clone_bulk_abort_${Math.random()}`,
      ["notes"],
      schema,
    );

    await expect(
      storage.upsertRecords("notes", [{ id: "valid", title: "ok" }, { title: "no id" }]),
    ).rejects.toThrow();

    expect(await storage.listRecords("notes")).toEqual([]);
  });
});

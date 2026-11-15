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

/**
 * Lifecycle of the Pool that PostgresAdapter creates for `connectionString`, against a fake `pg`.
 *
 * Invariant: once dispose() starts, no operation creates another Pool, and every Pool the
 * adapter created is ended. No database is needed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SEARCH_ADAPTER_DISPOSED } from "@searchfn/adapter-contracts";
import { PostgresAdapter } from "../src/index";

const pg = vi.hoisted(() => {
  const pools: FakePool[] = [];
  let gate: Promise<void> | null = null;
  let reachedGate: (() => void) | null = null;

  class FakePool {
    ended = false;
    constructor() {
      pools.push(this);
    }
    async query(text: string) {
      if (this.ended) throw new Error("Cannot use a pool after calling end on the pool");
      if (gate && /SELECT doc_id, score/.test(text)) {
        const wait = gate;
        gate = null;
        reachedGate?.();
        await wait;
      }
      return { rows: /SELECT doc_id, score/.test(text) ? [{ doc_id: "1", score: 1 }] : [] };
    }
    async connect() {
      return { query: (text: string) => this.query(text), release: () => {} };
    }
    async end() {
      this.ended = true;
    }
  }

  return {
    Pool: FakePool,
    pools,
    /** Hold the next search statement until the returned release() is called. */
    holdNextSearch() {
      let release!: () => void;
      gate = new Promise<void>((resolve) => (release = resolve));
      const reached = new Promise<void>((resolve) => (reachedGate = resolve));
      return { reached, release };
    },
  };
});

vi.mock("pg", () => ({ Pool: pg.Pool, default: { Pool: pg.Pool } }));

const resources = [
  { name: "notes", searchFields: ["title"] },
  { name: "tasks", searchFields: ["title"] },
];

describe("PostgresAdapter owned Pool", () => {
  beforeEach(() => {
    pg.pools.length = 0;
  });

  it("creates no Pool after dispose() interrupts a multi-resource searchAll, and ends every Pool it created", async () => {
    const adapter = new PostgresAdapter({ connectionString: "postgres://localhost/db" });
    await adapter.initialize({ resources });
    expect(pg.pools).toHaveLength(1);

    const held = pg.holdNextSearch();
    const pending = adapter.searchAll({ query: "q", resources: ["notes", "tasks"] });
    await held.reached;
    await adapter.dispose();
    held.release();

    await expect(pending).rejects.toMatchObject({ code: SEARCH_ADAPTER_DISPOSED });
    expect(pg.pools).toHaveLength(1);
    expect(pg.pools.every((pool) => pool.ended)).toBe(true);
  });

  it("stops a multi-batch index after dispose() without creating a Pool", async () => {
    const adapter = new PostgresAdapter({ connectionString: "postgres://localhost/db", maxBatchSize: 1 });
    await adapter.initialize({ resources });

    const documents = [
      { id: "1", fields: { title: "a" } },
      { id: "2", fields: { title: "b" } },
    ];
    const pending = adapter.index({ resource: "notes", documents });
    await adapter.dispose();

    await expect(pending).rejects.toMatchObject({ code: SEARCH_ADAPTER_DISPOSED });
    expect(pg.pools).toHaveLength(1);
    expect(pg.pools.every((pool) => pool.ended)).toBe(true);
  });

  it("creates a fresh Pool on initialize() after dispose(), and ends it on the next dispose()", async () => {
    const adapter = new PostgresAdapter({ connectionString: "postgres://localhost/db" });
    await adapter.initialize({ resources });
    await adapter.dispose();
    await expect(adapter.search({ resource: "notes", query: "q" })).rejects.toMatchObject({ code: SEARCH_ADAPTER_DISPOSED });
    expect(pg.pools).toHaveLength(1);

    await adapter.initialize({ resources });
    expect(await adapter.search({ resource: "notes", query: "q" })).toEqual([1]);
    expect(pg.pools).toHaveLength(2);
    await adapter.dispose();
    expect(pg.pools.every((pool) => pool.ended)).toBe(true);
  });
});

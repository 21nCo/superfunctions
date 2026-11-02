import { describe, expect, it } from "vitest";
import { ChangeTrackingService } from "../src/execution/sync/change-tracking.js";
import { DatabaseSequenceStore } from "../src/execution/sync/sequence-store.js";
import type { Adapter } from "@superfunctions/db";

type Row = Record<string, unknown>;

/** The model only implements `internal`, which is all these code paths use. */
const asAdapter = (model: unknown) => model as Adapter;
type Where = { field: string; op: string; value: unknown }[];

/**
 * Models the PostgreSQL behaviour behind first-write sequence races: the base
 * adapter autocommits, each transaction sees committed rows plus its own
 * pending rows, an INSERT that conflicts with a committed or another
 * transaction's pending row fails, after any failed statement every later
 * statement in that transaction fails with "current transaction is aborted",
 * and an UPDATE waits for another transaction holding the row lock to finish
 * before re-checking its WHERE clause (READ COMMITTED).
 */
function createPostgresLikeMetaStore() {
  const committed = new Map<string, Row>();
  const transactions = new Set<{ pending: Map<string, Row>; aborted: boolean }>();
  const rowLocks = new Map<string, { owner: object; released: Promise<void> }>();
  const keyOf = (where: Where) => String(where.find((w) => w.field === "namespace")?.value);
  const matches = (row: Row | undefined, where: Where) =>
    Boolean(row) && where.every((w) => row![w.field] === w.value);

  const base = {
    internal: {
      ensureTable: async () => {},
      findOne: async (_table: string, where: Where) => {
        const row = committed.get(keyOf(where));
        return matches(row, where) ? { ...row } : null;
      },
      create: async (_table: string, data: Row) => {
        const key = String(data.namespace);
        if (committed.has(key)) throw new Error("duplicate key value violates unique constraint");
        committed.set(key, { ...data });
        return { ...data };
      },
      update: async (_table: string, where: Where, data: Row) => {
        const key = keyOf(where);
        const row = committed.get(key);
        if (!matches(row, where)) return 0;
        committed.set(key, { ...row, ...data });
        return 1;
      },
      findMany: async () => [],
      delete: async () => 0,
    },
  };

  function begin() {
    const tx = { pending: new Map<string, Row>(), aborted: false };
    transactions.add(tx);
    const releases: (() => void)[] = [];
    const lockRow = async (key: string) => {
      for (;;) {
        const held = rowLocks.get(key);
        if (!held || held.owner === tx) break;
        await held.released;
      }
      if (rowLocks.get(key)?.owner !== tx) {
        let release!: () => void;
        rowLocks.set(key, { owner: tx, released: new Promise<void>((resolve) => (release = resolve)) });
        releases.push(() => {
          rowLocks.delete(key);
          release();
        });
      }
    };
    const guard = () => {
      if (tx.aborted) throw new Error("current transaction is aborted, commands ignored until end of transaction block");
    };
    const adapter = {
      internal: {
        ensureTable: async () => guard(),
        findOne: async (_table: string, where: Where) => {
          guard();
          const key = keyOf(where);
          const row = tx.pending.get(key) ?? committed.get(key);
          return matches(row, where) ? { ...row } : null;
        },
        create: async (_table: string, data: Row) => {
          guard();
          const key = String(data.namespace);
          const takenElsewhere = [...transactions].some((other) => other !== tx && other.pending.has(key));
          if (committed.has(key) || tx.pending.has(key) || takenElsewhere) {
            tx.aborted = true;
            throw new Error("duplicate key value violates unique constraint");
          }
          tx.pending.set(key, { ...data });
          return { ...data };
        },
        update: async (_table: string, where: Where, data: Row) => {
          guard();
          const key = keyOf(where);
          await lockRow(key);
          const row = tx.pending.get(key) ?? committed.get(key);
          if (!matches(row, where)) return 0;
          tx.pending.set(key, { ...row, ...data });
          return 1;
        },
        findMany: async () => [],
        delete: async () => 0,
      },
    };
    const commit = () => {
      if (!tx.aborted) for (const [key, row] of tx.pending) committed.set(key, row);
      transactions.delete(tx);
      for (const release of releases.splice(0)) release();
    };
    return { adapter, commit };
  }

  return { base, begin, committed };
}

async function firstWrite(
  store: ReturnType<typeof createPostgresLikeMetaStore>,
  namespace: string,
  withSequenceStore: boolean,
) {
  const sequenceStore = withSequenceStore ? new DatabaseSequenceStore(asAdapter(store.base)) : undefined;
  const service = new ChangeTrackingService(asAdapter(store.base), namespace, sequenceStore);
  await service.ensureReady();
  const tx = store.begin();
  try {
    const seqs = await service.withDb(asAdapter(tx.adapter)).getNextServerSeqBatch(1);
    tx.commit();
    return seqs;
  } catch (error) {
    tx.commit();
    throw error;
  }
}

describe("first writes for a new namespace", () => {
  for (const withSequenceStore of [true, false]) {
    it(`allocate distinct sequences without aborting a transaction (${withSequenceStore ? "database sequence store" : "change tracking fallback"})`, async () => {
      const store = createPostgresLikeMetaStore();

      const results = await Promise.allSettled([
        firstWrite(store, "user:new", withSequenceStore),
        firstWrite(store, "user:new", withSequenceStore),
      ]);

      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      const seqs = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
      expect(new Set(seqs).size).toBe(2);
      expect(store.committed.get("user:new")?.next_server_seq).toBe(3);
    });
  }

  it("prepares a namespace's meta row once per adapter, outside the transaction", async () => {
    const store = createPostgresLikeMetaStore();
    let findOneCalls = 0;
    let createCalls = 0;
    const { findOne, create } = store.base.internal;
    store.base.internal.findOne = async (...args) => {
      findOneCalls += 1;
      return findOne(...args);
    };
    store.base.internal.create = async (...args) => {
      createCalls += 1;
      return create(...args);
    };

    await new ChangeTrackingService(asAdapter(store.base), "user:once").ensureReady();
    await new ChangeTrackingService(asAdapter(store.base), "user:once").ensureReady();

    expect(store.committed.get("user:once")).toMatchObject({ namespace: "user:once", next_server_seq: 1 });
    expect(findOneCalls).toBe(1);
    expect(createCalls).toBe(1);
  });
  it("keeps every namespace prepared concurrently on a fresh adapter", async () => {
    const store = createPostgresLikeMetaStore();
    const lookups: Record<string, number> = {};
    const { findOne } = store.base.internal;
    store.base.internal.findOne = async (table, where) => {
      const namespace = String(where.find((w) => w.field === "namespace")?.value);
      lookups[namespace] = (lookups[namespace] ?? 0) + 1;
      return findOne(table, where);
    };

    await Promise.all([
      new ChangeTrackingService(asAdapter(store.base), "user:a").ensureReady(),
      new ChangeTrackingService(asAdapter(store.base), "user:b").ensureReady(),
    ]);
    await Promise.all([
      new ChangeTrackingService(asAdapter(store.base), "user:a").ensureReady(),
      new ChangeTrackingService(asAdapter(store.base), "user:b").ensureReady(),
    ]);

    expect(lookups).toEqual({ "user:a": 1, "user:b": 1 });
  });
});

/**
 * DATA-8: a `merge` on the built-in KV resource merges the incoming value into
 * the stored value at the top level instead of replacing it.
 */

import { memoryAdapter } from "@superfunctions/db/adapters";
import type { Adapter } from "@superfunctions/db";
import { describe, expect, it } from "vitest";
import { createDatafnServer } from "../src/server.js";
import { updateKvRecordMerging } from "../src/execution/mutation/kv-merge.js";

type Json = Record<string, any>;

const schema = {
  resources: [
    {
      name: "note",
      version: 1,
      fields: [{ name: "meta", type: "json" as const, required: false }],
    },
  ],
};

async function serve(database: Adapter = memoryAdapter()) {
  const server = await createDatafnServer({ schema, database, allowUnknownResources: true });
  const send = async (route: string, body: unknown): Promise<{ status: number; body: Json }> => {
    const res = await server.router.handle(
      new Request(`http://localhost/datafn/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as Json };
  };
  const call = async (route: string, body: unknown): Promise<Json> => {
    const res = await send(route, body);
    expect(res.status).toBe(200);
    return res.body;
  };
  const storedValue = async (id = "kv:prefs") => {
    const read = await call("query", {
      resource: "kv",
      version: 1,
      select: ["id", "value"],
      filters: { id: { eq: id } },
    });
    return read.result.data[0]?.value;
  };
  return { server, send, call, storedValue };
}

let sequence = 0;
function kvMutation(value: unknown, options: { id?: string; mutationIdPrefix?: string; clientId?: string } = {}) {
  sequence += 1;
  const clientId = options.clientId ?? "client:a";
  return {
    resource: "kv",
    version: 1,
    operation: "merge",
    id: options.id ?? "kv:prefs",
    clientId,
    mutationId: `${options.mutationIdPrefix ?? "kv-merge-"}${sequence}`,
    record: { value },
  };
}

// The Nucleum reproduction: three partial merges into one preferences record.
const patches = [
  { name: "Ada", appearance: { theme: "dark", density: "compact" } },
  { appearanceProfiles: [{ id: "p1", theme: "dark" }], appliedAppearanceProfileId: "p1" },
  { appearance: { theme: "light" } },
];
const mergedValue = {
  name: "Ada",
  // Nested objects are replaced whole, as the client's mergeRecord does.
  appearance: { theme: "light" },
  appearanceProfiles: [{ id: "p1", theme: "dark" }],
  appliedAppearanceProfileId: "p1",
};

async function expectPullsCarryFullValue(call: (route: string, body: unknown) => Promise<Json>) {
  const globalPull = await call("pull", { clientId: "client:b", cursor: "0" });
  const kvChanges = globalPull.result.changes.filter((change: Json) => change.id === "kv:prefs");
  expect(kvChanges.at(-1).record.value).toEqual(mergedValue);

  const resourcePull = await call("pull", { clientId: "client:b", cursors: { kv: "0" } });
  const pulled = [
    ...(resourcePull.result.records?.kv ?? []),
    ...(resourcePull.result.merged?.kv ?? []),
  ].filter((record: Json) => record.id === "kv:prefs");
  expect(pulled.at(-1).value).toEqual(mergedValue);

  const cloned = await call("clone", { clientId: "client:c", tables: ["kv"] });
  expect(cloned.result.data.kv).toEqual([{ id: "kv:prefs", value: mergedValue }]);
}

/**
 * The latest change for the record, as each pull kind and the writer's own
 * pull apply it, carries exactly the expected value.
 */
async function expectLatestKvChangeCarries(
  call: (route: string, body: unknown) => Promise<Json>,
  expected: Json,
) {
  for (const clientId of ["client:a", "client:fresh"]) {
    const globalPull = await call("pull", { clientId, cursor: "0" });
    const kvChanges = globalPull.result.changes.filter((change: Json) => change.id === "kv:prefs");
    expect(kvChanges.at(-1).record.value).toEqual(expected);

    const resourcePull = await call("pull", { clientId, cursors: { kv: "0" } });
    const pulled = [
      ...(resourcePull.result.records?.kv ?? []),
      ...(resourcePull.result.merged?.kv ?? []),
    ].filter((record: Json) => record.id === "kv:prefs");
    expect(pulled.at(-1).value).toEqual(expected);
  }
}

/**
 * The record is deleted as every pull kind and the writer's own pull apply it:
 * the latest change is a delete, and nothing restores the record after it.
 */
async function expectKvRecordDeleted(call: (route: string, body: unknown) => Promise<Json>) {
  for (const clientId of ["client:a", "client:fresh"]) {
    const globalPull = await call("pull", { clientId, cursor: "0" });
    const kvChanges = globalPull.result.changes.filter((change: Json) => change.id === "kv:prefs");
    expect(kvChanges.at(-1)).toMatchObject({ op: "delete" });

    const resourcePull = await call("pull", { clientId, cursors: { kv: "0" } });
    expect(resourcePull.result.deleted?.kv).toContain("kv:prefs");
    expect((resourcePull.result.records?.kv ?? []).map((record: Json) => record.id)).not.toContain("kv:prefs");
  }
}

const noteInsert = (id: string) => ({
  resource: "note",
  version: 1,
  operation: "insert",
  id,
  clientId: "client:a",
  mutationId: `note-insert-${id}`,
  record: { meta: {} },
});

let deleteSequence = 0;
const kvDelete = () => ({
  resource: "kv",
  version: 1,
  operation: "delete",
  id: "kv:prefs",
  clientId: "client:a",
  mutationId: `kv-delete-${(deleteSequence += 1)}`,
});

describe("DATA-8: KV merge keeps every top-level key", () => {
  it("merges partial values sent to /mutation and pulls the full value", async () => {
    const { call, storedValue } = await serve();
    for (const patch of patches) {
      const res = await call("mutation", kvMutation(patch));
      expect(res.result.ok).toBe(true);
    }

    expect(await storedValue()).toEqual(mergedValue);
    await expectPullsCarryFullValue(call);
  });

  it("merges partial values pushed by a device and pulls the full value", async () => {
    const { call, storedValue } = await serve();
    for (const patch of patches) {
      const res = await call("push", { clientId: "client:a", mutations: [kvMutation(patch)] });
      expect(res.result.ok).toBe(true);
    }
    // Several merges of one record in a single push accumulate as well.
    const batch = await call("push", {
      clientId: "client:a",
      mutations: [kvMutation({ locale: "en" }), kvMutation({ timezone: "UTC" })],
    });
    expect(batch.result.ok).toBe(true);

    expect(await storedValue()).toEqual({ ...mergedValue, locale: "en", timezone: "UTC" });
  });

  it("creates a missing record with the patch", async () => {
    const { call, storedValue } = await serve();
    const res = await call("mutation", kvMutation({ only: true }, { id: "kv:new" }));
    expect(res.result.ok).toBe(true);
    expect(await storedValue("kv:new")).toEqual({ only: true });
  });

  it("replaces a stored value that is not an object", async () => {
    const { call, storedValue } = await serve();
    await call("mutation", kvMutation("plain", { mutationIdPrefix: "kv-set-" }));
    await call("mutation", kvMutation({ a: 1 }));
    expect(await storedValue()).toEqual({ a: 1 });
  });

  it("keeps kv.set as a replace on both write paths", async () => {
    const { call, storedValue } = await serve();
    await call("mutation", kvMutation({ a: 1, b: 2 }));
    await call("mutation", kvMutation({ c: 3 }, { mutationIdPrefix: "kv-set-" }));
    expect(await storedValue()).toEqual({ c: 3 });

    await call("push", { clientId: "client:a", mutations: [kvMutation({ d: 4 })] });
    await call("push", {
      clientId: "client:a",
      mutations: [kvMutation({ e: 5 }, { mutationIdPrefix: "kv-set-" })],
    });
    expect(await storedValue()).toEqual({ e: 5 });
  });

  it("keeps replacing the field for merges on other resources", async () => {
    const { call } = await serve();
    const note = (meta: Json, n: number) => ({
      resource: "note",
      version: 1,
      operation: "merge",
      id: "note:1",
      clientId: "client:a",
      mutationId: `note-${n}`,
      record: { meta },
    });
    await call("mutation", note({ a: 1 }, 1));
    await call("mutation", note({ b: 2 }, 2));
    const read = await call("query", { resource: "note", version: 1, select: ["id", "meta"] });
    expect(read.result.data).toEqual([{ id: "note:1", meta: { b: 2 } }]);
  });

  it("keeps every key when merges into one record arrive concurrently on both write paths", async () => {
    // The memory adapter runs each transaction as one queued operation, so
    // this checks the end-to-end outcome for concurrent requests on memory. It
    // does not exercise the row-lock step, which only matters on a database
    // that runs transactions concurrently (Postgres).
    const { call, storedValue } = await serve();
    await call("mutation", kvMutation({ seed: true }));

    const results = await Promise.all([
      call("mutation", kvMutation({ fromA: 1 }, { clientId: "client:a" })),
      call("push", { clientId: "client:b", mutations: [kvMutation({ fromB: 2 }, { clientId: "client:b" })] }),
      call("mutation", kvMutation({ fromC: 3 }, { clientId: "client:c" })),
    ]);
    expect(results.map((res) => res.result.ok)).toEqual([true, true, true]);
    const full = { seed: true, fromA: 1, fromB: 2, fromC: 3 };
    expect(await storedValue()).toEqual(full);
    await expectLatestKvChangeCarries(call, full);
  });

  it("records the full value last when a concurrent push commits between a multi-mutation push's changes", async () => {
    // Device A pushes [note insert, kv merge]. Its first change reserves
    // serverSeqs for the whole request. Device B's push to another server
    // commits a merge of the same KV record before A's merge runs, so B's
    // change takes a serverSeq above the one A reserved earlier.
    const base = memoryAdapter();
    let afterNoteInsert: (() => Promise<unknown>) | undefined;
    const deviceA = new Proxy(base, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return async (callback: (trx: Adapter) => Promise<unknown>) => {
          let insertedNote = false;
          const result = await target.transaction!(async (trx: Adapter) =>
            callback(new Proxy(trx, {
              get(trxTarget, trxProperty, trxReceiver) {
                const value = Reflect.get(trxTarget, trxProperty, trxReceiver);
                if (trxProperty !== "create") return value;
                return async (params: Parameters<Adapter["create"]>[0]) => {
                  const created = await (value as Adapter["create"]).call(trxTarget, params);
                  if (params.model === "note") insertedNote = true;
                  return created;
                };
              },
            }) as Adapter),
          );
          const run = insertedNote ? afterNoteInsert : undefined;
          if (run) {
            afterNoteInsert = undefined;
            await run();
          }
          return result;
        };
      },
    }) as Adapter;
    const a = await serve(deviceA);
    const b = await serve(base);
    await a.call("mutation", kvMutation({ seed: true }));

    afterNoteInsert = () =>
      b.call("push", { clientId: "client:b", mutations: [kvMutation({ fromB: 2 }, { clientId: "client:b" })] });
    const pushed = await a.call("push", {
      clientId: "client:a",
      mutations: [
        {
          resource: "note",
          version: 1,
          operation: "insert",
          id: "note:race",
          clientId: "client:a",
          mutationId: "note-race",
          record: { meta: {} },
        },
        kvMutation({ fromA: 1 }),
      ],
    });
    expect(pushed.result.ok).toBe(true);
    expect(afterNoteInsert).toBeUndefined();

    const full = { seed: true, fromA: 1, fromB: 2 };
    expect(await a.storedValue()).toEqual(full);
    await expectLatestKvChangeCarries(a.call, full);
    await expectLatestKvChangeCarries(b.call, full);
  });

  // One push reserves serverSeqs for the whole request at its first change.
  // A KV change takes a fresh serverSeq after its write, so every later change
  // of the same request must stay above it rather than take a reserved one.
  it("records a push's changes to one KV record in write order after a set, merge, set", async () => {
    const { call, storedValue } = await serve();
    const pushed = await call("push", {
      clientId: "client:a",
      mutations: [
        noteInsert("note:order"),
        kvMutation({ seed: true }, { mutationIdPrefix: "kv-set-" }),
        kvMutation({ fromMerge: true }),
        kvMutation({ final: true }, { mutationIdPrefix: "kv-set-" }),
        noteInsert("note:after"),
      ],
    });
    expect(pushed.result.ok).toBe(true);
    expect(await storedValue()).toEqual({ final: true });
    await expectLatestKvChangeCarries(call, { final: true });
    // The request's changes take increasing serverSeqs in write order.
    const pulled = await call("pull", { clientId: "client:fresh", cursor: "0" });
    expect(pulled.result.changes.map((change: Json) => change.id)).toEqual([
      "note:order", "kv:prefs", "kv:prefs", "kv:prefs", "note:after",
    ]);
  });

  it("keeps a KV record deleted when one push merges and then deletes it", async () => {
    const { call, storedValue } = await serve();
    const pushed = await call("push", {
      clientId: "client:a",
      mutations: [noteInsert("note:gone"), kvMutation({ seed: true }), kvDelete()],
    });
    expect(pushed.result.ok).toBe(true);
    expect(await storedValue()).toBeUndefined();
    await expectKvRecordDeleted(call);
  });
});

/**
 * Wraps an adapter so a where clause on the KV `value` column never matches,
 * as on MySQL, which never equals a JSON column to a string parameter. The
 * wrapper keeps the base adapter's transaction support.
 */
function withMysqlJsonEquality(base: Adapter, calls = { transactions: 0 }): Adapter {
  const matchesValue = (params: { where?: Array<{ field: string }> }) =>
    (params.where ?? []).some((clause) => clause.field === "value");
  return new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "findOne") {
        return async (params: Parameters<Adapter["findOne"]>[0]) =>
          matchesValue(params) ? null : (value as Adapter["findOne"]).call(target, params);
      }
      if (property === "findMany") {
        return async (params: Parameters<Adapter["findMany"]>[0]) =>
          matchesValue(params) ? [] : (value as Adapter["findMany"]).call(target, params);
      }
      if (property === "update") {
        return async (params: Parameters<Adapter["update"]>[0]) => {
          if (matchesValue(params)) throw { name: "NotFoundError", message: "Record not found" };
          return (value as Adapter["update"]).call(target, params);
        };
      }
      if (property === "transaction") {
        return async (callback: (trx: Adapter) => Promise<unknown>, options?: unknown) => {
          calls.transactions += 1;
          return (value as Adapter["transaction"]).call(
            target,
            async (trx) => callback(withMysqlJsonEquality(trx as unknown as Adapter, calls)),
            options as never,
          );
        };
      }
      return value;
    },
  }) as Adapter;
}

describe("DATA-8: KV merge does not depend on how the database compares JSON", () => {
  it("merges outside a transaction on an adapter with transactions without comparing the value", async () => {
    const calls = { transactions: 0 };
    const base = memoryAdapter();
    const db = withMysqlJsonEquality(base, calls);
    const { call, storedValue } = await serve(base);
    await call("mutation", kvMutation({ seed: true }));

    // The entry point a caller outside a transaction uses: it must take its own
    // transaction and lock the row instead of a compare-and-swap on the value.
    const written = await updateKvRecordMerging({
      db,
      resource: "kv",
      id: "kv:prefs",
      data: { value: { direct: 1 } },
      inTransaction: false,
    });
    expect(written.value).toEqual({ seed: true, direct: 1 });
    expect(calls.transactions).toBe(1);
    expect(await storedValue()).toEqual({ seed: true, direct: 1 });

    // A missing record still reports not found, so the caller creates it.
    await expect(
      updateKvRecordMerging({
        db,
        resource: "kv",
        id: "kv:missing",
        data: { value: { a: 1 } },
        inTransaction: false,
      }),
    ).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("keeps every key over /mutation and /push", async () => {
    const { call, storedValue } = await serve(withMysqlJsonEquality(memoryAdapter()));
    for (const [index, patch] of patches.entries()) {
      const res = index % 2
        ? await call("push", { clientId: "client:a", mutations: [kvMutation(patch)] })
        : await call("mutation", kvMutation(patch));
      expect(res.result.ok).toBe(true);
    }
    expect(await storedValue()).toEqual(mergedValue);
    await expectLatestKvChangeCarries(call, mergedValue);
  });

  it("falls back to the compare-and-swap when the adapter refuses to start a transaction", async () => {
    const base = memoryAdapter();
    const { call, storedValue } = await serve(base);
    await call("mutation", kvMutation({ seed: true }));
    const refusing = new Proxy(base, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return async () => {
          throw Object.assign(new Error("Transaction is not supported"), {
            name: "OperationNotSupportedError",
          });
        };
      },
    }) as Adapter;
    const written = await updateKvRecordMerging({
      db: refusing,
      resource: "kv",
      id: "kv:prefs",
      data: { value: { fallback: 1 } },
      inTransaction: false,
    });
    expect(written.value).toEqual({ seed: true, fallback: 1 });
    expect(await storedValue()).toEqual({ seed: true, fallback: 1 });
  });
});

/**
 * An adapter without transactions, as the default capabilities declare. With
 * `strictUpdateNotFound: false` (also the default) update() does not report a
 * write that matched nothing, so a KV merge must detect a missed conditional
 * write on its own.
 * - `holdWrites(n)`: the next n writes of a KV value wait until all n have
 *   arrived, so each merge read the record before any of them wrote.
 * - `missValueWrites`: that many conditional writes (a where on `value`)
 *   miss, as if another writer changed the value each time.
 * - `failValueWrites`: every KV value write throws a permanent error.
 */
function withoutTransactions(base: Adapter, strictUpdateNotFound: boolean) {
  const control = { missValueWrites: 0, failValueWrites: false, holdWrites };
  let held: Array<() => void> | undefined;
  let holdCount = 0;
  function holdWrites(count: number) {
    held = [];
    holdCount = count;
  }
  const gate = async () => {
    const waiting = held;
    if (!waiting) return;
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length >= holdCount) {
        held = undefined;
        for (const release of waiting) release();
      }
    });
  };
  type WriteParams = { model: string; where?: Array<{ field: string }>; data?: Record<string, unknown> };
  const db = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "transaction") return undefined;
      const value = Reflect.get(target, property, receiver);
      if (property === "capabilities") {
        return {
          ...value,
          operations: { ...value.operations, strictUpdateNotFound },
          transactions: { ...value.transactions, supported: false },
        };
      }
      if (property !== "update" && property !== "updateMany") return value;
      return async (params: WriteParams) => {
        if (params.model === "kv" && params.data && "value" in params.data) {
          await gate();
          if (control.failValueWrites) throw new Error("disk I/O error");
          if (control.missValueWrites > 0 && (params.where ?? []).some((clause) => clause.field === "value")) {
            control.missValueWrites -= 1;
            return property === "updateMany" ? 0 : undefined;
          }
        }
        return (value as (params: WriteParams) => Promise<unknown>).call(target, params);
      };
    },
  }) as Adapter;
  return { db, control };
}

describe.each([
  ["neither transactions nor strictUpdateNotFound", false],
  ["strictUpdateNotFound but no transactions", true],
] as const)("DATA-8: KV merge on an adapter with %s", (_label, strictUpdateNotFound) => {
  it("keeps both keys when two merges read the record before either writes", async () => {
    const { db, control } = withoutTransactions(memoryAdapter(), strictUpdateNotFound);
    const { call, storedValue } = await serve(db);
    await call("mutation", kvMutation({ seed: true }));

    control.holdWrites(2);
    const merge = (value: Json) =>
      updateKvRecordMerging({ db, resource: "kv", id: "kv:prefs", data: { value }, inTransaction: false });
    const written = await Promise.all([merge({ a: 1 }), merge({ b: 2 })]);
    expect(await storedValue()).toEqual({ seed: true, a: 1, b: 2 });
    // The merge that wrote last reports the complete value it wrote.
    expect(written.map((row) => row.value)).toContainEqual({ seed: true, a: 1, b: 2 });

    control.holdWrites(2);
    const results = await Promise.all([
      call("mutation", kvMutation({ fromMutation: 1 })),
      call("push", { clientId: "client:b", mutations: [kvMutation({ fromPush: 2 }, { clientId: "client:b" })] }),
    ]);
    expect(results.map((res) => res.result.ok)).toEqual([true, true]);
    const full = { seed: true, a: 1, b: 2, fromMutation: 1, fromPush: 2 };
    expect(await storedValue()).toEqual(full);
    await expectLatestKvChangeCarries(call, full);
  });

  it("keeps every key for sequential merges over /mutation and /push", async () => {
    const { db } = withoutTransactions(memoryAdapter(), strictUpdateNotFound);
    const { call, storedValue } = await serve(db);
    for (const [index, patch] of patches.entries()) {
      const res = index % 2
        ? await call("push", { clientId: "client:a", mutations: [kvMutation(patch)] })
        : await call("mutation", kvMutation(patch));
      expect(res.result.ok).toBe(true);
    }
    expect(await storedValue()).toEqual(mergedValue);
    await expectLatestKvChangeCarries(call, mergedValue);
  });

  it("reports a merge that gave up under contention as retryable, and its retry succeeds", async () => {
    const { db, control } = withoutTransactions(memoryAdapter(), strictUpdateNotFound);
    const { send, call, storedValue } = await serve(db);
    await call("mutation", kvMutation({ seed: true }));

    // Every conditional write misses until the merge gives up, writing nothing.
    control.missValueWrites = 1000;
    const viaMutation = kvMutation({ a: 1 });
    const failed = await call("mutation", viaMutation);
    expect(failed.result.ok).toBe(false);
    expect(failed.result.errors[0]).toMatchObject({ code: "INTERNAL", retryable: true });
    const viaPush = { clientId: "client:a", mutations: [kvMutation({ b: 2 })] };
    const failedPush = await send("push", viaPush);
    expect(failedPush.body.result.errors[0]).toMatchObject({ code: "INTERNAL", retryable: true });
    expect(await storedValue()).toEqual({ seed: true });

    // Retrying the same mutations once the contention ends applies them.
    control.missValueWrites = 0;
    expect((await call("mutation", viaMutation)).result.ok).toBe(true);
    expect((await call("push", viaPush)).result.ok).toBe(true);
    expect(await storedValue()).toEqual({ seed: true, a: 1, b: 2 });
    await expectLatestKvChangeCarries(call, { seed: true, a: 1, b: 2 });
  });

  it("keeps a permanent write failure terminal on /mutation", async () => {
    const { db, control } = withoutTransactions(memoryAdapter(), strictUpdateNotFound);
    const { call, storedValue } = await serve(db);
    await call("mutation", kvMutation({ seed: true }));

    control.failValueWrites = true;
    const failed = await call("mutation", kvMutation({ a: 1 }));
    expect(failed.result.ok).toBe(false);
    expect(failed.result.errors[0]).toMatchObject({ code: "INTERNAL", retryable: false });
    control.failValueWrites = false;
    expect(await storedValue()).toEqual({ seed: true });
  });
});

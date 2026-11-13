/**
 * DATA-8: a `merge` on the built-in KV resource merges the incoming value into
 * the stored value at the top level instead of replacing it.
 */

import { memoryAdapter } from "@superfunctions/db/adapters";
import type { Adapter } from "@superfunctions/db";
import { describe, expect, it } from "vitest";
import { createDatafnServer } from "../src/server.js";

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
  const call = async (route: string, body: unknown): Promise<Json> => {
    const res = await server.router.handle(
      new Request(`http://localhost/datafn/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as Json;
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
  return { server, call, storedValue };
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

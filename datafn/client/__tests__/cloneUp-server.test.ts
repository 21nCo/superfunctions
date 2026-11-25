/**
 * DATA-12: cloneUp against an in-memory DataFn server (`@datafn/server` over
 * the memory adapter, reached through `sync.http.fetch`). cloneUp uploads only
 * the fields the server accepts, and reports every batch the server rejects
 * as a failure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// @datafn/server resolves to its source through the alias in vitest.config.ts.
import { createDatafnServer } from "@datafn/server";
import { memoryAdapter } from "@superfunctions/db/adapters";
import type { DatafnSchema } from "@datafn/core";
import { createDatafnClient } from "../src/client.js";
import { MemoryStorageAdapter } from "../src/adapters/memoryStorage.js";
import { DefaultHttpTransport } from "../src/transport/http.js";

const GLOBAL_CURSOR = "__global_cursor__";

const serverSchema: DatafnSchema = {
  resources: [
    { name: "goals", version: 1, fields: [{ name: "label", type: "string", required: true }] },
    {
      name: "tasks",
      version: 1,
      fields: [
        { name: "title", type: "string", required: true },
        { name: "goalId", type: "string", required: false },
      ],
    },
  ],
  relations: [
    {
      from: "tasks",
      to: "goals",
      type: "many-one",
      relation: "goal",
      inverse: "tasks",
      fkField: "goalId",
      inheritsInactive: true,
    },
  ],
};

type Server = Awaited<ReturnType<typeof createDatafnServer>>;
type Device = {
  client: ReturnType<typeof createDatafnClient>;
  storage: MemoryStorageAdapter;
  /** JSON bodies of every /datafn/push request the device sent. */
  pushes: Array<{ mutations: Array<Record<string, unknown>> }>;
  events: Array<{ type: string; context?: any }>;
};

let server: Server;
let devices: Device[] = [];

beforeEach(async () => {
  server = await createDatafnServer({
    schema: serverSchema,
    database: memoryAdapter(),
    allowUnknownResources: true,
    debug: true,
  });
});

afterEach(async () => {
  for (const device of devices) device.client.sync.stop();
  devices = [];
  await server.close();
});

function connectDevice(
  name: string,
  schema: DatafnSchema = serverSchema,
  offlinability = false,
): Device {
  const storage = new MemoryStorageAdapter();
  const pushes: Device["pushes"] = [];
  const events: Device["events"] = [];
  const client = createDatafnClient({
    clientId: `client:${name}`,
    schema,
    storage,
    sync: {
      offlinability,
      remote: "http://datafn.test/datafn",
      http: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          if (new URL(request.url).pathname === "/datafn/push") {
            pushes.push(await request.clone().json());
          }
          return server.router.handle(request);
        },
      },
    },
  });
  client.subscribe((event: any) => {
    events.push(event);
  });
  const device = { client, storage, pushes, events };
  devices.push(device);
  return device;
}

/** Records the server holds for `resource`, read by a fresh device's clone. */
async function serverRecords(resource: string) {
  const reader = connectDevice(`reader-${devices.length}`, serverSchema, true);
  await reader.client.sync.cloneNow();
  const records = await reader.storage.listRecords(resource);
  return records.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function cloneUpEvents(device: Device) {
  return device.events.filter(
    (e) => (e.type === "sync_applied" || e.type === "sync_failed") && e.context?.phase === "cloneup",
  );
}

describe("DATA-12: cloneUp uploads only fields the server accepts", () => {
  it("drops the read-only isAncestorInactive system field and an undeclared field, and the server keeps the records", async () => {
    const device = connectDevice("a");
    await device.storage.upsertRecord("goals", { id: "goals:g1", label: "Ship" });
    await device.storage.upsertRecord("tasks", {
      id: "tasks:t1",
      title: "Write tests",
      goalId: "goals:g1",
      // DataFn-owned: the server rejects a client write of it.
      isAncestorInactive: true,
      // No longer declared by the schema (e.g. a removed capability field).
      visibility: "public",
    });

    const result = await device.client.sync.cloneUp({ pullAfter: false });

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.stats.resources).toEqual({
      goals: { records: 1, mutations: 1 },
      tasks: { records: 1, mutations: 1 },
    });

    const sentTask = device.pushes
      .flatMap((push) => push.mutations)
      .find((mutation) => mutation.id === "tasks:t1");
    expect(sentTask?.record).toEqual({ title: "Write tests", goalId: "goals:g1" });

    const [task] = await serverRecords("tasks");
    expect(task).toMatchObject({ id: "tasks:t1", title: "Write tests", goalId: "goals:g1" });
    // The server computed the system field itself: the goal is active.
    expect(task.isAncestorInactive).toBe(false);
    expect(task).not.toHaveProperty("visibility");
    expect(await serverRecords("goals")).toMatchObject([{ id: "goals:g1", label: "Ship" }]);

    expect(cloneUpEvents(device).map((e) => e.type)).toEqual(["sync_applied"]);
  });

  it("drops a field the client schema marks read-only", async () => {
    const clientSchema: DatafnSchema = {
      ...serverSchema,
      resources: [
        serverSchema.resources[0],
        {
          name: "tasks",
          version: 1,
          fields: [
            { name: "title", type: "string", required: true },
            { name: "goalId", type: "string", required: false },
            { name: "score", type: "number", required: false, readonly: true },
          ],
        },
      ],
    };
    const device = connectDevice("a", clientSchema);
    await device.storage.upsertRecord("tasks", { id: "tasks:t1", title: "Write tests", score: 3 });

    const result = await device.client.sync.cloneUp({ pullAfter: false, resources: ["tasks"] });

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(device.pushes[0].mutations[0].record).toEqual({ title: "Write tests" });
  });
});

describe("DATA-12: cloneUp reports a batch the server rejects", () => {
  it("whole-batch rejection (top-level error, no per-mutation result): ok false, sync_failed, cursor not advanced", async () => {
    // The client's schema still declares a field the server's schema dropped,
    // so the server's validation rejects the whole batch before executing it.
    const clientSchema: DatafnSchema = {
      ...serverSchema,
      resources: [
        serverSchema.resources[0],
        {
          name: "tasks",
          version: 1,
          fields: [
            { name: "title", type: "string", required: true },
            { name: "goalId", type: "string", required: false },
            { name: "legacyNote", type: "string", required: false },
          ],
        },
      ],
    };
    const device = connectDevice("a", clientSchema);
    await device.storage.setCursor(GLOBAL_CURSOR, "0");
    await device.storage.upsertRecord("tasks", { id: "tasks:t1", title: "Accepted" });
    await device.storage.upsertRecord("tasks", { id: "tasks:t2", title: "Rejected", legacyNote: "x" });

    const result = await device.client.sync.cloneUp({
      resources: ["tasks"],
      batchSize: 1,
      pullAfter: false,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        mutationId: "",
        code: "DFQL_UNKNOWN_FIELD",
        message: expect.stringContaining("legacyNote"),
        path: expect.any(String),
      },
    ]);
    expect(result.stats.batches).toBe(2);

    const failures = cloneUpEvents(device);
    expect(failures.map((e) => e.type)).toEqual(["sync_failed"]);
    expect(failures[0].context.error.errors).toEqual(result.errors);

    // The first batch reached the server; the rejected one did not.
    expect((await serverRecords("tasks")).map((r) => r.id)).toEqual(["tasks:t1"]);
    // The global cursor does not move past the rejected batch.
    expect(await device.storage.getCursor(GLOBAL_CURSOR)).toBe("0");
  });

  it("per-mutation rejection (result.errors): ok false, sync_failed, cursor not advanced", async () => {
    const first = connectDevice("a");
    await first.storage.upsertRecord("tasks", { id: "tasks:t1", title: "From device a" });
    expect((await first.client.sync.cloneUp({ pullAfter: false })).ok).toBe(true);

    // A second device inserts a record the server already holds with other content.
    const device = connectDevice("b");
    await device.storage.setCursor(GLOBAL_CURSOR, "0");
    await device.storage.upsertRecord("tasks", { id: "tasks:t1", title: "From device b" });
    await device.storage.changelogAppend({
      clientId: "client:b",
      mutationId: "offline:m1",
      timestampMs: 1,
      mutation: { resource: "tasks", operation: "merge", id: "tasks:t1" },
    } as any);

    const result = await device.client.sync.cloneUp({
      recordOperation: "insert",
      pullAfter: false,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        mutationId: expect.stringMatching(/^cloneup:rec:tasks:tasks:t1:/),
        code: "CONFLICT",
        message: "Record already exists",
      }),
    ]);
    const failures = cloneUpEvents(device);
    expect(failures.map((e) => e.type)).toEqual(["sync_failed"]);
    expect(failures[0].context.error.errors).toEqual(result.errors);
    expect(await device.storage.getCursor(GLOBAL_CURSOR)).toBe("0");
    expect(await device.storage.changelogList({ limit: 10 })).toHaveLength(1);
    expect((await serverRecords("tasks"))[0]).toMatchObject({ title: "From device a" });
  });
});

describe("DATA-12: cloneUp reads every push rejection shape", () => {
  const schema: DatafnSchema = {
    resources: [{ name: "tasks", version: 1, fields: [{ name: "title", type: "string" }] }],
    relations: [],
  };

  async function cloneUpWith(responses: unknown[], failFast: boolean) {
    const storage = new MemoryStorageAdapter();
    await storage.setCursor(GLOBAL_CURSOR, "0");
    await storage.upsertRecord("tasks", { id: "tasks:t1", title: "a" });
    await storage.upsertRecord("tasks", { id: "tasks:t2", title: "b" });
    const push = vi.spyOn(DefaultHttpTransport.prototype, "push");
    for (const response of responses) push.mockResolvedValueOnce(response);
    const events: any[] = [];
    const client = createDatafnClient({
      schema,
      sync: { remote: "http://example.com" },
      clientId: "client:device-1",
      storage,
    });
    client.subscribe((event: any) => {
      events.push(event);
    });
    try {
      const result = await client.sync.cloneUp({ batchSize: 1, pullAfter: false, failFast });
      return { result, events, storage, pushCalls: push.mock.calls.length };
    } finally {
      push.mockRestore();
    }
  }

  it("a bare ok:false with no error details still fails", async () => {
    const { result, events, storage, pushCalls } = await cloneUpWith([{ ok: false }], true);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { mutationId: "", code: "PUSH_REJECTED", message: "Push rejected by server", path: "$" },
    ]);
    expect(pushCalls).toBe(1);
    expect(events.filter((e) => e.type === "sync_failed")).toHaveLength(1);
    expect(await storage.getCursor(GLOBAL_CURSOR)).toBe("0");
  });

  it("failFast false collects top-level rejections from every batch and still fails", async () => {
    const reject = (message: string) => ({
      ok: false,
      error: { code: "DFQL_INVALID", message, details: { path: "mutations[0].record.x" } },
    });
    const { result, events, storage, pushCalls } = await cloneUpWith(
      [reject("first"), reject("second")],
      false,
    );
    expect(pushCalls).toBe(2);
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.message)).toEqual(["first", "second"]);
    expect(result.errors[0]).toEqual({
      mutationId: "",
      code: "DFQL_INVALID",
      message: "first",
      path: "mutations[0].record.x",
    });
    expect(events.filter((e) => e.type === "sync_failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "sync_applied")).toHaveLength(0);
    expect(await storage.getCursor(GLOBAL_CURSOR)).toBe("0");
  });
});

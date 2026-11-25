/**
 * DATA-41: the client holds a record's revision only together with the
 * complete server row at that revision.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatafnServer } from "@datafn/server";
import { memoryAdapter } from "@superfunctions/db/adapters";
import type { DatafnSchema } from "@datafn/core";
import { createDatafnClient } from "../src/client.js";
import { MemoryStorageAdapter } from "../src/adapters/memoryStorage.js";
import { IndexedDbStorageAdapter } from "../src/adapters/indexedDbStorage.js";
import { DefaultHttpTransport } from "../src/transport/http.js";
import { EventBus } from "../src/events/bus.js";
import { SyncEngine } from "../src/sync/engine.js";
import type { DatafnE2eeProvider } from "../src/e2ee.js";

const schema: DatafnSchema = {
  resources: [
    {
      name: "task",
      version: 1,
      fields: [
        { name: "title", type: "string", required: false },
        { name: "notes", type: "string", required: false },
      ],
    },
  ],
};

type Server = Awaited<ReturnType<typeof createDatafnServer>>;
const servers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) await server.close();
});

async function startServer(enabled = true): Promise<Server> {
  const server = await createDatafnServer({
    schema,
    database: memoryAdapter(),
    allowUnknownResources: true,
    ...(enabled ? { revisions: { enabled: true } } : {}),
  });
  servers.push(server);
  return server;
}

function transport(server: Server, requests: string[] = []) {
  return new DefaultHttpTransport("http://datafn.test/datafn", {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(`${new URL(request.url).pathname} ${await request.clone().text()}`);
      return server.router.handle(request);
    },
  });
}

async function serverPush(server: Server, clientId: string, mutations: Array<Record<string, unknown>>) {
  const res = await server.router.handle(new Request("http://datafn.test/datafn/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId,
      mutations: mutations.map((m, i) => ({ version: 1, clientId, mutationId: `${clientId}-${Date.now()}-${i}`, ...m })),
    }),
  }));
  return res.json();
}

function engineFor(server: Server, storage: MemoryStorageAdapter | IndexedDbStorageAdapter, clientId = "client:a") {
  return new SyncEngine(storage, transport(server) as any, new EventBus(), clientId, schema, { offlinability: true } as any);
}

async function appendLocal(storage: MemoryStorageAdapter, mutation: Record<string, unknown>) {
  const mutationId = `local-${Math.random()}`;
  await storage.changelogAppend({
    clientId: "client:a",
    mutationId,
    timestampMs: Date.now(),
    mutation: { version: 1, clientId: "client:a", mutationId, ...mutation },
  });
}

describe("DATA-41 client revisions", () => {
  it("installs clone rows with their revisions and clears the revision on a local write", async () => {
    const server = await startServer();
    await serverPush(server, "seed", [{ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } }]);
    const storage = new MemoryStorageAdapter(["task"]);
    await engineFor(server, storage).cloneNow();

    const pair = await storage.getRecordWithRevision("task", "task:1");
    expect(pair).toEqual({ record: expect.objectContaining({ id: "task:1", title: "a" }), rev: 1 });
    expect(pair.record).not.toHaveProperty("$rev");

    await storage.mergeRecord("task", "task:1", { title: "local" });
    expect((await storage.getRecordWithRevision("task", "task:1")).rev).toBeUndefined();
  });

  it("after a push holds the server's post-write row, not its own optimistic state, with the revision", async () => {
    const server = await startServer();
    await serverPush(server, "seed", [{ resource: "task", operation: "insert", id: "task:1", record: { title: "a", notes: "n0" } }]);
    const storage = new MemoryStorageAdapter(["task"]);
    const engine = engineFor(server, storage);
    await engine.cloneNow();
    // Another device changes a field this client never pulls.
    await serverPush(server, "other", [{ resource: "task", operation: "merge", id: "task:1", record: { notes: "n1" } }]);

    await storage.mergeRecord("task", "task:1", { title: "b" });
    await appendLocal(storage, { resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });
    await engine.processPush();

    const pair = await storage.getRecordWithRevision("task", "task:1");
    expect(pair.rev).toBe(3);
    expect(pair.record).toMatchObject({ id: "task:1", title: "b", notes: "n1" });
  });

  it("keeps the revision unknown after a pull that delivers a partial merge, and for a pending local change", async () => {
    const server = await startServer();
    await serverPush(server, "seed", [{ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } }]);
    const storage = new MemoryStorageAdapter(["task"]);
    const engine = engineFor(server, storage);
    await engine.cloneNow();
    expect((await storage.getRecordWithRevision("task", "task:1")).rev).toBe(1);

    await serverPush(server, "other", [{ resource: "task", operation: "merge", id: "task:1", record: { title: "b" } }]);
    await engine.pullNow();
    const afterPull = await storage.getRecordWithRevision("task", "task:1");
    expect(afterPull.record).toMatchObject({ title: "b" });
    expect(afterPull.rev).toBeUndefined();

    // A versioned read installs the server pair, unless a local change is pending.
    await appendLocal(storage, { resource: "task", operation: "merge", id: "task:1", record: { title: "mine" } });
    const installed = await storage.putRecordsWithRevisions("task", [{ id: "task:1", record: { id: "task:1", title: "b" }, rev: 2 }], {
      unlessPending: true,
    });
    expect(installed).toEqual([]);
    expect((await storage.getRecordWithRevision("task", "task:1")).rev).toBeUndefined();
  });

  it("stores a delete pulled from the server as a tombstone revision", async () => {
    const server = await startServer();
    await serverPush(server, "seed", [{ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } }]);
    const storage = new MemoryStorageAdapter(["task"]);
    const engine = engineFor(server, storage);
    await engine.cloneNow();
    await serverPush(server, "other", [{ resource: "task", operation: "delete", id: "task:1" }]);
    await engine.pullNow();
    expect(await storage.getRecordWithRevision("task", "task:1")).toEqual({ record: null, rev: 2 });
  });

  it("leaves revisions unknown for changes pulled from before enablement", async () => {
    const server = await startServer(false);
    await serverPush(server, "seed", [{ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } }]);
    const storage = new MemoryStorageAdapter(["task"]);
    await engineFor(server, storage).pullNow();
    const pair = await storage.getRecordWithRevision("task", "task:1");
    expect(pair.record).toMatchObject({ title: "a" });
    expect(pair.rev).toBeUndefined();
  });

  it("reads a record and its revision with a versioned query in direct mode and reports server capabilities", async () => {
    const server = await startServer();
    await serverPush(server, "seed", [{ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } }]);
    const client = createDatafnClient({
      schema,
      clientId: "client:direct",
      sync: { remote: "http://datafn.test/datafn", http: { fetch: (i: any, init?: any) => server.router.handle(new Request(i, init)) } },
    });
    expect(client.serverCapabilities()).toEqual({ revisions: false });
    const result: any = await client.query({ resource: "task", version: 1, withRevisions: true, filters: { id: "task:1" } });
    expect(result.data).toEqual([expect.objectContaining({ id: "task:1", title: "a", $rev: 1 })]);
    expect(client.serverCapabilities()).toEqual({ revisions: true });
    expect(await client.getRevision("task", "task:1")).toBeUndefined();
  });

  it("sends a versioned query from a hydrated client to the server and installs the pair", async () => {
    const server = await startServer();
    await serverPush(server, "seed", [{ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } }]);
    const storage = new MemoryStorageAdapter(["task"]);
    const requests: string[] = [];
    const client = createDatafnClient({
      schema,
      clientId: "client:hydrated",
      storage,
      sync: { offlinability: true, remote: "http://datafn.test/datafn", http: { fetch: async (i: any, init?: any) => {
        const request = new Request(i, init);
        requests.push(new URL(request.url).pathname);
        return server.router.handle(request);
      } } },
    });
    await client.sync.cloneNow();
    await storage.mergeRecord("task", "task:1", { title: "partial" });
    expect(await client.getRevision("task", "task:1")).toBeUndefined();

    const result: any = await client.query({ resource: "task", version: 1, withRevisions: true, filters: { id: "task:1" } });
    expect(requests).toContain("/datafn/query");
    expect(result.data[0]).toMatchObject({ id: "task:1", title: "a", $rev: 1 });
    expect(await client.getWithRevision("task", "task:1")).toEqual({
      record: expect.objectContaining({ id: "task:1", title: "a" }),
      rev: 1,
    });
  });

  it("allows only a versioned read by id on an E2EE resource and decrypts it", async () => {
    const server = await startServer();
    const provider: DatafnE2eeProvider = {
      keyRef: "test-key",
      async encrypt({ plaintext, resource, id, field }) {
        return { __datafnE2ee: 1, alg: "AES-GCM", keyRef: "test-key", iv: `${resource}:${id}:${field}`, data: JSON.stringify([...plaintext]) } as any;
      },
      async decrypt({ envelope }) {
        return new Uint8Array(JSON.parse((envelope as any).data));
      },
    };
    const requests: string[] = [];
    const client = createDatafnClient({
      schema,
      clientId: "client:e2ee",
      e2ee: { enabled: true, provider },
      sync: { remote: "http://datafn.test/datafn", http: { fetch: async (i: any, init?: any) => {
        const request = new Request(i, init);
        requests.push(`${new URL(request.url).pathname} ${await request.clone().text()}`);
        return server.router.handle(request);
      } } },
    });
    await client.mutate({ resource: "task", version: 1, operation: "insert", id: "task:1", record: { title: "secret title" } });
    expect(requests.join("\n")).not.toContain("secret title");

    const read: any = await client.query({ resource: "task", version: 1, withRevisions: true, filters: { id: { $in: ["task:1"] } } });
    expect(read.data[0]).toMatchObject({ id: "task:1", title: "secret title", $rev: 1 });

    const before = requests.length;
    await expect(client.query({
      resource: "task", version: 1, withRevisions: true, filters: { title: "secret title" },
    })).rejects.toMatchObject({ code: "DFQL_UNSUPPORTED" });
    await expect(client.query({
      resource: "task", version: 1, withRevisions: true, filters: { id: "task:1" }, sort: ["title:asc"],
    })).rejects.toMatchObject({ code: "DFQL_UNSUPPORTED" });
    expect(requests.length).toBe(before);
  });

  it("keeps revisions across a reopen of the IndexedDB adapter and clears them on a plain write", async () => {
    const dbName = `revisions_${Math.random()}`;
    const first = new IndexedDbStorageAdapter(dbName, ["task"], schema as any);
    expect(await first.putRecordsWithRevisions("task", [{ id: "task:1", record: { id: "task:1", title: "a" }, rev: 4 }])).toEqual(["task:1"]);
    await first.close();
    const reopened = new IndexedDbStorageAdapter(dbName, ["task"], schema as any);
    expect(await reopened.getRecordWithRevision("task", "task:1")).toEqual({
      record: { id: "task:1", title: "a" },
      rev: 4,
    });
    await reopened.upsertRecord("task", { id: "task:1", title: "b" });
    expect(await reopened.getRecordWithRevision("task", "task:1")).toEqual({
      record: { id: "task:1", title: "b" },
      rev: undefined,
    });
    await reopened.putRecordsWithRevisions("task", [{ id: "task:1", record: null, rev: 5 }]);
    expect(await reopened.getRecordWithRevision("task", "task:1")).toEqual({ record: null, rev: 5 });
  });

  it("keeps the revision with the same memory store across a client restart, and none without the capability", async () => {
    const server = await startServer();
    await serverPush(server, "seed", [{ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } }]);
    const storage = new MemoryStorageAdapter(["task"]);
    await engineFor(server, storage).cloneNow();
    const restarted = createDatafnClient({ schema, clientId: "client:restart", storage, sync: { remote: "http://datafn.test/datafn", http: { fetch: (i: any, init?: any) => server.router.handle(new Request(i, init)) } } });
    expect(await restarted.getRevision("task", "task:1")).toBe(1);

    const plain = new MemoryStorageAdapter(["task"]);
    const withoutCapability = Object.assign(Object.create(plain), { capabilities: {} });
    await engineFor(server, withoutCapability as any).cloneNow();
    const noCapClient = createDatafnClient({ schema, clientId: "client:nocap", storage: withoutCapability as any, sync: { remote: "http://datafn.test/datafn", http: { fetch: (i: any, init?: any) => server.router.handle(new Request(i, init)) } } });
    expect(await noCapClient.getWithRevision("task", "task:1")).toEqual({
      record: expect.objectContaining({ id: "task:1", title: "a" }),
      rev: undefined,
    });
  });
});

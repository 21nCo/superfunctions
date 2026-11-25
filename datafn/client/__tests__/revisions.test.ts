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
import { applyPullResult, schemaRevisionResources } from "../src/sync/apply.js";
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
    // On the wire the revision is row metadata beside the ciphertext, never inside it.
    const pulled: any = await (await server.router.handle(new Request("http://datafn.test/datafn/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "client:wire", cursors: { task: "0" } }),
    }))).json();
    const wireRow = pulled.result.records.task[0];
    expect(wireRow.$rev).toBe(1);
    expect(wireRow.title).toMatchObject({ __datafnE2ee: 1 });
    expect(JSON.stringify(wireRow.title)).not.toContain("rev");

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

/** A transport that runs `during` after the server answered a route and before the client sees the answer. */
function delayedTransport(server: Server, route: string, during: () => Promise<void>, edit?: (body: any) => void) {
  return new DefaultHttpTransport("http://datafn.test/datafn", {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const response = await server.router.handle(request);
      if (new URL(request.url).pathname !== `/datafn/${route}`) return response;
      await during();
      const body = await response.json();
      edit?.(body);
      return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
    },
  });
}

describe("DATA-41 client revisions: never installed over newer local state", () => {
  it("keeps a background pull's newer state when the push acknowledgement arrives after it", async () => {
    const server = await startServer();
    await serverPush(server, "seed", [{ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } }]);
    const storage = new MemoryStorageAdapter(["task"]);
    await engineFor(server, storage).cloneNow();
    const bus = new EventBus();
    const pusher = new SyncEngine(storage, delayedTransport(server, "push", async () => {
      // Another device writes rev 3 and a background pull applies it first.
      await serverPush(server, "other", [{ resource: "task", operation: "merge", id: "task:1", record: { notes: "newer" } }]);
      await engineFor(server, storage).pullNow();
    }) as any, bus, "client:a", schema, { offlinability: true } as any);

    await storage.mergeRecord("task", "task:1", { title: "b" });
    await appendLocal(storage, { resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });
    await pusher.processPush();

    const pair = await storage.getRecordWithRevision("task", "task:1");
    expect(pair.record).toMatchObject({ title: "b", notes: "newer" });
    expect(pair.rev).toBeUndefined();
  });

  it("installs the latest post-write row when one push writes a record twice", async () => {
    const server = await startServer();
    await serverPush(server, "seed", [{ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } }]);
    const storage = new MemoryStorageAdapter(["task"]);
    const engine = engineFor(server, storage);
    await engine.cloneNow();
    await storage.mergeRecord("task", "task:1", { title: "b", notes: "c" });
    await appendLocal(storage, { resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });
    await appendLocal(storage, { resource: "task", operation: "merge", id: "task:1", record: { notes: "c" } });
    await engine.processPush();
    const pair = await storage.getRecordWithRevision("task", "task:1");
    expect(pair).toEqual({ record: expect.objectContaining({ title: "b", notes: "c" }), rev: 3 });
  });

  it("pairs a push row only with the $rev the row itself carries", async () => {
    const server = await startServer();
    await serverPush(server, "seed", [{ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } }]);
    const storage = new MemoryStorageAdapter(["task"]);
    await engineFor(server, storage).cloneNow();
    // A host filter trimmed the row and removed its $rev.
    const pusher = new SyncEngine(storage, delayedTransport(server, "push", async () => {}, (body) => {
      for (const revision of Object.values<any>(body.result.revisions ?? {})) delete revision.record.$rev;
    }) as any, new EventBus(), "client:a", schema, { offlinability: true } as any);
    await storage.mergeRecord("task", "task:1", { title: "b" });
    await appendLocal(storage, { resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });
    await pusher.processPush();
    expect((await storage.getRecordWithRevision("task", "task:1")).rev).toBeUndefined();
  });

  it("re-indexes and refreshes live queries for rows a push installs", async () => {
    const server = await startServer();
    await serverPush(server, "seed", [{ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } }]);
    const storage = new MemoryStorageAdapter(["task"]);
    await engineFor(server, storage).cloneNow();
    const bus = new EventBus();
    const events: any[] = [];
    bus.subscribe((event: any) => events.push(event));
    const indexed: any[] = [];
    const search = { updateIndices: async (params: any) => indexed.push(params) } as any;
    const engine = new SyncEngine(storage, transport(server) as any, bus, "client:a", schema, { offlinability: true } as any, [], undefined, search);
    await serverPush(server, "other", [{ resource: "task", operation: "merge", id: "task:1", record: { notes: "server" } }]);
    await storage.mergeRecord("task", "task:1", { title: "b" });
    await appendLocal(storage, { resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });
    await engine.processPush();

    expect((await storage.getRecordWithRevision("task", "task:1")).rev).toBe(3);
    expect(events).toContainEqual(expect.objectContaining({
      type: "sync_applied",
      context: expect.objectContaining({ phase: "revisions", resources: ["task"] }),
    }));
    expect(indexed).toContainEqual(expect.objectContaining({
      resource: "task",
      operation: "upsert",
      records: [expect.objectContaining({ id: "task:1", notes: "server" })],
    }));
  });

  it("keeps a write made while a versioned query was in flight", async () => {
    const server = await startServer();
    await serverPush(server, "seed", [{ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } }]);
    const storage = new MemoryStorageAdapter(["task"]);
    await engineFor(server, storage).cloneNow();
    const client = createDatafnClient({
      schema,
      clientId: "client:query-race",
      storage,
      sync: { offlinability: true, remote: "http://datafn.test/datafn", http: { fetch: async (i: any, init?: any) => {
        const request = new Request(i, init);
        const response = await server.router.handle(request);
        // A pull applies a newer state while the query response is in flight.
        if (new URL(request.url).pathname === "/datafn/query") await storage.mergeRecord("task", "task:1", { title: "pulled" });
        return response;
      } } },
    });
    const result: any = await client.query({ resource: "task", version: 1, withRevisions: true, filters: { id: "task:1" } });
    expect(result.data[0]).toMatchObject({ title: "a", $rev: 1 });
    expect(await client.getWithRevision("task", "task:1")).toEqual({
      record: expect.objectContaining({ title: "pulled" }),
      rev: undefined,
    });
  });

  it("treats a debounced write as pending before it reaches the changelog", async () => {
    const server = await startServer();
    await serverPush(server, "seed", [{ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } }]);
    const storage = new MemoryStorageAdapter(["task"]);
    const client = createDatafnClient({
      schema,
      clientId: "client:debounce",
      storage,
      sync: { offlinability: true, remote: "http://datafn.test/datafn", http: { fetch: (i: any, init?: any) => server.router.handle(new Request(i, init)) } },
    });
    await client.sync.cloneNow();
    expect(await client.getRevision("task", "task:1")).toBe(1);
    const debounced = client.mutate({
      resource: "task", version: 1, operation: "merge", id: "task:1", record: { title: "typing" },
      debounceKey: "task:1:title", debounceMs: 60_000,
    } as any);
    await vi.waitFor(async () => expect((await storage.getRecord("task", "task:1"))?.title).toBe("typing"));
    expect(await storage.changelogList()).toEqual([]);
    // Unknown while the write waits for its timer, and not overwritten by a versioned read.
    expect(await client.getRevision("task", "task:1")).toBeUndefined();
    await client.query({ resource: "task", version: 1, withRevisions: true, filters: { id: "task:1" } });
    expect(await client.getWithRevision("task", "task:1")).toEqual({
      record: expect.objectContaining({ title: "typing" }),
      rev: undefined,
    });
    await client.flush();
    await debounced;
    // Logged now, still pending until pushed.
    expect(await client.getRevision("task", "task:1")).toBeUndefined();
  });

  it("keeps two IndexedDB adapters on one database working after a revision install", async () => {
    const dbName = `revisions_peers_${Math.random()}`;
    const first = new IndexedDbStorageAdapter(dbName, ["task"], schema as any);
    const second = new IndexedDbStorageAdapter(dbName, ["task"], schema as any);
    await first.getRecord("task", "task:0");
    await second.getRecord("task", "task:0");
    expect(await first.putRecordsWithRevisions("task", [{ id: "task:1", record: { id: "task:1", title: "a" }, rev: 2 }])).toEqual(["task:1"]);
    await second.upsertRecord("task", { id: "task:2", title: "b" });
    expect(await second.getRecordWithRevision("task", "task:1")).toEqual({ record: { id: "task:1", title: "a" }, rev: 2 });
    // A write from the peer after an older request started blocks that request's install.
    const stamp = await first.revisionWriteStamp();
    await second.upsertRecord("task", { id: "task:1", title: "peer" });
    expect(await first.putRecordsWithRevisions("task", [{ id: "task:1", record: { id: "task:1", title: "old" }, rev: 3 }], { writtenSince: stamp })).toEqual([]);
    expect(await first.getRecordWithRevision("task", "task:1")).toEqual({ record: { id: "task:1", title: "peer" }, rev: undefined });
    await first.close();
    await second.close();
  });

  it("keeps the announced capabilities when a later response carries none", async () => {
    const server = await startServer();
    await serverPush(server, "seed", [{ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } }]);
    const client = createDatafnClient({
      schema,
      clientId: "client:caps",
      sync: { remote: "http://datafn.test/datafn", http: { fetch: async (i: any, init?: any) => {
        const request = new Request(i, init);
        const response = await server.router.handle(request);
        if (new URL(request.url).pathname !== "/datafn/mutation") return response;
        const { capabilities: _dropped, ...body } = (await response.json()) as any;
        return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
      } } },
    });
    await client.query({ resource: "task", version: 1, withRevisions: true, filters: { id: "task:1" } });
    expect(client.serverCapabilities()).toEqual({ revisions: true });
    await client.mutate({ resource: "task", version: 1, operation: "merge", id: "task:1", record: { title: "b" } });
    expect(client.serverCapabilities()).toEqual({ revisions: true });
  });

  it("reads a coherent pair, or an unknown revision, while a background pull updates the record", async () => {
    const server = await startServer();
    await serverPush(server, "seed", [{ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } }]);
    const storage = new MemoryStorageAdapter(["task"]);
    const engine = engineFor(server, storage);
    await engine.cloneNow();
    await serverPush(server, "other", [{ resource: "task", operation: "merge", id: "task:1", record: { title: "b" } }]);
    await serverPush(server, "another", [{ resource: "task", operation: "delete", id: "task:1" }]);
    const seen: Array<{ record: Record<string, unknown> | null; rev: number | undefined }> = [];
    const pulling = engine.pullNow();
    for (let i = 0; i < 20; i++) {
      seen.push(await storage.getRecordWithRevision("task", "task:1"));
      await Promise.resolve();
    }
    await pulling;
    seen.push(await storage.getRecordWithRevision("task", "task:1"));
    const states = new Map<number, unknown>([[1, { id: "task:1", title: "a" }], [3, null]]);
    for (const pair of seen) {
      if (pair.rev !== undefined) expect(pair.record).toEqual(states.get(pair.rev));
    }
    expect(seen[seen.length - 1]).toEqual({ record: null, rev: 3 });
  });
});


describe("DATA-41 client revisions: round 2", () => {
  const relationSchema: DatafnSchema = {
    resources: [
      { name: "task", version: 1, fields: [{ name: "title", type: "string", required: false }] },
      {
        name: "comment",
        version: 1,
        fields: [
          { name: "body", type: "string", required: false },
          { name: "taskId", type: "string", required: false },
        ],
      },
    ],
    relations: [
      { from: "comment", to: "task", type: "many-one", relation: "task", fkField: "taskId", onDelete: { to: "cascade" } },
    ],
  } as any;

  it("does not resurrect a child its own batch merged and then cascade-deleted", async () => {
    const server = await createDatafnServer({
      schema: relationSchema, database: memoryAdapter(), allowUnknownResources: true, revisions: { enabled: true },
    });
    servers.push(server);
    await serverPush(server, "seed", [
      { resource: "task", operation: "insert", id: "task:1", record: { title: "t" } },
      { resource: "comment", operation: "insert", id: "comment:1", record: { body: "x", taskId: "task:1" } },
    ]);
    const storage = new MemoryStorageAdapter(["task", "comment"]);
    const engine = new SyncEngine(storage, transport(server) as any, new EventBus(), "client:a", relationSchema, { offlinability: true } as any);
    await engine.cloneNow();
    // Local: merge the comment, then delete its task (cascading locally).
    await storage.mergeRecord("comment", "comment:1", { body: "y" });
    await appendLocal(storage, { resource: "comment", operation: "merge", id: "comment:1", record: { body: "y" } });
    await storage.deleteRecord("comment", "comment:1");
    await storage.deleteRecord("task", "task:1");
    await appendLocal(storage, { resource: "task", operation: "delete", id: "task:1" });
    await engine.processPush();

    expect(await storage.getRecord("comment", "comment:1")).toBeNull();
    expect((await storage.getRecordWithRevision("comment", "comment:1")).rev).not.toBe(2);
    expect(await storage.getRecordWithRevision("task", "task:1")).toEqual({ record: null, rev: 2 });
  });

  it("keeps a debounced write while its search indexing is still running", async () => {
    const server = await startServer();
    await serverPush(server, "seed", [{ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } }]);
    const storage = new MemoryStorageAdapter(["task"]);
    let releaseIndexing!: () => void;
    let indexing: Promise<void> | undefined;
    const searchProvider = {
      name: "held",
      search: async () => [],
      updateIndices: async () => {
        if (!indexing) return;
        await indexing;
      },
    };
    const client = createDatafnClient({
      schema,
      clientId: "client:indexing",
      storage,
      searchProvider,
      sync: { offlinability: true, remote: "http://datafn.test/datafn", http: { fetch: (i: any, init?: any) => server.router.handle(new Request(i, init)) } },
    } as any);
    await client.sync.cloneNow();
    indexing = new Promise<void>((resolve) => { releaseIndexing = resolve; });
    const debounced = client.mutate({
      resource: "task", version: 1, operation: "merge", id: "task:1", record: { title: "typing" },
      debounceKey: "task:1:title", debounceMs: 60_000,
    } as any);
    await vi.waitFor(async () => expect((await storage.getRecord("task", "task:1"))?.title).toBe("typing"));
    // Indexing is held: the mutation is neither logged nor scheduled yet.
    await client.query({ resource: "task", version: 1, withRevisions: true, filters: { id: "task:1" } });
    expect(await client.getWithRevision("task", "task:1")).toEqual({
      record: expect.objectContaining({ title: "typing" }),
      rev: undefined,
    });
    releaseIndexing();
    await client.flush();
    await debounced;
  });

  it("applies a record's pulled rows in change order and never installs an older revision", async () => {
    const storage = new MemoryStorageAdapter(["task"]);
    const options = { revisionResources: schemaRevisionResources(schema) };
    await applyPullResult(storage, {
      ok: true,
      records: { task: [{ id: "task:1", title: "first", $rev: 1 }, { id: "task:1", title: "replaced" }] },
      merged: { task: [{ id: "task:1", notes: "patched" }] },
      deleted: {},
      cursors: { task: "3" },
    } as any, options);
    expect(await storage.getRecordWithRevision("task", "task:1")).toEqual({
      record: { id: "task:1", title: "replaced", notes: "patched" },
      rev: undefined,
    });

    await storage.putRecordsWithRevisions("task", [{ id: "task:2", record: { id: "task:2", title: "new" }, rev: 3 }]);
    expect(await storage.putRecordsWithRevisions("task", [{ id: "task:2", record: null, rev: 2 }])).toEqual([]);
    expect(await storage.getRecordWithRevision("task", "task:2")).toEqual({ record: { id: "task:2", title: "new" }, rev: 3 });
  });

  it("installs only a global-cursor change whose row carries $rev", async () => {
    const storage = new MemoryStorageAdapter(["task"]);
    await applyPullResult(storage, {
      ok: true,
      changes: [
        { serverSeq: 1, resource: "task", id: "task:1", op: "upsert", rev: 1, record: { id: "task:1", title: "a", $rev: 1 } },
        { serverSeq: 2, resource: "task", id: "task:2", op: "upsert", rev: 1, record: { id: "task:2", title: "b", $rev: 1 } },
        { serverSeq: 3, resource: "task", id: "task:2", op: "upsert", rev: 2, record: { id: "task:2", title: "c" } },
      ],
      nextCursor: "3",
    } as any, { revisionResources: schemaRevisionResources(schema) });
    expect(await storage.getRecordWithRevision("task", "task:1")).toEqual({ record: { id: "task:1", title: "a" }, rev: 1 });
    expect(await storage.getRecordWithRevision("task", "task:2")).toEqual({ record: { id: "task:2", title: "c" }, rev: undefined });
  });

  it("emits no revisions event for a versioned read that installs nothing new", async () => {
    const server = await startServer();
    await serverPush(server, "seed", [{ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } }]);
    const storage = new MemoryStorageAdapter(["task"]);
    const client = createDatafnClient({
      schema,
      clientId: "client:settle",
      storage,
      sync: { offlinability: true, remote: "http://datafn.test/datafn", http: { fetch: (i: any, init?: any) => server.router.handle(new Request(i, init)) } },
    });
    await client.sync.cloneNow();
    await serverPush(server, "other", [{ resource: "task", operation: "merge", id: "task:1", record: { title: "b" } }]);
    await client.sync.pullNow();
    const events: unknown[] = [];
    client.subscribe((event: any) => {
      if (event.type === "sync_applied" && event.context?.phase === "revisions") events.push(event);
    });
    const versioned = { resource: "task", version: 1, withRevisions: true, filters: { id: "task:1" } };
    await client.query(versioned);
    expect(events).toHaveLength(1);
    expect(await client.getRevision("task", "task:1")).toBe(2);
    await client.query(versioned);
    expect(events).toHaveLength(1);
  });

  it("installs the first IndexedDB revisions after an upgrade from a database without them", async () => {
    {
      const dbName = `revisions_upgrade_${Math.random()}`;
      const adapter = new IndexedDbStorageAdapter(dbName, ["task"], schema as any);
      // Hydrated before revisions existed: no revisions store yet.
      await adapter.upsertRecord("task", { id: "task:1", title: "old" });
      const stamp = await adapter.revisionWriteStamp();
      expect(stamp).toBeGreaterThanOrEqual(0);
      expect(await adapter.putRecordsWithRevisions("task", [{ id: "task:1", record: { id: "task:1", title: "server" }, rev: 2 }], {
        unlessPending: true,
        writtenSince: stamp,
      })).toEqual(["task:1"]);
      expect(await adapter.getRecordWithRevision("task", "task:1")).toEqual({ record: { id: "task:1", title: "server" }, rev: 2 });
      // A write after the stamp is still protected.
      const later = await adapter.revisionWriteStamp();
      await adapter.upsertRecord("task", { id: "task:1", title: "local" });
      expect(await adapter.putRecordsWithRevisions("task", [{ id: "task:1", record: { id: "task:1", title: "server-3" }, rev: 3 }], {
        writtenSince: later,
      })).toEqual([]);
      await adapter.close();
    }
  });

  it("rejects an IndexedDB record write whose revision bookkeeping aborts the transaction", async () => {
    const dbName = `revisions_abort_${Math.random()}`;
    const adapter = new IndexedDbStorageAdapter(dbName, ["task"], schema as any);
    await adapter.revisionWriteStamp();
    const put = IDBObjectStore.prototype.put;
    const aborted = new WeakSet<IDBTransaction>();
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: any[]) {
      // The revision write fails (as on a quota error): the transaction aborts.
      if (this.name === "__datafn_revisions") {
        if (!aborted.has(this.transaction)) {
          aborted.add(this.transaction);
          this.transaction.abort();
        }
        return {} as IDBRequest;
      }
      return (put as any).apply(this, args);
    });
    try {
      await expect(adapter.upsertRecord("task", { id: "task:1", title: "lost" })).rejects.toBeDefined();
    } finally {
      spy.mockRestore();
    }
    expect(await adapter.getRecord("task", "task:1")).toBeNull();
    await adapter.close();
  });
});

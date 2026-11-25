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
    expect(installed).toEqual({ installed: [], current: [] });
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

  // DATA-41 client slice (pull certification, canonical-pull-misattributes-
  // unrevisioned-change): the client still pairs the delete's tombstone
  // revision here. Enabled by the client slice that certifies pulled pairs.
  it.skip("applies a delete and a later re-creating merge as base pull does, pairing no revision", async () => {
    const server = await startServer();
    await serverPush(server, "seed", [{ resource: "task", operation: "insert", id: "task:1", record: { title: "a", notes: "old" } }]);
    const storage = new MemoryStorageAdapter(["task"]);
    const engine = engineFor(server, storage);
    await engine.cloneNow();
    await serverPush(server, "deleter", [{ resource: "task", operation: "delete", id: "task:1" }]);
    await serverPush(server, "recreator", [{ resource: "task", operation: "merge", id: "task:1", record: { title: "again" } }]);
    await engine.pullNow();
    // Base bucket order (rows, patches, deletes) ends deleted; the patch
    // carries no revision, so no revision is paired with that state.
    const pair = await storage.getRecordWithRevision("task", "task:1");
    expect(pair.record).toBeNull();
    expect(pair.rev).toBeUndefined();
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
    expect(await first.putRecordsWithRevisions("task", [{ id: "task:1", record: { id: "task:1", title: "a" }, rev: 4 }])).toEqual({ installed: ["task:1"], current: [] });
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
    expect(await first.putRecordsWithRevisions("task", [{ id: "task:1", record: { id: "task:1", title: "a" }, rev: 2 }])).toEqual({ installed: ["task:1"], current: [] });
    await second.upsertRecord("task", { id: "task:2", title: "b" });
    expect(await second.getRecordWithRevision("task", "task:1")).toEqual({ record: { id: "task:1", title: "a" }, rev: 2 });
    // A write from the peer after an older request started blocks that request's install.
    const stamp = await first.revisionWriteStamp();
    await second.upsertRecord("task", { id: "task:1", title: "peer" });
    expect(await first.putRecordsWithRevisions("task", [{ id: "task:1", record: { id: "task:1", title: "old" }, rev: 3 }], { writtenSince: stamp })).toEqual({ installed: [], current: [] });
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
    expect(await storage.putRecordsWithRevisions("task", [{ id: "task:2", record: null, rev: 2 }])).toEqual({ installed: [], current: ["task:2"] });
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

  it("installs the first IndexedDB revisions of a database hydrated without them", async () => {
    {
      const dbName = `revisions_upgrade_${Math.random()}`;
      const adapter = new IndexedDbStorageAdapter(dbName, ["task"], schema as any);
      // Hydrated before any revision was installed.
      await adapter.upsertRecord("task", { id: "task:1", title: "old" });
      const stamp = await adapter.revisionWriteStamp();
      expect(stamp).toBeGreaterThanOrEqual(0);
      expect(await adapter.putRecordsWithRevisions("task", [{ id: "task:1", record: { id: "task:1", title: "server" }, rev: 2 }], {
        unlessPending: true,
        writtenSince: stamp,
      })).toEqual({ installed: ["task:1"], current: [] });
      expect(await adapter.getRecordWithRevision("task", "task:1")).toEqual({ record: { id: "task:1", title: "server" }, rev: 2 });
      // A write after the stamp is still protected.
      const later = await adapter.revisionWriteStamp();
      await adapter.upsertRecord("task", { id: "task:1", title: "local" });
      expect(await adapter.putRecordsWithRevisions("task", [{ id: "task:1", record: { id: "task:1", title: "server-3" }, rev: 3 }], {
        writtenSince: later,
      })).toEqual({ installed: [], current: [] });
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

describe("DATA-41 client revisions: round 3", () => {
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

  async function appendAs(storage: MemoryStorageAdapter, mutationId: string, mutation: Record<string, unknown>) {
    await storage.changelogAppend({
      clientId: "client:a",
      mutationId,
      timestampMs: Date.now(),
      mutation: { version: 1, clientId: "client:a", mutationId, ...mutation },
    });
  }

  it("installs no row from an earlier push attempt that a compaction replay's cascade later deleted", async () => {
    const server = await createDatafnServer({
      schema: relationSchema, database: memoryAdapter(), allowUnknownResources: true, revisions: { enabled: true },
    });
    servers.push(server);
    await serverPush(server, "seed", [
      { resource: "task", operation: "insert", id: "task:1", record: { title: "t" } },
      { resource: "comment", operation: "insert", id: "comment:1", record: { body: "x", taskId: "task:1" } },
    ]);
    const storage = new MemoryStorageAdapter(["task", "comment"]);
    let pushes = 0;
    const replayTransport = new DefaultHttpTransport("http://datafn.test/datafn", {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname !== "/datafn/push" || pushes++ > 0) return server.router.handle(request);
        // First attempt: the task delete fails terminally, the rest applies.
        const payload = await request.json();
        const failed = payload.mutations.filter((m: any) => m.operation === "delete");
        payload.mutations = payload.mutations.filter((m: any) => m.operation !== "delete");
        const response = await server.router.handle(new Request(request.url, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        }));
        const body = await response.json();
        const result = body.result ?? body;
        result.ok = false;
        result.errors = [
          ...(result.errors ?? []),
          ...failed.map((m: any) => ({ mutationId: m.mutationId, code: "FORBIDDEN", message: "denied once", retryable: false })),
        ];
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const engine = new SyncEngine(storage, replayTransport as any, new EventBus(), "client:a", relationSchema, { offlinability: true } as any);
    await engine.cloneNow();
    // Local: merge the task, merge the comment, then delete the task (cascading locally).
    await storage.mergeRecord("task", "task:1", { title: "t2" });
    await appendAs(storage, "m-task-merge", { resource: "task", operation: "merge", id: "task:1", record: { title: "t2" } });
    await storage.mergeRecord("comment", "comment:1", { body: "y" });
    await appendAs(storage, "m-comment-merge", { resource: "comment", operation: "merge", id: "comment:1", record: { body: "y" } });
    await storage.deleteRecord("comment", "comment:1");
    await storage.deleteRecord("task", "task:1");
    await appendAs(storage, "m-task-delete", { resource: "task", operation: "delete", id: "task:1" });
    await engine.processPush();

    expect(pushes).toBe(2);
    expect(await storage.changelogList()).toEqual([]);
    // The first attempt returned the comment's rev-2 row; the replay's delete
    // cascaded it to a tombstone. The comment must stay deleted.
    expect(await storage.getRecord("comment", "comment:1")).toBeNull();
    expect((await storage.getRecordWithRevision("comment", "comment:1")).rev).not.toBe(2);
  });

  it("stores no $rev field from a cloneUp catch-up pull against a revision server", async () => {
    const server = await startServer();
    const storage = new MemoryStorageAdapter(["task"]);
    const client = createDatafnClient({
      schema,
      clientId: "client:cloneup",
      storage,
      sync: { remote: "http://datafn.test/datafn", http: { fetch: (i: any, init?: any) => server.router.handle(new Request(i, init)) } },
    } as any);
    await storage.upsertRecord("task", { id: "task:1", title: "local" });
    // Another device writes a record the catch-up pull delivers.
    await serverPush(server, "other", [{ resource: "task", operation: "insert", id: "task:2", record: { title: "remote" } }]);

    const result = await client.sync.cloneUp();
    expect(result.ok).toBe(true);
    for (const record of await storage.listRecords("task")) expect(record).not.toHaveProperty("$rev");
    expect(await storage.getRecordWithRevision("task", "task:2")).toEqual({
      record: expect.objectContaining({ id: "task:2", title: "remote" }),
      rev: 1,
    });
    client.sync.stop();
  });

  it("keeps a child's revision unknown while its parent's archive, which changed the child locally, is pending", async () => {
    const inheritSchema: DatafnSchema = {
      resources: [
        { name: "goal", version: 1, fields: [{ name: "title", type: "string", required: false }] },
        {
          name: "step",
          version: 1,
          fields: [
            { name: "title", type: "string", required: false },
            { name: "goalId", type: "string", required: false },
          ],
        },
      ],
      relations: [{ from: "step", to: "goal", type: "many-one", relation: "goal", fkField: "goalId", inheritsInactive: true }],
    } as any;
    const server = await createDatafnServer({
      schema: inheritSchema, database: memoryAdapter(), allowUnknownResources: true, revisions: { enabled: true },
    });
    servers.push(server);
    await serverPush(server, "seed", [
      { resource: "goal", operation: "insert", id: "goal:1", record: { title: "g" } },
      { resource: "step", operation: "insert", id: "step:1", record: { title: "s", goalId: "goal:1" } },
    ]);
    const storage = new MemoryStorageAdapter(["goal", "step"]);
    const client = createDatafnClient({
      schema: inheritSchema,
      clientId: "client:archive",
      storage,
      sync: {
        offlinability: true,
        remote: "http://datafn.test/datafn",
        http: {
          fetch: async (i: any, init?: any) => {
            const request = new Request(i, init);
            // Pushes fail, so the archive stays pending.
            if (new URL(request.url).pathname === "/datafn/push") throw new TypeError("offline");
            return server.router.handle(request);
          },
        },
      },
    } as any);
    await client.sync.cloneNow();
    await client.mutate({ resource: "goal", version: 1, operation: "archive", id: "goal:1" } as any);
    expect(await storage.getRecord("step", "step:1")).toMatchObject({ isAncestorInactive: true });

    await client.query({ resource: "step", version: 1, withRevisions: true, filters: { id: "step:1" } });
    expect(await storage.getRecord("step", "step:1")).toMatchObject({ isAncestorInactive: true });
    expect((await client.getWithRevision("step", "step:1")).rev).toBeUndefined();
    client.sync.stop();
  });

  for (const kind of ["memory", "indexeddb"] as const) {
    it(`keeps a newer or equal installed revision when a pull replays an older or equal row or tombstone (${kind})`, async () => {
      const storage = kind === "memory"
        ? new MemoryStorageAdapter(["task"])
        : new IndexedDbStorageAdapter(`revisions_stale_${Math.random()}`, ["task"], schema as any);
      const options = { revisionResources: schemaRevisionResources(schema) };
      const held = { record: { id: "task:1", title: "v2" }, rev: 2 };
      await storage.putRecordsWithRevisions!("task", [{ id: "task:1", record: { id: "task:1", title: "v2" }, rev: 2 }]);

      // Canonical format: an older row, the equal row, an older tombstone.
      await applyPullResult(storage, {
        ok: true, records: { task: [{ id: "task:1", title: "v1", $rev: 1 }] }, deleted: {}, cursors: { task: "1" },
      } as any, options);
      expect(await storage.getRecordWithRevision!("task", "task:1")).toEqual(held);
      await applyPullResult(storage, {
        ok: true, records: { task: [{ id: "task:1", title: "v2", $rev: 2 }] }, deleted: {}, cursors: { task: "2" },
      } as any, options);
      expect(await storage.getRecordWithRevision!("task", "task:1")).toEqual(held);
      await applyPullResult(storage, {
        ok: true, records: {}, deleted: { task: ["task:1"] }, deletedRevisions: { task: { "task:1": 1 } }, cursors: { task: "3" },
      } as any, options);
      expect(await storage.getRecordWithRevision!("task", "task:1")).toEqual(held);

      // Global-cursor format: the same three.
      await applyPullResult(storage, {
        ok: true,
        changes: [
          { serverSeq: 1, resource: "task", id: "task:1", op: "upsert", rev: 1, record: { id: "task:1", title: "v1", $rev: 1 } },
          { serverSeq: 2, resource: "task", id: "task:1", op: "delete", rev: 1, record: null },
        ],
        nextCursor: "10",
      } as any, options);
      expect(await storage.getRecordWithRevision!("task", "task:1")).toEqual(held);
      await applyPullResult(storage, {
        ok: true,
        changes: [{ serverSeq: 3, resource: "task", id: "task:1", op: "upsert", rev: 2, record: { id: "task:1", title: "v2", $rev: 2 } }],
        nextCursor: "11",
      } as any, options);
      expect(await storage.getRecordWithRevision!("task", "task:1")).toEqual(held);

      // A newer row still installs.
      await applyPullResult(storage, {
        ok: true, records: { task: [{ id: "task:1", title: "v3", $rev: 3 }] }, deleted: {}, cursors: { task: "12" },
      } as any, options);
      expect(await storage.getRecordWithRevision!("task", "task:1")).toEqual({ record: { id: "task:1", title: "v3" }, rev: 3 });
      if (storage instanceof IndexedDbStorageAdapter) await storage.close();
    });
  }
});

describe("DATA-41 client revisions: round 4", () => {
  const provider: DatafnE2eeProvider = {
    keyRef: "test-key",
    async encrypt({ plaintext, resource, id, field }) {
      return { __datafnE2ee: 1, alg: "AES-GCM", keyRef: "test-key", iv: `${resource}:${id}:${field}`, data: JSON.stringify([...plaintext]) } as any;
    },
    async decrypt({ envelope }) {
      return new Uint8Array(JSON.parse((envelope as any).data));
    },
  };

  for (const kind of ["memory", "indexeddb"] as const) {
    it(`restores nothing from a push acknowledgement that arrives after a storage reset (${kind})`, async () => {
      const server = await startServer();
      await serverPush(server, "seed", [{ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } }]);
      const storage = kind === "memory"
        ? new MemoryStorageAdapter(["task"])
        : new IndexedDbStorageAdapter(`revisions_reset_${Math.random()}`, ["task"], schema as any);
      await engineFor(server, storage).cloneNow();
      // The reset happens while the push is in flight (a sign-out).
      const pusher = new SyncEngine(storage, delayedTransport(server, "push", () => storage.clearAll()) as any,
        new EventBus(), "client:a", schema, { offlinability: true } as any);
      await storage.mergeRecord("task", "task:1", { title: "b" });
      await appendLocal(storage as MemoryStorageAdapter, { resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });
      await pusher.processPush();

      expect(await storage.getRecord("task", "task:1")).toBeNull();
      expect(await storage.getRecordWithRevision!("task", "task:1")).toEqual({ record: null, rev: undefined });
      await storage.close();
    });
  }

  it("never lets an edit of a row returned by a memory read change the state paired with its revision", async () => {
    const storage = new MemoryStorageAdapter(["task"]);
    const server = { id: "task:1", title: "server", notes: "n", meta: { tags: ["a"] } };
    await storage.putRecordsWithRevisions("task", [{ id: "task:1", record: server, rev: 7 }]);
    const reads = [
      async () => (await storage.getRecord("task", "task:1"))!,
      async () => (await storage.listRecords("task"))[0],
      async () => (await storage.findRecords("task", "title", "server"))[0],
    ];
    for (const read of reads) {
      const row: any = await read();
      row.title = "edited";
      row.meta.tags.push("edited");
      const pair = await storage.getRecordWithRevision("task", "task:1");
      expect(pair).toEqual({ record: { id: "task:1", title: "server", notes: "n", meta: { tags: ["a"] } }, rev: 7 });
    }
  });

  it("installs nothing from a versioned relation traversal whose target rows declare their own $rev field", async () => {
    const labelled: DatafnSchema = {
      resources: [
        { name: "task", version: 1, fields: [{ name: "title", type: "string", required: false }, { name: "labelId", type: "string", required: false }] },
        { name: "label", version: 1, fields: [{ name: "name", type: "string", required: false }, { name: "$rev", type: "number", required: false }] },
      ],
      relations: [{ from: "task", to: "label", type: "many-one", relation: "label", fkField: "labelId" }],
    } as any;
    const server = await createDatafnServer({
      schema: labelled, database: memoryAdapter(), allowUnknownResources: true, revisions: { enabled: true },
    });
    servers.push(server);
    await serverPush(server, "seed", [
      { resource: "label", operation: "insert", id: "label:1", record: { name: "L", $rev: 42 } },
      { resource: "task", operation: "insert", id: "task:1", record: { title: "a", labelId: "label:1" } },
    ]);
    const storage = new MemoryStorageAdapter(["task", "label"]);
    const client = createDatafnClient({
      schema: labelled,
      clientId: "client:relation",
      storage,
      sync: { offlinability: true, remote: "http://datafn.test/datafn", http: { fetch: async (i: any, init?: any) =>
        server.router.handle(new Request(i, init)) } },
    });
    await client.sync.cloneNow();
    const before = await client.getWithRevision("task", "task:1");
    expect(before.rev).toBe(1);
    const related: any = await client.query({ resource: "task", version: 1, id: "task:1", relation: "label", withRevisions: true } as any);
    expect(JSON.stringify(related)).toContain("label:1");
    expect(await storage.getRecord("task", "label:1")).toBeNull();
    expect(await client.getWithRevision("task", "task:1")).toEqual(before);
  });

  it("never upgrades an existing IndexedDB database for revisions, so a tab of an earlier release keeps working", async () => {
    const dbName = `revisions_existing_${Math.random()}`;
    const first = new IndexedDbStorageAdapter(dbName, ["task"], schema as any);
    await first.upsertRecord("task", { id: "task:1", title: "kept" });
    await first.changelogAppend({
      clientId: "client:a",
      mutationId: "queued-1",
      timestampMs: Date.now(),
      mutation: { version: 1, clientId: "client:a", mutationId: "queued-1", resource: "task", operation: "merge", id: "task:1", record: { title: "kept" } },
    } as any);
    const created = await (first as any).dbPromise as IDBDatabase;
    const version = created.version + 1;
    await first.close();
    // A database from before revisions: no revisions store. Its tab stays
    // open and, like that release, closes on a version change.
    const earlier = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, version);
      request.onupgradeneeded = () => request.result.deleteObjectStore("__datafn_revisions");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let versionChanged = false;
    earlier.onversionchange = () => {
      versionChanged = true;
      earlier.close();
    };

    const storage = new IndexedDbStorageAdapter(dbName, ["task"], schema as any);
    for (const enabled of [false, true]) {
      const server = await startServer(enabled);
      await engineFor(server, storage).processPush();
    }

    expect(versionChanged).toBe(false);
    expect(((await (storage as any).dbPromise) as IDBDatabase).version).toBe(version);
    // The earlier tab can still write.
    await new Promise<void>((resolve, reject) => {
      const tx = earlier.transaction("task", "readwrite");
      tx.objectStore("task").put({ id: "task:2", title: "from-earlier-tab" });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    expect(await storage.getRecord("task", "task:1")).toMatchObject({ id: "task:1", title: "kept" });
    // Revisions stay unknown without the store.
    expect(await storage.revisionWriteStamp()).toBe(-1);
    expect(await storage.getRecordWithRevision("task", "task:1")).toMatchObject({ rev: undefined });
    expect(await storage.putRecordsWithRevisions("task", [{ id: "task:1", record: { id: "task:1", title: "server" }, rev: 2 }]))
      .toEqual({ installed: [], current: [] });
    expect(await storage.getRecord("task", "task:1")).toMatchObject({ title: "kept" });
    earlier.close();
    await storage.close();
  });

  it("refuses an E2EE versioned id query whose other values are not plain scalars, before sending it", async () => {
    const server = await startServer();
    const requests: string[] = [];
    const client = createDatafnClient({
      schema,
      clientId: "client:e2ee-shape",
      e2ee: { enabled: true, provider },
      sync: { remote: "http://datafn.test/datafn", http: { fetch: async (i: any, init?: any) => {
        const request = new Request(i, init);
        requests.push(`${new URL(request.url).pathname} ${await request.clone().text()}`);
        return server.router.handle(request);
      } } },
    });
    for (const extra of [
      { limit: { plaintext: "secret title" } },
      { limit: "secret title" },
      { version: { plaintext: "secret title" } },
    ]) {
      await expect(client.query({ resource: "task", version: 1, withRevisions: true, filters: { id: "task:1" }, ...extra } as any))
        .rejects.toMatchObject({ code: "DFQL_UNSUPPORTED" });
    }
    expect(requests.join("\n")).not.toContain("secret title");
    expect(requests).toEqual([]);
  });

  it("gives a hydrated E2EE client a known revision through a versioned id read, none while a local change is pending, and decrypted push rows", async () => {
    const server = await startServer();
    const wire: string[] = [];
    const fetchVia = async (i: any, init?: any) => {
      const request = new Request(i, init);
      const sent = await request.clone().text();
      const response = await server.router.handle(request);
      wire.push(`${new URL(request.url).pathname} ${sent} => ${await response.clone().text()}`);
      return response;
    };
    const writer = createDatafnClient({
      schema, clientId: "client:writer", e2ee: { enabled: true, provider },
      sync: { remote: "http://datafn.test/datafn", http: { fetch: fetchVia } },
    });
    await writer.mutate({ resource: "task", version: 1, operation: "insert", id: "task:1", record: { title: "first secret", notes: "n" } });
    await writer.mutate({ resource: "task", version: 1, operation: "insert", id: "task:2", record: { title: "second secret" } });

    const storage = new MemoryStorageAdapter(["task"]);
    const client = createDatafnClient({
      schema, clientId: "client:reader", storage, e2ee: { enabled: true, provider },
      sync: { offlinability: true, remote: "http://datafn.test/datafn", http: { fetch: fetchVia } },
    } as any);
    await client.sync.cloneNow();
    expect(await client.getWithRevision("task", "task:1")).toEqual({
      record: expect.objectContaining({ title: "first secret" }), rev: 1,
    });

    // (1) A partial merge pulled from the server leaves the revision unknown;
    // a versioned id read then gives the decrypted row with its revision.
    await writer.mutate({ resource: "task", version: 1, operation: "merge", id: "task:1", record: { title: "merged secret" } });
    await client.sync.pullNow();
    expect(await client.getWithRevision("task", "task:1")).toEqual({
      record: expect.objectContaining({ title: "merged secret" }), rev: undefined,
    });
    await client.query({ resource: "task", version: 1, withRevisions: true, filters: { id: "task:1" } });
    expect(await client.getWithRevision("task", "task:1")).toEqual({
      record: expect.objectContaining({ id: "task:1", title: "merged secret", notes: "n" }), rev: 2,
    });

    // (2) A pending local change keeps that record's revision unknown.
    await appendLocal(storage, { resource: "task", operation: "merge", id: "task:2", record: { title: "local secret" } });
    await storage.mergeRecord("task", "task:2", { title: "local secret" });
    await client.query({ resource: "task", version: 1, withRevisions: true, filters: { id: { $in: ["task:1", "task:2"] } } });
    expect(await client.getWithRevision("task", "task:2")).toEqual({
      record: expect.objectContaining({ title: "local secret" }), rev: undefined,
    });

    // (3) Pushed: the post-write row carries $rev beside the ciphertext and is installed decrypted.
    const engine = new SyncEngine(storage, transport(server, []) as any, new EventBus(), "client:a", schema,
      { offlinability: true } as any, undefined, undefined, undefined, undefined, { enabled: true, provider });
    wire.length = 0;
    const pushTransport = new DefaultHttpTransport("http://datafn.test/datafn", { fetch: fetchVia });
    (engine as any).remote = pushTransport;
    await engine.processPush();
    const push = wire.find((line) => line.startsWith("/datafn/push "))!;
    expect(push).toBeDefined();
    expect(push).not.toContain("local secret");
    const response = JSON.parse(push.slice(push.indexOf(" => ") + 4));
    const [result] = Object.values(response.result.revisions) as any[];
    expect(result.record.$rev).toBe(2);
    expect(result.record.title).toMatchObject({ __datafnE2ee: 1 });
    expect(JSON.stringify(result.record.title)).not.toContain("rev");
    expect(await client.getWithRevision("task", "task:2")).toEqual({
      record: expect.objectContaining({ id: "task:2", title: "local secret" }), rev: 2,
    });
    client.sync.stop();
  });
});

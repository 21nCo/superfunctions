import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStorage, createWatch, type StorageAdapter, type Watch } from "../src/index.js";
import { createWatchRouter } from "../src/http.js";
import { createSqliteStorage } from "../src/sqlite.js";
import { instrument, sqliteFile, type SqliteFile } from "./helpers.js";

const BASE = "http://watch.test/watch";
let watch: Watch | undefined;
let db: SqliteFile | undefined;

afterEach(async () => {
  await watch?.stop();
  db?.cleanup();
  watch = undefined;
  db = undefined;
});

async function setup(storage: StorageAdapter, authorize: (request: Request) => boolean | Promise<boolean> = () => true) {
  watch = createWatch({ storage });
  await watch.start();
  return createWatchRouter(watch, { authorize, basePath: "/watch", maxBodyBytes: 4096 });
}

function post(path: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }): Request {
  return new Request(`${BASE}${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

describe("[durable-sqlite] HTTP routes", () => {
  it("POST /query returns the events POST /ingest persisted", async () => {
    db = sqliteFile();
    const router = await setup(createSqliteStorage({ adapter: db.connect().adapter }));
    const single = await router.handle(post("/ingest", { type: "sdk.failure", timestamp: "2026-10-01T00:00:00Z", attributes: { operation: "tasks.get" } }));
    expect(single.status).toBe(201);
    const batch = await router.handle(
      post("/ingest", [
        { type: "sdk.failure", timestamp: "2026-10-01T00:01:00Z", attributes: { operation: "tasks.list" } },
        { type: "sdk.failure", timestamp: "2026-10-01T00:02:00Z", attributes: { operation: "tasks.get" } },
      ]),
    );
    expect(batch.status).toBe(201);
    expect((await batch.json()).events).toHaveLength(2);

    const response = await router.handle(post("/query", { attributes: { operation: "tasks.get" }, order: "asc" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.truncated).toBe(false);
    expect(body.events.map((event: { timestamp: string }) => event.timestamp)).toEqual(["2026-10-01T00:00:00.000Z", "2026-10-01T00:02:00.000Z"]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("[memory-fixture] HTTP routes", () => {
  it("requires an authorize function and denies when it returns false or throws", async () => {
    const storage = createMemoryStorage();
    expect(() => createWatchRouter(createWatch({ storage }), {} as never)).toThrow(/authorize is required/);
    const denied = await setup(storage, () => false);
    expect((await denied.handle(post("/query", {}))).status).toBe(401);
    const throwing = createWatchRouter(watch!, {
      authorize: () => {
        throw new Error("auth backend down");
      },
    });
    expect((await throwing.handle(new Request("http://watch.test/health"))).status).toBe(401);
    expect(storage.size()).toBe(0);
  });

  it("answers malformed requests with 4xx and writes nothing", async () => {
    const { storage, calls } = instrument(createMemoryStorage());
    const router = await setup(storage);
    expect((await router.handle(post("/ingest", "{not json"))).status).toBe(400);
    expect((await router.handle(post("/ingest", { type: "x" }, { "content-type": "text/plain" }))).status).toBe(415);
    const invalid = await router.handle(post("/ingest", { type: "x", attributes: { a: {} } }));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.issues).toEqual(["event.attributes.a: must be a string, finite number or boolean"]);
    expect((await router.handle(post("/ingest", { type: "x", data: "y".repeat(5000) }))).status).toBe(413);
    expect((await router.handle(post("/query", { limit: "ten" }))).status).toBe(400);
    expect(calls.write).toBe(0);
  });

  it("answers storage failures with 503 without leaking storage details", async () => {
    const { storage, control } = instrument(createMemoryStorage());
    control.failWrites = new Error("SQLITE_FULL at /secret/path.db");
    const router = await setup(storage);
    const response = await router.handle(post("/ingest", { type: "x" }));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });

  it("reports health and refuses work while the runtime is stopped", async () => {
    const router = await setup(createMemoryStorage());
    expect(await (await router.handle(new Request(`${BASE}/health`))).json()).toEqual({ status: "ok", state: "started" });
    await watch!.stop();
    expect((await router.handle(new Request(`${BASE}/health`))).status).toBe(503);
    expect((await router.handle(post("/ingest", { type: "x" }))).status).toBe(503);
    const query = await router.handle(post("/query", {}));
    expect(query.status).toBe(503);
    expect((await query.json()).error.code).toBe("not_started");
  });
});

describe("[memory-fixture] HTTP hook failures", () => {
  it("answers an ingest_failed receipt with 500 without leaking hook details", async () => {
    watch = createWatch({ storage: createMemoryStorage(), generateId: () => { throw new Error("secret detail"); } });
    await watch.start();
    const router = createWatchRouter(watch, { authorize: () => true, basePath: "/watch" });
    const response = await router.handle(post("/ingest", { type: "t" }));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("secret detail");
    expect(JSON.parse(text)).toEqual({ error: { code: "ingest_failed", message: "ingestion failed" } });
  });
});

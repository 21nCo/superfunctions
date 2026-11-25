/**
 * DATA-19: records pulled from a SQL-backed (Postgres) DataFn server carry
 * every declared column, with `null` for the ones the record never set. The
 * server rejects `null` for a field that is not nullable, so cloneUp leaves
 * such a field out of the uploaded record, while a nullable field keeps its
 * `null`. Runs against an in-memory DataFn server (`@datafn/server` over the
 * memory adapter, reached through `sync.http.fetch`).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
// @datafn/server resolves to its source through the alias in vitest.config.ts.
import { createDatafnServer } from "@datafn/server";
import { memoryAdapter } from "@superfunctions/db/adapters";
import type { DatafnSchema } from "@datafn/core";
import { createDatafnClient } from "../src/client.js";
import { MemoryStorageAdapter } from "../src/adapters/memoryStorage.js";

const schema: DatafnSchema = {
  resources: [
    {
      name: "profiles",
      version: 1,
      fields: [
        { name: "name", type: "string", required: true },
        // Like Nucleum's `avatar`: optional, but not nullable.
        { name: "avatar", type: "array", required: false },
        { name: "nickname", type: "string", required: false },
        { name: "theme", type: "string", required: false, default: "light" },
        { name: "bio", type: "string", required: false, nullable: true },
      ],
    },
  ],
};

/** A profile as a pull from a Postgres-backed server stores it. */
function pulledProfile(id: string, name: string | null, set: Record<string, unknown> = {}) {
  return { id, name, avatar: null, nickname: null, theme: null, bio: null, ...set };
}

type Server = Awaited<ReturnType<typeof createDatafnServer>>;
type Device = {
  client: ReturnType<typeof createDatafnClient>;
  storage: MemoryStorageAdapter;
  /** JSON bodies of every /datafn/push request the device sent. */
  pushes: Array<{ mutations: Array<Record<string, unknown>> }>;
};

let server: Server;
let devices: Device[] = [];

beforeEach(async () => {
  server = await createDatafnServer({
    schema,
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

function connectDevice(name: string, offlinability = false): Device {
  const storage = new MemoryStorageAdapter();
  const pushes: Device["pushes"] = [];
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
  const device = { client, storage, pushes };
  devices.push(device);
  return device;
}

/** Records the server holds for `resource`, read by a fresh device's clone. */
async function serverRecords(resource: string) {
  const reader = connectDevice(`reader-${devices.length}`, true);
  await reader.client.sync.cloneNow();
  const records = await reader.storage.listRecords(resource);
  return records.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function sentRecords(device: Device) {
  return device.pushes.flatMap((push) => push.mutations).map((mutation) => mutation.record);
}

const cloneUpOptions = {
  recordOperation: "replace",
  clearChangelogOnSuccess: true,
  setGlobalCursorOnSuccess: true,
  pullAfter: false,
} as const;

describe("DATA-19: cloneUp of records with null for unset columns", () => {
  it("the server rejects these records as stored, so the shape is one it does not tolerate", async () => {
    const response = await server.router.handle(
      new Request("http://datafn.test/datafn/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "client:raw",
          mutations: [
            {
              resource: "profiles",
              version: 1,
              operation: "replace",
              id: "profiles:p1",
              record: { ...pulledProfile("profiles:p1", "Ada"), id: undefined },
              clientId: "client:raw",
              mutationId: "raw:profiles:p1",
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error).toMatchObject({
      code: "DFQL_INVALID",
      message: "Field 'avatar' expects array, got null",
    });
  });

  it("leaves non-nullable null fields out, keeps nullable nulls, and the server holds the records", async () => {
    const device = connectDevice("c");
    await device.storage.upsertRecord("profiles", pulledProfile("profiles:p1", "Ada"));
    await device.storage.upsertRecord(
      "profiles",
      pulledProfile("profiles:p2", "Grace", {
        avatar: ["grace.png"],
        nickname: "Amazing",
        theme: "dark",
        bio: "Admiral",
      }),
    );
    // Created without the optional fields, for comparison.
    await device.storage.upsertRecord("profiles", { id: "profiles:p3", name: "Linus" });

    const result = await device.client.sync.cloneUp(cloneUpOptions);

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(sentRecords(device)).toEqual([
      { name: "Ada", bio: null },
      { name: "Grace", avatar: ["grace.png"], nickname: "Amazing", theme: "dark", bio: "Admiral" },
      { name: "Linus" },
    ]);

    const [ada, grace, linus] = await serverRecords("profiles");
    expect(ada).toMatchObject({ id: "profiles:p1", name: "Ada", bio: null });
    // The non-nullable fields are unset (or at their defaults), exactly as on
    // a record created without them.
    const unsetFields = (record: Record<string, unknown>) => ({
      avatar: record.avatar ?? undefined,
      nickname: record.nickname ?? undefined,
      theme: record.theme ?? undefined,
    });
    expect(unsetFields(ada)).toEqual(unsetFields(linus));
    expect(ada.avatar ?? undefined).toBeUndefined();
    expect(ada.nickname ?? undefined).toBeUndefined();
    expect(grace).toMatchObject({
      id: "profiles:p2",
      name: "Grace",
      avatar: ["grace.png"],
      nickname: "Amazing",
      theme: "dark",
      bio: "Admiral",
    });
  });

  it("leaves out a null required field too, and reports the server's rejection as ok false", async () => {
    const device = connectDevice("c");
    await device.storage.upsertRecord("profiles", pulledProfile("profiles:p1", null));

    const result = await device.client.sync.cloneUp(cloneUpOptions);

    expect(sentRecords(device)).toEqual([{ bio: null }]);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "DFQL_INVALID",
        message: "Required field missing: name",
      }),
    ]);
    expect(await serverRecords("profiles")).toEqual([]);
  });
});

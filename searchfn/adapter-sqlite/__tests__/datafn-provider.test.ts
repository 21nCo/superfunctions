import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSearchProvider } from "@searchfn/datafn-provider";
import { createDatafnServer } from "@datafn/server";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { SqliteAdapter } from "../src/index";
import { betterSqlite, countRows, type TestDatabase } from "./helpers";

const FILLER_WORDS = ["release", "design", "travel", "recipes", "garden", "finance", "music", "health"];

/**
 * 1,000 bookmark records split across two namespaces. Most are filler; a few planted records
 * make the ranking assertions exact.
 */
function bookmarkRecords(): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = Array.from({ length: 1000 }, (_, i) => ({
    id: `bm-${String(i).padStart(4, "0")}`,
    title: `${FILLER_WORDS[i % FILLER_WORDS.length]} notes ${i}`,
    body: i % 5 === 0 ? `subscription renewal ${i}` : `misc entry ${i}`,
    __ns: i % 2 === 0 ? "ns-a" : "ns-b",
  }));
  Object.assign(records[1], { title: "Subset bookmarks sync", body: "keeps every device aligned", __ns: "ns-a" });
  Object.assign(records[3], { title: "Reading list", body: "subset bookmarks shared with subset readers", __ns: "ns-a" });
  Object.assign(records[5], { title: "Subset bookmarks archive", body: "older items", __ns: "ns-b" });
  return records;
}

describe("@searchfn/datafn-provider over SqliteAdapter", () => {
  let database: TestDatabase;
  let provider: ReturnType<typeof createSearchProvider>;
  const namespaceOf = new Map<string, unknown>();

  beforeEach(async () => {
    database = betterSqlite();
    provider = createSearchProvider(new SqliteAdapter({ driver: database.driver }), {
      resourceFields: { bookmarks: ["title", "body"] },
    });
    await provider.initialize!({ resources: [{ name: "bookmarks", searchFields: ["title", "body"] }] });
    const records = bookmarkRecords();
    for (const record of records) namespaceOf.set(String(record.id), record.__ns);
    await provider.updateIndices({ resource: "bookmarks", records, operation: "upsert" });
  });

  afterEach(() => database.close());

  it("indexes 1,000 records", async () => {
    expect(await countRows(database.driver, "bookmarks", "docs")).toBe(1000);
    expect(await countRows(database.driver, "bookmarks", "fts")).toBe(1000);
  });

  it("answers prefix queries within the namespace filter", async () => {
    const ids = await provider.search({
      resource: "bookmarks",
      query: "sub",
      prefix: true,
      namespaceFilter: ["ns-a"],
      limit: 500,
    });
    // "subscription" is in every 5th record: 100 in ns-a (i % 10 === 0), 99 in ns-b. Plus planted bm-0001, bm-0003.
    expect(ids).toHaveLength(102);
    expect(ids).toEqual(expect.arrayContaining(["bm-0001", "bm-0003", "bm-0000", "bm-0990"]));
    expect(ids).not.toContain("bm-0005");
    expect(ids.every((id) => namespaceOf.get(id) === "ns-a")).toBe(true);
    expect(await provider.search({ resource: "bookmarks", query: "sub", namespaceFilter: ["ns-a"] })).toEqual([]);
  });

  it("ranks multi-term matches and applies field boosts", async () => {
    const query = { resource: "bookmarks", query: "subset bookmarks", namespaceFilter: ["ns-a"] };
    expect(await provider.search({ ...query, fieldBoosts: { title: 10 } })).toEqual(["bm-0001", "bm-0003"]);
    expect(await provider.search({ ...query, fieldBoosts: { body: 10 } })).toEqual(["bm-0003", "bm-0001"]);
    expect(await provider.search({ ...query, namespaceFilter: ["ns-b"] })).toEqual(["bm-0005"]);
    expect(await provider.search({ ...query, query: "subset bookmarks renewal" })).toEqual([]);
  });

  it("ranks prefix matches by BM25 term frequency", async () => {
    const ids = await provider.search({ resource: "bookmarks", query: "subs", prefix: true, namespaceFilter: ["ns-a"], limit: 3 });
    // bm-0003 is the only record with two tokens matching subs*.
    expect(ids[0]).toBe("bm-0003");
    expect(ids).toHaveLength(3);
  });

  it("applies deletes from updateIndices", async () => {
    await provider.updateIndices({ resource: "bookmarks", records: [{ id: "bm-0001" }], operation: "delete" });
    expect(
      await provider.search({ resource: "bookmarks", query: "subset bookmarks", namespaceFilter: ["ns-a"] }),
    ).toEqual(["bm-0003"]);
    expect(await countRows(database.driver, "bookmarks", "docs")).toBe(999);
  });

  it("serves searchAll through the adapter", async () => {
    const results = await provider.searchAll!({ query: "subset", namespaceFilter: ["ns-a"], limit: 5 });
    expect(results.map((result) => [result.resource, result.id])).toEqual([
      ["bookmarks", "bm-0003"],
      ["bookmarks", "bm-0001"],
    ]);
  });
});

describe("@datafn/server search requests", () => {
  const schema = {
    version: 1,
    resources: [
      {
        name: "bookmark",
        version: 1,
        fields: [
          { name: "title", type: "string", required: true },
          { name: "url", type: "string", required: false },
        ],
        indices: { search: ["title"] },
      },
      {
        name: "user",
        version: 1,
        fields: [
          { name: "email", type: "string", required: true },
          { name: "secretNote", type: "string", required: false },
        ],
      },
    ],
    relations: [],
  };

  let database: TestDatabase;

  beforeEach(() => {
    database = betterSqlite();
  });

  afterEach(() => database.close());

  async function call(server: { router: { handle(request: Request): Promise<Response> } }, path: string, tenant: string, body: object) {
    const response = await server.router.handle(
      new Request(`http://localhost/datafn/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant": tenant },
        body: JSON.stringify(body),
      }),
    );
    return response.json() as Promise<{
      ok: boolean;
      result?: {
        data?: Array<{ id: string; title: string }>;
        results?: Array<{ id: string; resource: string; data: Record<string, unknown> }>;
      };
      error?: unknown;
    }>;
  }

  async function startServer() {
    const db = memoryAdapter();
    await db.initialize();
    return createDatafnServer({
      allowUnknownResources: true,
      schema,
      database: db,
      context: (request: Request) => ({ tenant: request.headers.get("x-tenant") ?? "anonymous" }),
      namespaceProvider: { getNamespace: (ctx: { tenant: string }) => `tenant-${ctx.tenant}` },
      searchProvider: createSearchProvider(new SqliteAdapter({ driver: database.driver })),
    } as Parameters<typeof createDatafnServer>[0]);
  }

  async function insert(server: Awaited<ReturnType<typeof startServer>>, tenant: string, resource: string, id: string, record: object) {
    const result = await call(server, "mutation", tenant, {
      resource,
      version: 1,
      operation: "insert",
      clientId: `client-${tenant}`,
      mutationId: `m-${id}`,
      id,
      record,
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  }

  it("indexes mutations and answers search queries scoped to the request namespace", async () => {
    const server = await startServer();

    const inserts: Array<[string, string, string]> = [
      ["a", "bookmark:1", "Subset bookmarks sync"],
      ["a", "bookmark:2", "Weekly groceries"],
      ["b", "bookmark:3", "Subset bookmarks archive"],
    ];
    for (const [tenant, id, title] of inserts) {
      await insert(server, tenant, "bookmark", id, { title });
    }
    expect(await countRows(database.driver, "bookmark", "docs")).toBe(3);

    const search = (tenant: string, query: string) =>
      call(server, "query", tenant, {
        resource: "bookmark",
        version: 1,
        select: ["id", "title"],
        search: { query, prefix: true },
      });

    const tenantA = await search("a", "subs bookm");
    expect(tenantA.ok).toBe(true);
    expect(tenantA.result?.data?.map((row) => row.id)).toEqual(["bookmark:1"]);
    const tenantB = await search("b", "subs");
    expect(tenantB.result?.data?.map((row) => row.id)).toEqual(["bookmark:3"]);
    expect((await search("a", "groceries")).result?.data?.map((row) => row.title)).toEqual(["Weekly groceries"]);

    await server.close();
  });

  it("never indexes or returns records of a resource without search indices", async () => {
    const server = await startServer();
    await insert(server, "a", "user", "user:1", { email: "zebra@example.com", secretNote: "zebra zebra zebra" });
    await insert(server, "a", "bookmark", "bookmark:1", { title: "Zebra crossing" });

    const tables = await database.driver.all<{ resource: string }>(`SELECT resource FROM "searchfn_resources"`);
    expect(tables.map((row) => row.resource)).toEqual(["bookmark"]);

    const result = await call(server, "search", "a", { query: "zebra" });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.result?.results?.map((item) => [item.resource, item.id])).toEqual([["bookmark", "bookmark:1"]]);

    await server.close();
  });
});

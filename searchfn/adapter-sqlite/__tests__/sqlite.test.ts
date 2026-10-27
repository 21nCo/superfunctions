import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FUZZY_UNSUPPORTED_WARNING,
  SEARCH_ADAPTER_DISPOSED,
  SqliteAdapter,
  type SqliteDriver,
  type SqliteStatement,
} from "../src/index";
import { betterSqlite, countRows, generationOf, type TestDatabase } from "./helpers";

const BOOKMARKS = [{ name: "bookmarks", searchFields: ["title", "body"] }];

let database: TestDatabase;
let adapter: SqliteAdapter;

beforeEach(async () => {
  database = betterSqlite();
  adapter = new SqliteAdapter({ driver: database.driver });
});

afterEach(() => {
  vi.restoreAllMocks();
  database.close();
});

async function seedBookmarks(target: SqliteAdapter = adapter): Promise<void> {
  await target.initialize({ resources: BOOKMARKS });
  await target.index({
    resource: "bookmarks",
    documents: [
      { id: "b1", fields: { title: "Subset bookmarks sync", body: "keeps devices aligned" }, metadata: { __ns: "team-a", __region: "eu" } },
      { id: "b2", fields: { title: "Reading list", body: "subset bookmarks for subset readers" }, metadata: { __ns: "team-a", __region: "us" } },
      { id: "b3", fields: { title: "Subset bookmarks archive", body: "old" }, metadata: { __ns: "team-b", __region: "eu" } },
      { id: "b4", fields: { title: "Subscription billing", body: "invoices" }, metadata: { __ns: "team-a" } },
      { id: "b5", fields: { title: "Café menus", body: "naïve résumé" } },
    ],
  });
}

describe("capabilities", () => {
  it("declares FTS5 features and reports fuzzy as unsupported", () => {
    expect(adapter.name).toBe("sqlite");
    expect(adapter.capabilities).toEqual({
      persistent: true,
      searchAll: true,
      fuzzy: false,
      prefix: true,
      fieldBoosts: true,
      metadataFilters: true,
      maxBatchSize: 500,
    });
  });

  it("rejects an unsafe table prefix and a missing driver", () => {
    expect(() => new SqliteAdapter({ driver: database.driver, tablePrefix: 'x"; DROP TABLE y; --' })).toThrow(
      /tablePrefix/,
    );
    expect(() => new SqliteAdapter({ driver: undefined as unknown as SqliteDriver })).toThrow(/driver/);
  });
});

describe("query semantics", () => {
  beforeEach(() => seedBookmarks());

  it("matches whole terms by default and term prefixes with prefix: true", async () => {
    expect(await adapter.search({ resource: "bookmarks", query: "sub" })).toEqual([]);
    const prefixed = await adapter.search({ resource: "bookmarks", query: "sub", prefix: true });
    expect([...prefixed].sort()).toEqual(["b1", "b2", "b3", "b4"]);
  });

  it("applies the prefix default from construct-time defaults", async () => {
    const prefixing = new SqliteAdapter({ driver: database.driver, defaults: { prefix: true } });
    const ids = await prefixing.search({ resource: "bookmarks", query: "subs" });
    expect([...ids].sort()).toEqual(["b1", "b2", "b3", "b4"]);
  });

  it("requires every term of a multi-term query", async () => {
    const ids = await adapter.search({ resource: "bookmarks", query: "subset readers" });
    expect(ids).toEqual(["b2"]);
  });

  it("folds case and diacritics", async () => {
    expect(await adapter.search({ resource: "bookmarks", query: "CAFE resume NAIVE" })).toEqual(["b5"]);
  });

  it("treats FTS5 syntax in user input as literal text", async () => {
    const baseline = await adapter.search({ resource: "bookmarks", query: "subset" });
    expect([...baseline].sort()).toEqual(["b1", "b2", "b3"]);
    // Only the word "subset" survives tokenization, so these must behave like the baseline.
    for (const query of ['subset"', '"subset"', "subset*", "-subset", "^subset", "(subset)", "subset:"]) {
      expect(await adapter.search({ resource: "bookmarks", query })).toEqual(baseline);
    }
    // Operators and column names become literal terms that no document contains.
    for (const query of ['"', "subset AND", "NOT subset", "title:subset", "NEAR(subset", "{c0}: subset", "AND", " ... "]) {
      expect(await adapter.search({ resource: "bookmarks", query })).toEqual([]);
    }
  });

  it("ranks by BM25 and honours field boosts", async () => {
    const titleFirst = await adapter.search({
      resource: "bookmarks",
      query: "subset bookmarks",
      namespaceFilter: ["team-a"],
      fieldBoosts: { title: 10, body: 1 },
    });
    const bodyFirst = await adapter.search({
      resource: "bookmarks",
      query: "subset bookmarks",
      namespaceFilter: ["team-a"],
      fieldBoosts: { title: 1, body: 10 },
    });
    expect(titleFirst).toEqual(["b1", "b2"]);
    expect(bodyFirst).toEqual(["b2", "b1"]);
  });

  it("rejects negative or non-finite field boosts", async () => {
    for (const boost of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        adapter.search({ resource: "bookmarks", query: "subset", fieldBoosts: { title: boost } }),
      ).rejects.toMatchObject({ code: "DFQL_INVALID" });
    }
  });

  it("restricts matching to the requested fields", async () => {
    expect(await adapter.search({ resource: "bookmarks", query: "readers", fields: ["title"] })).toEqual([]);
    expect(await adapter.search({ resource: "bookmarks", query: "readers", fields: ["body"] })).toEqual(["b2"]);
    expect(await adapter.search({ resource: "bookmarks", query: "readers", fields: ["unknown"] })).toEqual([]);
  });

  it("enforces namespace and region filters and excludes documents without metadata", async () => {
    const teamA = await adapter.search({ resource: "bookmarks", query: "sub", prefix: true, namespaceFilter: ["team-a"] });
    expect([...teamA].sort()).toEqual(["b1", "b2", "b4"]);
    const euTeamA = await adapter.search({
      resource: "bookmarks",
      query: "subset",
      namespaceFilter: ["team-a", "team-b"],
      regionFilter: ["eu"],
    });
    expect([...euTeamA].sort()).toEqual(["b1", "b3"]);
    expect(await adapter.search({ resource: "bookmarks", query: "cafe", namespaceFilter: ["team-a"] })).toEqual([]);
  });

  it("normalizes limit", async () => {
    const all = { resource: "bookmarks", query: "sub", prefix: true } as const;
    expect(await adapter.search({ ...all, limit: 2 })).toHaveLength(2);
    expect(await adapter.search({ ...all, limit: 0 })).toHaveLength(1);
    expect(await adapter.search({ ...all, limit: Number.NaN })).toHaveLength(4);
  });

  it("returns empty results for an unknown resource without creating tables", async () => {
    const fresh = betterSqlite();
    const reader = new SqliteAdapter({ driver: fresh.driver });
    expect(await reader.search({ resource: "nope", query: "x" })).toEqual([]);
    expect(await reader.searchAll({ query: "x" })).toEqual([]);
    await reader.remove({ resource: "nope", ids: ["1"] });
    await reader.clear("nope");
    await reader.rebuild("nope");
    expect(await fresh.driver.all("SELECT name FROM sqlite_master")).toEqual([]);
    fresh.close();
  });
});

describe("fuzzy", () => {
  beforeEach(() => seedBookmarks());

  it("ignores fuzzy and warns once through the observability logger", async () => {
    const warn = vi.fn();
    const logged = new SqliteAdapter({ driver: database.driver, observability: { logger: { warn } } });
    const exact = await logged.search({ resource: "bookmarks", query: "subset" });
    expect(await logged.search({ resource: "bookmarks", query: "subset", fuzzy: true })).toEqual(exact);
    expect(await logged.search({ resource: "bookmarks", query: "subzet", fuzzy: 2 })).toEqual([]);
    await logged.searchAll({ query: "subset", fuzzy: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(FUZZY_UNSUPPORTED_WARNING, { adapter: "sqlite" });
  });

  it("falls back to console.warn, including for a fuzzy default", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fuzzyDefault = new SqliteAdapter({ driver: database.driver, defaults: { fuzzy: true } });
    await fuzzyDefault.search({ resource: "bookmarks", query: "subset" });
    await fuzzyDefault.search({ resource: "bookmarks", query: "subset" });
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleWarn.mock.calls[0][0]).toContain(FUZZY_UNSUPPORTED_WARNING);
  });

  it("does not warn for fuzzy: false or 0", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await adapter.search({ resource: "bookmarks", query: "subset", fuzzy: false });
    await adapter.search({ resource: "bookmarks", query: "subset", fuzzy: 0 });
    expect(consoleWarn).not.toHaveBeenCalled();
  });
});

describe("documents and ids", () => {
  it("preserves numeric and string id types", async () => {
    await adapter.initialize({ resources: [{ name: "items", searchFields: ["title"] }] });
    await adapter.index({
      resource: "items",
      documents: [
        { id: 42, fields: { title: "alpha" } },
        { id: "0042", fields: { title: "alpha" } },
      ],
    });
    expect(await adapter.search({ resource: "items", query: "alpha" })).toEqual(["0042", 42]);
    await adapter.remove({ resource: "items", ids: ["42"] });
    expect(await adapter.search({ resource: "items", query: "alpha" })).toEqual(["0042"]);
  });

  it("keeps the last duplicate id within one batch", async () => {
    await adapter.initialize({ resources: [{ name: "items", searchFields: ["title"] }] });
    await adapter.index({
      resource: "items",
      documents: [
        { id: "d1", fields: { title: "first" } },
        { id: "d1", fields: { title: "second" } },
      ],
    });
    expect(await adapter.search({ resource: "items", query: "first" })).toEqual([]);
    expect(await adapter.search({ resource: "items", query: "second" })).toEqual(["d1"]);
    expect(await countRows(database.driver, "items", "docs")).toBe(1);
  });

  it("rejects invalid ids and documents", async () => {
    await adapter.initialize({ resources: [{ name: "items", searchFields: ["title"] }] });
    for (const id of [Number.NaN, {}, null]) {
      await expect(
        adapter.index({ resource: "items", documents: [{ id: id as unknown as string, fields: { title: "x" } }] }),
      ).rejects.toMatchObject({ code: "DFQL_INVALID" });
    }
    await expect(
      adapter.index({ resource: "items", documents: [{ id: "x", fields: "nope" as unknown as Record<string, string> }] }),
    ).rejects.toMatchObject({ code: "DFQL_INVALID" });
  });

  it("stringifies non-string field values and skips null values", async () => {
    await adapter.initialize({ resources: [{ name: "items", searchFields: ["title", "count", "tags"] }] });
    await adapter.index({
      resource: "items",
      documents: [
        { id: "d1", fields: { title: null, count: 7, tags: ["red", "blue"] } as unknown as Record<string, string> },
      ],
    });
    expect(await adapter.search({ resource: "items", query: "7" })).toEqual(["d1"]);
    expect(await adapter.search({ resource: "items", query: "blue" })).toEqual(["d1"]);
  });

  it("registers an uninitialized resource from the indexed field names", async () => {
    await adapter.index({ resource: "notes", documents: [{ id: "n1", fields: { body: "hello world" } }] });
    expect(await adapter.search({ resource: "notes", query: "hello" })).toEqual(["n1"]);
    await expect(adapter.index({ resource: "empty", documents: [{ id: "e1", fields: {} }] })).rejects.toMatchObject({
      code: "DFQL_INVALID",
    });
  });

  it("indexes more documents than one batch holds", async () => {
    const small = new SqliteAdapter({ driver: database.driver, maxBatchSize: 7 });
    await small.initialize({ resources: [{ name: "items", searchFields: ["title"] }] });
    await small.index({
      resource: "items",
      documents: Array.from({ length: 50 }, (_, i) => ({ id: i, fields: { title: `common ${i}` } })),
    });
    expect(await small.search({ resource: "items", query: "common", limit: 100 })).toHaveLength(50);
    await small.remove({ resource: "items", ids: Array.from({ length: 50 }, (_, i) => i) });
    expect(await countRows(database.driver, "items", "docs")).toBe(0);
  });

  it("handles hostile resource and field names as data", async () => {
    const resource = 'x"; DROP TABLE "searchfn_resources"; --';
    const field = "it's \"quoted\" ]";
    await adapter.initialize({ resources: [{ name: resource, searchFields: [field] }] });
    await adapter.index({ resource, documents: [{ id: "d1", fields: { [field]: "payload" } }] });
    expect(await adapter.search({ resource, query: "payload", fields: [field], fieldBoosts: { [field]: 2 } })).toEqual(["d1"]);
    await adapter.initialize({ resources: [{ name: "proto", searchFields: ["__proto__"] }] });
    await adapter.index({ resource: "proto", documents: [{ id: "p1", fields: JSON.parse('{"__proto__": "inherited"}') }] });
    expect(await adapter.search({ resource: "proto", query: "inherited" })).toEqual(["p1"]);
    await expect(
      adapter.initialize({ resources: [{ name: "bad", searchFields: ["a\u0000b"] }] }),
    ).rejects.toMatchObject({ code: "DFQL_INVALID" });
    await expect(adapter.initialize({ resources: [{ name: "bad", searchFields: [] }] })).rejects.toMatchObject({
      code: "DFQL_INVALID",
    });
  });
});

describe("idempotency", () => {
  it("re-initializing with the same fields in any order does not rebuild", async () => {
    await seedBookmarks();
    await adapter.initialize({ resources: BOOKMARKS });
    await adapter.initialize({ resources: [{ name: "bookmarks", searchFields: ["body", "title", "body"] }] });
    expect(await generationOf(database.driver, "bookmarks")).toBe(0);
    expect(await countRows(database.driver, "bookmarks", "fts")).toBe(5);
  });

  it("upserting the same document twice leaves one row in each table", async () => {
    await seedBookmarks();
    const document = { id: "b1", fields: { title: "Subset bookmarks sync", body: "keeps devices aligned" } };
    await adapter.index({ resource: "bookmarks", documents: [document] });
    await adapter.index({ resource: "bookmarks", documents: [document] });
    expect(await countRows(database.driver, "bookmarks", "docs")).toBe(5);
    expect(await countRows(database.driver, "bookmarks", "fts")).toBe(5);
  });

  it("an upsert replaces metadata", async () => {
    await seedBookmarks();
    await adapter.index({
      resource: "bookmarks",
      documents: [{ id: "b1", fields: { title: "Subset bookmarks sync" }, metadata: { __ns: "team-b" } }],
    });
    expect(await adapter.search({ resource: "bookmarks", query: "sync", namespaceFilter: ["team-a"] })).toEqual([]);
    expect(await adapter.search({ resource: "bookmarks", query: "sync", namespaceFilter: ["team-b"] })).toEqual(["b1"]);
  });

  it("delete and clear are repeatable", async () => {
    await seedBookmarks();
    await adapter.remove({ resource: "bookmarks", ids: ["b1", "b1", "missing"] });
    await adapter.remove({ resource: "bookmarks", ids: ["b1"] });
    expect(await countRows(database.driver, "bookmarks", "fts")).toBe(4);
    await adapter.clear("bookmarks");
    await adapter.clear("bookmarks");
    expect(await countRows(database.driver, "bookmarks", "docs")).toBe(0);
    expect(await countRows(database.driver, "bookmarks", "fts")).toBe(0);
  });

  it("rebuild is repeatable and preserves results", async () => {
    await seedBookmarks();
    const before = await adapter.search({ resource: "bookmarks", query: "subset", limit: 10 });
    await adapter.rebuild("bookmarks");
    await adapter.rebuild("bookmarks");
    expect(await generationOf(database.driver, "bookmarks")).toBe(2);
    expect(await adapter.search({ resource: "bookmarks", query: "subset", limit: 10 })).toEqual(before);
    expect(await countRows(database.driver, "bookmarks", "fts")).toBe(5);
    const fts = await database.driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'searchfn_r%_fts_%' AND name NOT LIKE '%\\_fts\\_%\\_%' ESCAPE '\\'",
    );
    expect(fts.map((row) => row.name)).toEqual(["searchfn_r1_fts_2"]);
  });

  it("changing declared fields rebuilds from stored documents", async () => {
    await adapter.initialize({ resources: [{ name: "bookmarks", searchFields: ["title"] }] });
    await adapter.index({ resource: "bookmarks", documents: [{ id: "b1", fields: { title: "alpha", body: "beta" } }] });
    expect(await adapter.search({ resource: "bookmarks", query: "beta" })).toEqual([]);

    await adapter.initialize({ resources: BOOKMARKS });
    expect(await generationOf(database.driver, "bookmarks")).toBe(1);
    expect(await adapter.search({ resource: "bookmarks", query: "beta" })).toEqual(["b1"]);
    expect(await adapter.search({ resource: "bookmarks", query: "alpha", fields: ["title"] })).toEqual(["b1"]);
  });
});

describe("multiple adapter instances on one database", () => {
  it("an instance with a stale generation reloads after another instance rebuilt", async () => {
    const writer = new SqliteAdapter({ driver: database.driver });
    const reader = new SqliteAdapter({ driver: database.driver });
    await writer.initialize({ resources: [{ name: "bookmarks", searchFields: ["title"] }] });
    await writer.index({ resource: "bookmarks", documents: [{ id: "b1", fields: { title: "alpha", body: "beta" } }] });
    expect(await reader.search({ resource: "bookmarks", query: "alpha" })).toEqual(["b1"]);

    await writer.initialize({ resources: BOOKMARKS });

    expect(await reader.search({ resource: "bookmarks", query: "beta" })).toEqual(["b1"]);
    await reader.index({ resource: "bookmarks", documents: [{ id: "b2", fields: { title: "gamma", body: "beta" } }] });
    expect(await writer.search({ resource: "bookmarks", query: "beta" })).toEqual(["b1", "b2"]);
  });

  it("concurrent registrations of one resource converge", async () => {
    const instances = Array.from({ length: 4 }, () => new SqliteAdapter({ driver: database.driver }));
    await Promise.all(instances.map((instance) => instance.initialize({ resources: BOOKMARKS })));
    await instances[0].index({ resource: "bookmarks", documents: [{ id: "b1", fields: { title: "alpha" } }] });
    for (const instance of instances) {
      expect(await instance.search({ resource: "bookmarks", query: "alpha" })).toEqual(["b1"]);
    }
    expect(await generationOf(database.driver, "bookmarks")).toBe(0);
  });
});

describe("drivers without batch()", () => {
  function sequentialDriver(failOn?: RegExp): SqliteDriver & { failOn?: RegExp } {
    const inner = database.driver;
    const driver: SqliteDriver & { failOn?: RegExp } = {
      failOn,
      exec: (sql) => inner.exec(sql),
      all: (sql, params) => inner.all(sql, params),
      run: async (sql, params) => {
        if (driver.failOn?.test(sql)) throw new Error("injected failure");
        return inner.run(sql, params);
      },
    };
    return driver;
  }

  it("runs statements one by one", async () => {
    const sequential = new SqliteAdapter({ driver: sequentialDriver() });
    await seedBookmarks(sequential);
    expect(await sequential.search({ resource: "bookmarks", query: "readers" })).toEqual(["b2"]);
    await sequential.remove({ resource: "bookmarks", ids: ["b2"] });
    expect(await sequential.search({ resource: "bookmarks", query: "readers" })).toEqual([]);
  });

  it("recovers from a rebuild interrupted after the new FTS table was created", async () => {
    const driver = sequentialDriver();
    const sequential = new SqliteAdapter({ driver });
    await sequential.initialize({ resources: [{ name: "bookmarks", searchFields: ["title"] }] });
    await sequential.index({ resource: "bookmarks", documents: [{ id: "b1", fields: { title: "alpha", body: "beta" } }] });

    driver.failOn = /^INSERT INTO "searchfn_r1_fts_1"/;
    await expect(sequential.initialize({ resources: BOOKMARKS })).rejects.toThrow("injected failure");
    expect(await generationOf(database.driver, "bookmarks")).toBe(0);
    expect(await sequential.search({ resource: "bookmarks", query: "alpha" })).toEqual(["b1"]);

    driver.failOn = undefined;
    await sequential.initialize({ resources: BOOKMARKS });
    expect(await generationOf(database.driver, "bookmarks")).toBe(1);
    expect(await sequential.search({ resource: "bookmarks", query: "beta" })).toEqual(["b1"]);
  });
});

describe("atomic batches", () => {
  it("a failed write batch leaves the index unchanged", async () => {
    await seedBookmarks();
    const inner = database.driver;
    const failing: SqliteDriver = {
      ...inner,
      batch: (statements: readonly SqliteStatement[]) =>
        inner.batch!([...statements, { sql: "INSERT INTO missing_table VALUES (1)" }]),
    };
    const broken = new SqliteAdapter({ driver: failing });
    await expect(
      broken.index({ resource: "bookmarks", documents: [{ id: "b1", fields: { title: "replaced" } }] }),
    ).rejects.toThrow(/missing_table/);
    expect(await adapter.search({ resource: "bookmarks", query: "sync" })).toEqual(["b1"]);
    expect(await adapter.search({ resource: "bookmarks", query: "replaced" })).toEqual([]);
    expect(await countRows(database.driver, "bookmarks", "fts")).toBe(5);
  });
});

describe("lifecycle and cancellation", () => {
  it("dispose blocks operations but leaves the injected driver open", async () => {
    await seedBookmarks();
    await adapter.dispose();
    await expect(adapter.search({ resource: "bookmarks", query: "subset" })).rejects.toMatchObject({
      code: SEARCH_ADAPTER_DISPOSED,
    });
    await expect(adapter.index({ resource: "bookmarks", documents: [] })).rejects.toMatchObject({
      code: SEARCH_ADAPTER_DISPOSED,
    });
    expect(await database.driver.all("SELECT 1 AS one")).toEqual([{ one: 1 }]);
    await adapter.initialize({ resources: BOOKMARKS });
    expect(await adapter.search({ resource: "bookmarks", query: "readers" })).toEqual(["b2"]);
  });

  it("rejects aborted operations with DFQL_ABORTED", async () => {
    await seedBookmarks();
    const signal = AbortSignal.abort();
    await expect(adapter.search({ resource: "bookmarks", query: "subset", signal })).rejects.toMatchObject({
      code: "DFQL_ABORTED",
    });
    await expect(adapter.searchAll({ query: "subset", signal })).rejects.toMatchObject({ code: "DFQL_ABORTED" });
    await expect(
      adapter.index({ resource: "bookmarks", documents: [{ id: "x", fields: { title: "x" } }], signal }),
    ).rejects.toMatchObject({ code: "DFQL_ABORTED" });
    await expect(adapter.remove({ resource: "bookmarks", ids: ["b1"], signal })).rejects.toMatchObject({
      code: "DFQL_ABORTED",
    });
    await expect(adapter.clear("bookmarks", signal)).rejects.toMatchObject({ code: "DFQL_ABORTED" });
    expect(await countRows(database.driver, "bookmarks", "docs")).toBe(5);
  });
});

describe("searchAll", () => {
  it("merges resources by score, then resource, then id, and lists resources from storage", async () => {
    await adapter.initialize({
      resources: [
        { name: "items", searchFields: ["title"] },
        { name: "notes", searchFields: ["body"] },
      ],
    });
    await adapter.index({ resource: "items", documents: [{ id: "i1", fields: { title: "common term" } }] });
    await adapter.index({ resource: "notes", documents: [{ id: "n1", fields: { body: "common term" } }] });

    const other = new SqliteAdapter({ driver: database.driver });
    const results = await other.searchAll({ query: "common", limit: 10 });
    expect(results.map((result) => [result.resource, result.id])).toEqual([
      ["items", "i1"],
      ["notes", "n1"],
    ]);
    expect(results[0].score).toBeGreaterThan(0);
    expect(await other.searchAll({ query: "common", resources: ["notes", "missing"] })).toHaveLength(1);
    expect(await other.searchAll({ query: "common", limit: 1 })).toHaveLength(1);
  });
});

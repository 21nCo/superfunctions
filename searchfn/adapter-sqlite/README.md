# @searchfn/adapter-sqlite

SearchFn adapter for server-side full-text search on SQLite [FTS5](https://www.sqlite.org/fts5.html). It reaches SQLite through an injected driver, so it runs on Node with `better-sqlite3`, on libSQL or Turso with `@libsql/client`, and on Cloudflare Workers with a D1 binding. No driver is a hard dependency.

```bash
npm install @searchfn/adapter-sqlite
```

```typescript
import Database from "better-sqlite3";
import { SqliteAdapter, fromBetterSqlite3 } from "@searchfn/adapter-sqlite";

const adapter = new SqliteAdapter({ driver: fromBetterSqlite3(new Database("app.db")) });
await adapter.initialize({ resources: [{ name: "bookmarks", searchFields: ["title", "notes"] }] });
await adapter.index({
  resource: "bookmarks",
  documents: [{ id: "b1", fields: { title: "Subset bookmarks" }, metadata: { __ns: "team-a" } }],
});
const ids = await adapter.search({ resource: "bookmarks", query: "subs", prefix: true, namespaceFilter: ["team-a"] });
```

Other drivers: `fromLibsql(createClient({ url }))` and `fromD1(env.DB)`.

- `unicode61 remove_diacritics 2` tokenizer; every query term must match; `prefix: true` matches term prefixes.
- BM25 ranking with per-field `fieldBoosts`; `namespaceFilter` / `regionFilter` enforced in SQL.
- Fuzzy search is not supported: `capabilities.fuzzy` is `false` and the `fuzzy` option is ignored with a one-time warning.
- Writes run in one transaction per batch (`maxBatchSize`, default 500). Changing declared fields rebuilds the index from stored documents; `rebuild(resource)` does so on demand.
- `dispose()` does not close the driver.

Docs: [SQLite adapter reference](https://searchfn.com/docs/reference/adapters/sqlite) and [Deploy: Cloudflare Workers](https://searchfn.com/docs/documentation/deploy/cloudflare-workers).

## Tests

`npm test` runs the shared adapter conformance suite and adapter tests on `better-sqlite3` and `@libsql/client`, then the D1 suites inside workerd via `@cloudflare/vitest-pool-workers` (local D1, no Cloudflare account).

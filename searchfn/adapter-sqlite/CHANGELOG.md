# Changelog

## 0.1.0 - Unreleased

- Initial release: `SqliteAdapter`, a SearchFn adapter on SQLite FTS5 with BM25 ranking, field boosts, prefix search and namespace/region filters.
- Driver port `SqliteDriver` with `fromBetterSqlite3`, `fromLibsql` and `fromD1` bindings; `better-sqlite3` and `@libsql/client` are optional peer dependencies.
- Fuzzy search is not supported; the adapter reports `fuzzy: false` and ignores the option with a one-time warning.
- After `initialize()`, only declared resources are indexed and searched, so `@datafn/server` mutations of resources without search indices are never stored or returned.
- Writes and searches verify the published index generation, so an instance never reads or writes a retired FTS table; `rebuild()` drops every older generation, and a delayed registration can no longer recreate one.
- Rebuild cleanup runs inside the rebuild transaction after the generation check, so it never drops an index another instance published. Concurrent use requires a driver with `batch()`; without it, callers must serialize operations.
- `index()` and `remove()` keep a registered but undeclared resource current, so declaring it again never returns stale records.
- Writes are split by serialized bytes (512 KiB per bound value); an oversized document or id is rejected before anything is written.
- The package is ESM-only; the CommonJS entry, which could not load its ESM dependencies, is removed.
- An explicitly empty `fields` or `resources` list selects nothing instead of everything. Score ties break by resource and id in code point order (SQLite's binary order) before every limit and in the cross-resource merge.

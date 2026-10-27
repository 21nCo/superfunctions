# Changelog

## 0.1.0 - Unreleased

- Initial release: `SqliteAdapter`, a SearchFn adapter on SQLite FTS5 with BM25 ranking, field boosts, prefix search and namespace/region filters.
- Driver port `SqliteDriver` with `fromBetterSqlite3`, `fromLibsql` and `fromD1` bindings; `better-sqlite3` and `@libsql/client` are optional peer dependencies.
- Fuzzy search is not supported; the adapter reports `fuzzy: false` and ignores the option with a one-time warning.
- After `initialize()`, only declared resources are indexed and searched, so `@datafn/server` mutations of resources without search indices are never stored or returned.
- Writes and searches verify the published index generation, so an instance never reads or writes a retired FTS table; `rebuild()` drops every older generation, and a delayed registration can no longer recreate one.

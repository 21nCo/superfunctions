# Changelog

## 0.2.0 - Unreleased

- `PostgresAdapter` accepts an injected `driver` (`PostgresDriver`: `query(sql, params)` and an optional `transaction(fn)`) as an alternative to `connectionString`, with `fromPg(pool)` and `fromPostgresJs(sql)` bindings. With either binding on a Hyperdrive connection string it runs on Cloudflare Workers (`nodejs_compat`).
- `pg` is imported only when `connectionString` is used, so a Worker that injects postgres.js does not load it. The `connectionString` path is otherwise unchanged and still owns and ends its Pool.
- The adapter never closes an injected driver. `queryTimeoutMs` applies only to `connectionString` and is rejected with `driver`, as is passing both `driver` and `connectionString`.
- `index()` runs each batch in `driver.transaction()`; a driver without it runs the batch's statements one by one.
- Array parameters (`searchFields` in the metadata table, the `fields` search filter) are sent as Postgres array literals, the same wire value `pg` sends, so drivers without array type information (postgres.js with `fetch_types: false`) work.
- postgres.js `CONNECT_TIMEOUT` and `CONNECTION_CLOSED` errors are retried like the transient SQLSTATE codes.
- `fromPg` transactions keep the statement error when `ROLLBACK` also fails, and discard that client instead of returning it to the pool.

## 0.1.0

- Initial release.

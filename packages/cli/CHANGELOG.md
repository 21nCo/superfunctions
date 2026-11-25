# Changelog

## Unreleased

- MySQL migrations: introspected `TEXT`, `MEDIUMTEXT` and `LONGTEXT` columns (reported with a length such as 65535) now match schema strings without a `maxLength`, and `TINYINT(1)` columns match boolean fields (numeric fields keep comparing them as integers), so unchanged columns no longer produce changes or errors on upgrade.
- MySQL migrations: `generate` introspects MySQL through the Kysely adapter's callback `mysql2` pool and the Prisma client, not only the Drizzle promise pool. For Prisma, the dialect comes from the client's provider and the MySQL schema from the client's connection (`SELECT DATABASE()`), not from `DATABASE_URL`, which can name another database.
- MySQL migrations: widening a `VARCHAR` keeps its full-column indexes in place with one `MODIFY COLUMN` instead of dropping and recreating them, so a unique index enforces uniqueness for the whole upgrade. Prefixed or over-budget keys and type changes still rebuild the index. On a `COMPACT` or `REDUNDANT` table, where a key part is limited to 767 bytes, a widening that would exceed it is refused before any DDL with the `ROW_FORMAT=DYNAMIC` remediation.

## 0.2.1

- `generate-schema` accepts `-d, --dialect <postgres|mysql|sqlite>` and emits a Drizzle schema for that dialect. 0.2.0 has no `--dialect` option and always emits Postgres.
- Documented and validated the direct Drizzle fallback path for Conduct schema constraints.
- Added a schema-support harness proving composite unique + CHECK constraint coverage.

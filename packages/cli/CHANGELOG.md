# Changelog

## 0.2.3

- Released with the bare `superfunctions` package, the Superfunctions front door: `npx superfunctions` runs this CLI at the same version (and so does the `sfs` alias once `superfunctions` is installed). A project that adds `superfunctions` should drop a direct `@superfunctions/cli` dependency or keep it at the same version, since both provide the `superfunctions` and `sfs` commands.
- When started with `BARE_EXPECTED_CLI` naming `@superfunctions/cli` at another version (the bare package reached a different installed copy through `npm exec`), the CLI exits 1 with the version it expected and how to run it.

## 0.2.2

- MySQL migrations: introspected `TEXT`, `MEDIUMTEXT` and `LONGTEXT` columns (reported with a length such as 65535) now match schema strings without a `maxLength`, and `TINYINT(1)` columns match boolean fields (numeric fields keep comparing them as integers), so unchanged columns no longer produce changes or errors on upgrade.
- MySQL migrations: `generate` introspects MySQL through the Kysely adapter's callback `mysql2` pool and the Prisma client, not only the Drizzle promise pool. The MySQL schema it reads is the connection's own database (`SELECT DATABASE()`) for every adapter, not a database parsed from a connection URL or `DATABASE_URL`, and the Prisma dialect comes from the client's provider before `DATABASE_URL`.
- MySQL migrations: widening a `VARCHAR` keeps its full-column indexes in place with one `MODIFY COLUMN` instead of dropping and recreating them, so a unique index enforces uniqueness for the whole upgrade. Prefixed keys and type changes still rebuild the index. Every key kept or rebuilt on a changed column is first sized against the table's InnoDB budget: 767 bytes per key part on `COMPACT` or `REDUNDANT` tables, 3,072 on `DYNAMIC` tables, and a total of 3,072, 1,536 or 768 bytes for 16 KiB (or larger), 8 KiB or 4 KiB `innodb_page_size`. String parts count in the character set the changed column keeps (its own, or the table default for a column that becomes a string). A key over budget is refused before any DDL, with the `ROW_FORMAT=DYNAMIC` remediation only when the row format is the limit. The check fails closed: it models only InnoDB `DYNAMIC`, `COMPACT` and `REDUNDANT` tables with a known page size, and refuses a changed key on any other layout, such as a `COMPRESSED` table limited by its `KEY_BLOCK_SIZE`, another engine or missing metadata. Only MySQL 8.0+ and MariaDB 10.3+ (where large index prefixes are always on) get the 3,072-byte `DYNAMIC` key part; an older server, or one whose version cannot be read, keeps the 767-byte limit.

## 0.2.1

- `generate-schema` accepts `-d, --dialect <postgres|mysql|sqlite>` and emits a Drizzle schema for that dialect. 0.2.0 has no `--dialect` option and always emits Postgres.
- Documented and validated the direct Drizzle fallback path for Conduct schema constraints.
- Added a schema-support harness proving composite unique + CHECK constraint coverage.

# Changelog

## Unreleased

- MySQL migrations: introspected `TEXT`, `MEDIUMTEXT` and `LONGTEXT` columns (reported with a length such as 65535) now match schema strings without a `maxLength`, and `TINYINT(1)` columns match boolean fields, so unchanged columns no longer produce changes or errors on upgrade.
- MySQL migrations: widening a `VARCHAR` keeps its full-column indexes in place with one `MODIFY COLUMN` instead of dropping and recreating them, so a unique index enforces uniqueness for the whole upgrade. Prefixed or over-budget keys and type changes still rebuild the index.

## 0.2.1

- `generate-schema` accepts `-d, --dialect <postgres|mysql|sqlite>` and emits a Drizzle schema for that dialect. 0.2.0 has no `--dialect` option and always emits Postgres.
- Documented and validated the direct Drizzle fallback path for Conduct schema constraints.
- Added a schema-support harness proving composite unique + CHECK constraint coverage.

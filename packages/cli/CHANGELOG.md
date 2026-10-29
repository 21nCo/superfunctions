# Changelog

## 0.2.1

- `generate-schema` accepts `-d, --dialect <postgres|mysql|sqlite>` and emits a Drizzle schema for that dialect. 0.2.0 has no `--dialect` option and always emits Postgres.
- Documented and validated the direct Drizzle fallback path for Conduct schema constraints.
- Added a schema-support harness proving composite unique + CHECK constraint coverage.

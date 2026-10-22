# Kysely persistence prerequisite — 2026-10-20

The public Kysely adapter now honors explicit string/composite `conflictTarget` values for SQLite/PostgreSQL upserts instead of always choosing the first where field. Empty targets are rejected. Upsert and update now use Kysely's returningAll() for complete rows; quoting `*` as an ordinary identifier caused actual SQLite failures. Existing selected-column return behavior remains supported. Default conflict-target inference and MySQL behavior are unchanged.

Native better-sqlite3 regression covers a nonunique namespace predicate preceding the explicit key, insert/no-op/update paths, composite namespace/external-ID identity, cross-namespace rows, and full/projected update results. All 10 Kysely tests and shared DB TypeScript build pass. PostgreSQL execution and MySQL are not independently verified here. The generic fix is a prerequisite for RecFn's real SQLite acceptance; no package release or remote push occurred.

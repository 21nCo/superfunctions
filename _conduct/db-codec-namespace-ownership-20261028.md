# DB codec ownership through namespace and transaction wrappers

The independent Claude Opus 5.5 source review identified lost codec ownership metadata on namespace wrapper objects. Confirmed locally: nesting the same JSON-text schema around a namespace wrapper stored double-encoded JSON, while reads through the same chain hid corruption. A single-codec consumer exposed the incorrect string. On shared-next, integer-boolean writes threw before reaching SQLite.

The fix explicitly inherits existing codec ownership when constructing namespace adapters, namespace transaction wrappers, memory transaction adapters, and Drizzle transaction adapters. It preserves the non-enumerable cross-package marker and WeakMap registration without copying unrelated implementation state. Existing branch-specific contracts (including dev rawSql and shared integer booleans) remain intact.

## Validation

- Node 22.13.0, one Vitest worker, file parallelism disabled.
- 5 targeted regressions: memory and native Kysely SQLite, configured and function-owned schemas, transaction predicates/writes, independent consumer reads, physical SQLite bytes. Shared additionally checks boolean integers. Drizzle transaction coverage uses a driver-bound-value fixture; no live PostgreSQL claim.
- Full DB suite: **240 passed across 22 files**.
- `npm run typecheck --workspace=@superfunctions/db`: passed.
- Shared pre-fix tests: five namespace cases failed. After namespace-only fix, additional memory/Drizzle transaction ownership regressions failed; all passed after explicit inheritance.
- Dev pre-fix memory/Drizzle cases failed as expected. Initial SQLite tests hit a pre-existing native ABI mismatch; rebuilding better-sqlite3 under Node 22 enabled the passing complete suite.

Commands: `npm test --workspace=@superfunctions/db -- --maxWorkers=1 --no-file-parallelism`; `npm run typecheck --workspace=@superfunctions/db`.

Logs: `/tmp/dev-db-namespace-full-20261028.log`, `/tmp/dev-db-namespace-typecheck-20261028.log`. No release/version reconciliation was performed; separate release and conflicting-schema questions from the review remain outside this fix.

## Independent follow-up review

A targeted read-only Claude review confirmed canonical model `claude-opus-5-5` and found no P1/P2 defect in either branch's fix. It traced all four inheritance sites to the same underlying CRUD owner and confirmed each added site is exercised by a regression. Remaining nonblocking coverage limits include namespaced rawSql transaction rollback, separately loaded module copies, and additional Drizzle/boolean transaction combinations.

Local [follow-up report](/var/folders/w5/pq_s7rfd2lq25dtwvcl84tx40000gn/T/claude-db-namespace-followup-20261028-ak88xjhl/report.md); model metadata and raw review stream are alongside it. Review was source-only and did not execute tests.

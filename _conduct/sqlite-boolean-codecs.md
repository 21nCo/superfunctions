# SQLite declared boolean codecs

Kysely SQLite now advertises that its native driver does not accept boolean bindings. Schema-owned codecs infer integer storage for declared boolean fields on such adapters; native boolean adapters retain booleans. Explicit `booleanStorageType` can override the inferred representation. Writes and filter operands (including in/not_in) encode true/false as 1/0, readback restores booleans, and null/undefined remain unchanged. Invalid integer representations fail explicitly. Existing codec ownership metadata prevents repeated conversion in nested wrappers, legacy adapterSchema configuration, and transactions.

Validation: `npm run build -w @superfunctions/db`; `npm test -w @superfunctions/db`: 22 files, 220 tests passed. The three new cases exercise actual better-sqlite3 bindings, scalar/set filters, updates and transaction readback with and without a legacy schema, nested wrappers, null, invalid inputs, and a native boolean memory adapter. RecFn's native file-backed SQLite calendar close/reopen acceptance also passes.

This does not certify other SQL providers or arbitrary driver representations. It changes only declared boolean fields; JSON and unrelated numeric values do not receive boolean conversion.

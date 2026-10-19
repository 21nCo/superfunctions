# CmsFn-owned storage schema and SQLite persistence

2026-10-19 UTC. Based on the role-boundary change and normal local merge `aa8e7c4a3` of shared DB prerequisite `d8d443a5c`. No shared package source was modified in this slice.

## Contract

Role and release storage wrap incoming adapters internally. Applications do not need to pass the deprecated `adapterSchema` option. `getCmsfnStorageSchema()` is exported by `@cmsfn/server` for schema inspection and deployment tooling; it does not automatically create tables or migrate existing databases.

The SQL schema uses TEXT columns containing JSON for `cmsfn_roles.rules` and `cmsfn_releases.docIds`. Release timestamps remain ISO strings, and `publishAt` remains nullable. Memory adapters retain native arrays, including rows created before schema ownership. Existing adapters already configured with the same JSON-text schema are supported without double serialization. The wrapper preserves the original adapter's table mapping and lifecycle; it does not close caller-owned adapters or introduce a namespace of its own.

Release lookup and document addition now predicate on both dataset and releaseId. Previously a caller could pass a releaseId from another dataset and read or modify it despite supplying the wrong dataset.

## Validation

Node 20.20.0, better-sqlite3 12.5.0 / SQLite 3.51.1, Kysely 0.28.11:

```sh
npm rebuild better-sqlite3 --no-audit --no-fund
npm run build --workspace=@superfunctions/db
npm test --workspace=./cmsfn/server
node node_modules/typescript/bin/tsc -p cmsfn/server/tsconfig.storage.json
node node_modules/typescript/bin/tsc -p cmsfn/server/tsconfig.roles.json
npm run build --workspace=./cmsfn/server
```

- Native SQLite was built and exercised, not skipped. Three focused tests pass: close/reopen persistence with ordinary and legacy-schema adapters, plus existing native memory rows.
- Disk tests use disposable directories and always close/remove fixtures. They verify nested role rules, Unicode, role updates/deletion, physical single-encoded JSON text, sorted/deduplicated document IDs, stable ISO strings across reopen, null publishAt, mapped table isolation, and cross-dataset rejection.
- Full server suite: 59 tests passed. Strict storage and role checks pass with `skipLibCheck: false`.
- ESM/CJS/declaration build passed. Node 18.18 CJS can load the server and its new schema export without requiring native SQLite; SQLite tests are development-only and ran on Node 20.
- Full server typecheck still has the same 145 diagnostics documented in the prior role-boundary evidence. This slice does not claim a full-package typecheck pass.

## Remaining original gates

Automatic schema creation/migrations, real Drizzle/Prisma/Postgres/MySQL/native-JSON-column coverage, row-level tenant adapters, concurrent role upserts and release document additions, and release scheduling are not established here. Existing native JSON SQL columns need an explicit compatibility/migration decision before deployment of the TEXT contract. Authorization/body boundaries outside role management, audit identity, studio workflows and live ContentFn integration remain open. The full packed consumer/declaration matrix and original overall CmsFn production-readiness requirements remain open.

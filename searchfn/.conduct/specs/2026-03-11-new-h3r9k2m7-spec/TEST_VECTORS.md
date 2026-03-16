# Test Vectors

## TV-PKG-001-POS

- **Description**: New package set exists and is buildable.
- **Input**:
```bash
ls searchfn | rg '^adapter-'
npm run build --workspace @searchfn/adapter-contracts
npm run build --workspace @searchfn/adapter-memory
npm run build --workspace @searchfn/adapter-indexeddb
npm run build --workspace @searchfn/adapter-postgres
npm run build --workspace @searchfn/adapter-elasticsearch
npm run build --workspace @searchfn/adapter-opensearch
npm run build --workspace @searchfn/adapter-meilisearch
```
- **Expected output**:
  - All listed package directories exist.
  - All build commands exit 0.
- **Negative variant(s)**:
  - Remove one adapter package directory; expected failure: missing workspace/package build target.

## TV-PKG-001-NEG

- **Description**: Incomplete package split is detected.
- **Input**:
```bash
rg -n '"name": "@searchfn/adapter-' searchfn/*/package.json
```
- **Expected output**:
  - Missing required package names triggers failure against required list.
- **Negative variant(s)**:
  - N/A (vector itself is negative).

## TV-PKG-002-POS

- **Description**: Contract types are consumed from contracts package.
- **Input**:
```bash
rg -n 'from "@searchfn/adapter-contracts"' searchfn/client/src searchfn/server/src searchfn/datafn-provider/src
npm run typecheck --workspace @searchfn/client
npm run typecheck --workspace @searchfn/server
npm run typecheck --workspace @searchfn/datafn-provider
```
- **Expected output**:
  - Type imports resolve from contracts package.
  - All typechecks pass.
- **Negative variant(s)**:
  - Replace one import back to legacy package; expected failure after legacy package removal.

## TV-PKG-002-NEG

- **Description**: Missing contracts dependency fails builds.
- **Input**:
  - Remove `@searchfn/adapter-contracts` from one consumer package.json; run build/typecheck.
- **Expected output**:
  - Module not found / type resolution error referencing `@searchfn/adapter-contracts`.
- **Negative variant(s)**:
  - N/A.

## TV-PKG-003-POS

- **Description**: Browser bundle avoids `pg` when using browser-safe adapters.
- **Input**:
```bash
npm run build --workspace todo-app-client
rg -n 'postgres-bytea|node_modules/pg|\bpg\b' datafn/examples/todo-app/client/dist/assets/*.js
```
- **Expected output**:
  - Client build exits 0.
  - `rg` returns no matches.
- **Negative variant(s)**:
  - Add `@searchfn/adapter-postgres` import in client; expected browser build failure or node leak detection.

## TV-PKG-003-NEG

- **Description**: Node-only adapter leak into browser is detected.
- **Input**:
  - Add `import { PostgresAdapter } from "@searchfn/adapter-postgres"` to browser entrypoint and build.
- **Expected output**:
  - Build fails or artifact inspection flags forbidden node dependency.
- **Negative variant(s)**:
  - N/A.

## TV-API-001-POS

- **Description**: Adapter behavior remains stable post-migration.
- **Input**:
```bash
npm test --workspace @searchfn/adapter-memory
npm test --workspace @searchfn/adapter-indexeddb
npm test --workspace @searchfn/adapter-postgres
```
- **Expected output**:
  - Existing behavior tests pass without changing expected assertions.
- **Negative variant(s)**:
  - Modify constructor signature of one adapter; tests/type checks fail where instantiated.

## TV-API-001-NEG

- **Description**: Constructor compatibility regression is caught.
- **Input**:
  - Change one adapter constructor parameter type and run consumer typecheck.
- **Expected output**:
  - Type errors in consumers or adapter tests.
- **Negative variant(s)**:
  - N/A.

## TV-MIG-001-POS

- **Description**: All source imports migrated.
- **Input**:
```bash
rg -n '@searchfn/adapters' --glob '**/*.ts' --glob '**/*.tsx' --glob '**/*.mts' --glob '**/*.cts'
```
- **Expected output**:
  - No matches.
- **Negative variant(s)**:
  - Reintroduce one import in a test file; grep reports match and gate fails.

## TV-MIG-001-NEG

- **Description**: Leftover legacy import blocks completion.
- **Input**:
  - Keep one `@searchfn/adapters` import and run build matrix.
- **Expected output**:
  - Module resolution failure identifies offending file.
- **Negative variant(s)**:
  - N/A.

## TV-MIG-002-POS

- **Description**: Package dependencies are accurately rewired.
- **Input**:
```bash
rg -n '"@searchfn/adapters"' --glob '**/package.json'
rg -n '"@searchfn/adapter-(contracts|memory|indexeddb|postgres|elasticsearch|opensearch|meilisearch)"' \
  searchfn/client/package.json searchfn/server/package.json searchfn/datafn-provider/package.json \
  datafn/examples/todo-app/client/package.json datafn/examples/todo-app/server/package.json recfn/server/package.json
```
- **Expected output**:
  - No `@searchfn/adapters` dependency remains.
  - Each consumer declares only required new packages.
- **Negative variant(s)**:
  - Omit declared dependency for used adapter; build fails with missing module.

## TV-MIG-002-NEG

- **Description**: Missing explicit dependency is caught.
- **Input**:
  - Remove `@searchfn/adapter-memory` from `recfn/server/package.json` and build.
- **Expected output**:
  - Build fails with missing module error.
- **Negative variant(s)**:
  - N/A.

## TV-MIG-003-POS

- **Description**: Legacy package is removed.
- **Input**:
```bash
test ! -d searchfn/adapters || exit 1
rg -n '"name": "@searchfn/adapters"' searchfn/*/package.json
```
- **Expected output**:
  - `searchfn/adapters` package directory absent or non-package.
  - No package.json declares `@searchfn/adapters`.
- **Negative variant(s)**:
  - Restore legacy package.json; migration gate fails.

## TV-MIG-003-NEG

- **Description**: Legacy package presence is blocked.
- **Input**:
  - Keep `searchfn/adapters/package.json` with old name and run release checks.
- **Expected output**:
  - Duplicate/legacy package detection failure.
- **Negative variant(s)**:
  - N/A.

## TV-DOC-001-POS

- **Description**: Docs/examples reflect new imports.
- **Input**:
```bash
rg -n '@searchfn/adapters' searchfn/docs searchfn/server/README.md datafn/examples/todo-app recfn -S
```
- **Expected output**:
  - No current usage docs/examples use old package import.
- **Negative variant(s)**:
  - Keep stale snippet; grep catches it.

## TV-DOC-001-NEG

- **Description**: Stale documentation import detected.
- **Input**:
  - Add old import snippet to README and run doc grep.
- **Expected output**:
  - Doc validation fails with matching path.
- **Negative variant(s)**:
  - N/A.

## TV-TEST-001-POS

- **Description**: Per-package tests run independently.
- **Input**:
```bash
npm test --workspace @searchfn/adapter-memory
npm test --workspace @searchfn/adapter-indexeddb
npm test --workspace @searchfn/adapter-meilisearch
```
- **Expected output**:
  - Each package test command exits 0 independently.
- **Negative variant(s)**:
  - Break cross-import to removed aggregate package; one package test fails.

## TV-TEST-001-NEG

- **Description**: Hidden coupling to removed package fails.
- **Input**:
  - Leave `@searchfn/adapters` import inside one new adapter package and run tests.
- **Expected output**:
  - Build/test failure indicates unresolved import.
- **Negative variant(s)**:
  - N/A.

## TV-TEST-002-POS

- **Description**: Full impacted workspace matrix passes.
- **Input**:
```bash
turbo run build --filter=@searchfn/adapter-contracts --filter=@searchfn/adapter-memory --filter=@searchfn/adapter-indexeddb --filter=@searchfn/adapter-postgres --filter=@searchfn/adapter-elasticsearch --filter=@searchfn/adapter-opensearch --filter=@searchfn/adapter-meilisearch --filter=@searchfn/client --filter=@searchfn/server --filter=@searchfn/datafn-provider --filter=todo-app-client --filter=todo-app-server --filter=recfn-server
```
- **Expected output**:
  - All filtered builds succeed.
- **Negative variant(s)**:
  - Keep one stale import/dependency; matrix fails.

## TV-TEST-002-NEG

- **Description**: Impacted workspace verification catches migration defects.
- **Input**:
  - Run matrix with one intentionally un-migrated consumer.
- **Expected output**:
  - Failure includes workspace name and unresolved module.
- **Negative variant(s)**:
  - N/A.

## TV-REL-001-POS

- **Description**: Breaking change metadata exists.
- **Input**:
  - Inspect release/changelog docs and changed package versions.
- **Expected output**:
  - Explicit breaking migration note and old→new mapping.
- **Negative variant(s)**:
  - Missing release note treated as release gate failure.

## TV-REL-001-NEG

- **Description**: Silent breaking release is blocked.
- **Input**:
  - Remove migration note and run release checklist.
- **Expected output**:
  - Checklist fails due to missing migration guidance.
- **Negative variant(s)**:
  - N/A.

## TV-ERR-001-POS

- **Description**: Expected migration errors are deterministic and actionable.
- **Input**:
  - Intentionally import removed package in one file and run build.
- **Expected output**:
  - Error includes missing module name and source file path.
- **Negative variant(s)**:
  - Non-actionable opaque error output fails requirement.

## TV-ERR-001-NEG

- **Description**: Tooling fails requirement when errors are non-diagnostic.
- **Input**:
  - Suppress module resolution details and rerun migration check.
- **Expected output**:
  - Requirement not met; diagnostics must include source and missing package.
- **Negative variant(s)**:
  - N/A.

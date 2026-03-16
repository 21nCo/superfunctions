# Requirements Table Of Contents

- PKG-001
- PKG-002
- PKG-003
- API-001
- MIG-001
- MIG-002
- MIG-003
- DOC-001
- TEST-001
- TEST-002
- REL-001
- ERR-001

## PKG-001

- **ID**: PKG-001
- **Priority**: P0
- **Statement**: The repository MUST split the legacy `@searchfn/adapters` package into one package per adapter and one shared contracts package.
- **Rationale**: Removes cross-adapter coupling and enables precise dependency selection.
- **Acceptance criteria**:
  - `searchfn/adapter-contracts` and six leaf adapter package directories exist.
  - Each new package has `package.json`, build config, source entrypoint, and test config.
  - No code imports from removed aggregate package path.
- **Test vectors**: TV-PKG-001-POS, TV-PKG-001-NEG
- **Notes**: Leaf package names are normative per SPEC.

## PKG-002

- **ID**: PKG-002
- **Priority**: P0
- **Statement**: Shared adapter interfaces/errors MUST live in `@searchfn/adapter-contracts` and be imported by all adapter implementations and type consumers.
- **Rationale**: Prevents type duplication and keeps contracts runtime-agnostic.
- **Acceptance criteria**:
  - `SearchAdapter` and related types are exported from contracts package.
  - `@searchfn/client`, `@searchfn/server`, and `@searchfn/datafn-provider` import type contracts from contracts package.
  - Leaf packages compile against contracts package.
- **Test vectors**: TV-PKG-002-POS, TV-PKG-002-NEG
- **Notes**: `SearchAdapterConfig` remains coupled to `@searchfn/core` `PipelineOptions`.

## PKG-003

- **ID**: PKG-003
- **Priority**: P0
- **Statement**: Browser-focused consumers MUST avoid transitive `pg` dependency unless they explicitly depend on postgres adapter package.
- **Rationale**: Prevents runtime failures like `Buffer is not defined` in browser builds.
- **Acceptance criteria**:
  - Browser consumer build (todo app client) succeeds without `@searchfn/adapter-postgres` dependency.
  - Built browser assets contain no `pg` or `postgres-bytea` imports.
  - Node consumers using postgres adapter continue to compile and test.
- **Test vectors**: TV-PKG-003-POS, TV-PKG-003-NEG
- **Notes**: This is validated via build artifact inspection and dependency graph.

## API-001

- **ID**: API-001
- **Priority**: P0
- **Statement**: Existing adapter constructor signatures and adapter runtime behavior MUST remain unchanged by the package split.
- **Rationale**: Packaging refactor must not become behavioral refactor.
- **Acceptance criteria**:
  - Existing adapter tests pass after import path changes only.
  - No public constructor parameter removals in migrated classes.
  - Contract/conformance suites pass for each adapter package.
- **Test vectors**: TV-API-001-POS, TV-API-001-NEG
- **Notes**: Option type names may move package location but shapes remain stable.

## MIG-001

- **ID**: MIG-001
- **Priority**: P0
- **Statement**: All TypeScript import statements across the monorepo MUST be migrated from `@searchfn/adapters` to new package paths.
- **Rationale**: Old path will be removed; all consumers must compile.
- **Acceptance criteria**:
  - Repository-wide search returns zero import/use references to `@searchfn/adapters` in `.ts/.tsx/.mts/.cts` and docs code blocks intended as current usage.
  - `searchfn`, `datafn`, and `recfn` known consumers compile with new imports.
  - Any leftover usage fails CI/local verification.
- **Test vectors**: TV-MIG-001-POS, TV-MIG-001-NEG
- **Notes**: Explicitly includes tests and examples.

## MIG-002

- **ID**: MIG-002
- **Priority**: P0
- **Statement**: All affected `package.json` files MUST replace `@searchfn/adapters` dependency with precise new package dependencies.
- **Rationale**: Dependency declarations must match import reality and minimize over-installation.
- **Acceptance criteria**:
  - `searchfn/client` depends on contracts + memory + indexeddb packages.
  - `searchfn/server` depends on contracts package only.
  - `searchfn/datafn-provider` depends on contracts package only.
  - `datafn` and `recfn` workspaces depend only on adapters they instantiate.
- **Test vectors**: TV-MIG-002-POS, TV-MIG-002-NEG
- **Notes**: Use workspace-local `file:` links where existing pattern requires.

## MIG-003

- **ID**: MIG-003
- **Priority**: P0
- **Statement**: The legacy `searchfn/adapters` package MUST be deleted after migration completion.
- **Rationale**: User explicitly requested no backward compatibility and allowed destructive change.
- **Acceptance criteria**:
  - `searchfn/adapters` directory no longer contributes a workspace package.
  - Root workspace install/build succeeds without that package.
  - Any attempt to import `@searchfn/adapters` fails with module resolution error.
- **Test vectors**: TV-MIG-003-POS, TV-MIG-003-NEG
- **Notes**: Directory may remain only as a non-package tombstone doc if needed, but no package.json with old name is allowed.

## DOC-001

- **ID**: DOC-001
- **Priority**: P1
- **Statement**: Documentation and examples MUST be updated to use new adapter package import paths and dependency names.
- **Rationale**: Prevents users from copying broken imports.
- **Acceptance criteria**:
  - README/docs pages and example app snippets show new package names.
  - Migration mapping section exists with old→new import/dependency examples.
  - No primary docs suggest `@searchfn/adapters`.
- **Test vectors**: TV-DOC-001-POS, TV-DOC-001-NEG
- **Notes**: Historical changelog references MAY mention old name for context.

## TEST-001

- **ID**: TEST-001
- **Priority**: P0
- **Statement**: Each new adapter package MUST include or migrate relevant test coverage from legacy package.
- **Rationale**: Split must not reduce confidence.
- **Acceptance criteria**:
  - Unit/conformance/integration tests for each adapter run from new package location.
  - Test scripts remain runnable independently.
  - Failing adapter test in one package does not require aggregate package.
- **Test vectors**: TV-TEST-001-POS, TV-TEST-001-NEG
- **Notes**: Existing integration docker-compose files may be copied or shared.

## TEST-002

- **ID**: TEST-002
- **Priority**: P0
- **Statement**: Migration verification MUST run cross-workspace build/test checks proving monorepo consistency after dependency rewiring.
- **Rationale**: Package split impacts multiple workspaces.
- **Acceptance criteria**:
  - `turbo` filtered builds pass for all directly impacted workspaces.
  - Selected test suites pass for `searchfn/client`, `searchfn/server`, `searchfn/datafn-provider`, migrated adapter packages, and consuming examples.
  - Verification output includes an import-grep check for zero legacy references.
- **Test vectors**: TV-TEST-002-POS, TV-TEST-002-NEG
- **Notes**: Full monorepo test run MAY be optional if filtered matrix is comprehensive.

## REL-001

- **ID**: REL-001
- **Priority**: P1
- **Statement**: Package versioning and release metadata MUST mark this as a breaking change and list migration instructions.
- **Rationale**: Consumers require explicit upgrade guidance.
- **Acceptance criteria**:
  - Changed package versions reflect breaking semantics per release policy.
  - Release notes/changelog section lists old→new imports.
  - Removed package is called out explicitly.
- **Test vectors**: TV-REL-001-POS, TV-REL-001-NEG
- **Notes**: If monorepo uses automated versioning, config updates must be included.

## ERR-001

- **ID**: ERR-001
- **Priority**: P1
- **Statement**: Build and migration tooling MUST surface deterministic actionable errors for unresolved legacy imports or missing new dependencies.
- **Rationale**: Fast remediation is required for a destructive migration.
- **Acceptance criteria**:
  - Legacy import produces reproducible module resolution error path.
  - Missing dependency produces reproducible install/build failure identifying missing package.
  - Project migration checklist includes these expected failures.
- **Test vectors**: TV-ERR-001-POS, TV-ERR-001-NEG
- **Notes**: Error string exact wording is tool-dependent; package path and cause are required.

# Shared integration checkpoint — 2026-10-22

Merged Shared `c0ce24b30ef7935e79a400ed27fcc8ffac1b5d42` into CmsFn response-validation checkpoint `ad740c2a2ea6d5e28face83d137eab085531ab97` as merge `25b2f19525df3dfa42d6b8b61bca4565fc56462f`. The merge required no conflict resolution or runtime changes.

Validation used Node 20.20.0. Rebuilt the changed shared `@superfunctions/observability` and `@superfunctions/db` packages before final checks. Existing native SQLite modules worked without forced rebuilds.

- `npm test -w ./cmsfn/core -w ./cmsfn/server`: 46 core and 87 server tests pass, including eight release-authorization boundary tests, roles, real SQLite storage and owned HTTP ContentFn transport fixtures.
- `npm run typecheck -w ./cmsfn/core -w ./cmsfn/server`: passes.
- `npm run build -w ./cmsfn/core -w ./cmsfn/server`: ESM/CJS/declarations pass.
- Turbo 2.6.1 `run build --dry=json`: the full workspace dependency/task graph resolves. The tracked root `turbo.json` was materialized in this sparse checkout; no configuration source changed. This is graph validation, not a full monorepo build.
- `npm ci --dry-run --ignore-scripts -w cmsfn -w @cmsfn/server --include-workspace-root=false --no-audit --no-fund`: passes without lockfile mutation. This validates lock consistency, not a fresh native installation.

An initial `-w cmsfn` command selected the whole function folder, including admin. Admin tests/build/typecheck could not resolve uninstalled `@superfunctions/admin`, `@contentfn/server` and `@contentfn/core` in this core/server-focused environment. The final commands above explicitly select core and server; no CmsFn admin validation is claimed.

Logs: `/tmp/cmsfn-shared-{graph,lock,prereq-build,tests-final,types-final,build-final}.log`. Initial broader-selection logs remain at `/tmp/cms-shared-tests.log` and `/tmp/cmsfn-shared-{types,build}.log`.

The original outstanding requirements in `release-authorization-readiness.md` and `contentfn-response-readiness.md` remain open, including other route boundaries, complete producer audit APIs, durable provider acceptance, scheduling/concurrency and studio workflows. These local integration results do not establish production readiness or deployment evidence.

# Shared integration checkpoint — 2026-10-22

Merged Shared `c0ce24b30ef7935e79a400ed27fcc8ffac1b5d42` into clean CacheFn checkpoint `9235b08e6946cea2a825078832f47f715a322d06` as merge `1c2eaa5688fa2aa8897a9c3e15454d0dbf5bbd0b`. The ordinary merge required no conflict resolution or runtime changes. Cache core has no shared runtime package dependencies; this checkpoint does not claim to exercise shared DB/provider implementations through core.

Validation on Node 20.20.0:

- `npm test -w ./cachefn/typescript`: 247 tests pass across 19 files.
- `npm run typecheck -w ./cachefn/typescript`: source and separate type-test projects pass.
- `npm run build -w ./cachefn/typescript`: ESM/CJS and both declaration formats pass.
- Turbo 2.6.1 `run build --dry=json`: the full workspace dependency/task graph resolves. The tracked root `turbo.json` was materialized in this sparse checkout; no configuration source changed. This is graph validation, not a full monorepo build.
- `npm ci --dry-run --ignore-scripts -w ./cachefn/typescript --include-workspace-root=false --no-audit --no-fund`: passes without dependency bypass flags or lockfile mutation. This validates lock consistency, not a fresh installation.

Logs: `/tmp/cache-shared-{tests,types,build,graph,lock}.log`.

No benchmark, native Safari/Firefox, Python, ecosystem-provider or deployment acceptance was run for this integration. The original performance and browser requirements retain their full scope. In particular, `native-safari-availability.md` records the host automation configuration blocker and missing native storage acceptance; Playwright WebKit is not native Safari evidence. The narrower TypeScript hit benchmark in `memoize-sync-readiness.md` does not establish full-cache miss/cleanup, arbitrary payload/key sizes, other engines or Python performance. No complete readiness claim follows from this integration checkpoint.

# BrowseFn readiness progress

Snapshot 2026-10-15. Worktree `/Volumes/Dev/n/worktrees/superfunctions/browsefn-readiness`, branch `codex/browsefn-readiness-20261015`, base `origin/dev` `5c0276d2e10d5d91472d9dde4347a651db048a62`. Source ported from local `next` `523c66ae8cf981ff8331d56386cec1f81c704182`; source was identical to `sf-next/next` for BrowseFn. Existing PR snapshot had no BrowseFn coverage. No push, PR, deployment or publication performed.

## Changes

- Ported BrowseFn TypeScript, Python, admin, documentation and gate scripts. Historical conduct completion reports omitted; retained only release-gate instructions required by the executable gate/tests.
- Added TypeScript root workspace; existing `*fn/admin` pattern covers admin. Regenerated root npm lockfile. Aligned shared dependencies with dev: HTTP/middleware 0.3.0 and admin 0.1.4.
- Corrected Python dependency from unrelated PyPI distribution `superfunctions` to `superfunctions-core` (the distribution owning the required `superfunctions.http` module). Removed accidental unrelated packages from the disposable test venv after discovery.
- Static HTML providers now resolve relative links/images and report metadata URLs against the final redirect URL. Regression tests exercise actual localhost HTTP redirects in both languages.
- Puppeteer applies `javascript: false` before navigation; Playwright passes it into context creation. Tests verify disable-before-navigation and context options.

## Verified

- `npx turbo run build --filter=browsefn...`: five package builds pass against dev shared packages.
- Existing release gate: TS build/typecheck and 55 tests pass; Python compileall and 49 tests pass.
- `npx turbo run build test typecheck --filter=@browsefn/admin`: all ten tasks pass; seven admin tests pass.
- Direct ESM import and CJS require of built BrowseFn expose `browseFn`.
- npm tarballs generated for BrowseFn/admin; Python wheel built. These are artifact-generation checks, not isolated installed-consumer acceptance.
- Python runtime: dedicated `/tmp/sf-browsefn-py312`, Python 3.12. Node 20.20.0/npm 10.8.2. Root install emits Node >=22 warnings for unrelated dev/review packages; resolve/use repo-required runtime before broad CI.
- Full release command: `PATH=/tmp/sf-browsefn-py312/bin:$PATH node browsefn/scripts/verify-release.mjs`. Log `/tmp/sf-browsefn-release-gate.log`. **Fails duplication gate:** jscpd 5.4.1 reports 5.4270127915726105%, 577 duplicate lines / 46 clones, threshold 5%. Do not claim release readiness. Admin log `/tmp/sf-browsefn-admin-gate.log`.

## Remaining gates and concrete gaps

1. Reduce actual duplication or establish a justified consistent scanner configuration; do not loosen threshold simply to pass. Current checker invokes unpinned jscpd; pin reproducible tooling. Largest repeated areas: browser provider lifecycle wrappers, Python Mapbox/Nominatim request/result conversion, image provider imports, TS geocoder result conversion.
2. Both CacheManagers accept `indexeddb`, `file`, and `database` configuration yet always store in memory (`typescript/src/core/cache-manager.ts`, `python/browsefn/core/cache_manager.py`). Implement promised storage with shared abstractions; preserving the option alone is not readiness. Review TTL validation, replacement-at-capacity and cache isolation.
3. Browser providers advertise proxy capability but do not apply `options.proxy` to browser launches. Actual Playwright/Puppeteer runtime acceptance and failure/cleanup tests remain. Their final redirect URL handling also needs checking beyond the repaired static providers.
4. Python Nominatim search radius currently computes longitude offset by dividing by absolute latitude (`python/browsefn/geo/providers/nominatim.py`), failing at the equator and yielding wrong bounds elsewhere. Implement validated latitude-aware bounds with polar/antimeridian handling and tests.
5. Image download private-host protection only inspects literal host text. Verify DNS resolution/rebinding, IPv6, redirects, byte limits and destination ownership against the advertised security contract. Validate any exposed router with real shared HTTP adapters and authorization policy.
6. Isolated TS/Python installed-consumer tests, browser acceptance, provider request/response contracts, CI integration and dependency-audit triage remain. Root npm resolution reports existing and introduced vulnerabilities together; classify by actual dependency graph before remediation.
7. Inspect full SPEC/README promises against implementations, including Python differences. Existing gate only verifies a subset and currently fails. Prepare scoped PR only when remaining requirements are implemented and validated.

Full objective remains active. BrowseFn is not production-ready yet.

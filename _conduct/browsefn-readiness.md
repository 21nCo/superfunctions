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

## Persistent backend and browser/geocoder checkpoint

The previous duplication failure and memory-only storage findings are now fixed.
Full current release gate passes: 92 TypeScript tests/build/typecheck, 69 Python
3.12 tests, duplication 4.938383% under unchanged 5% threshold. Python3.10 full
suite also passes 69 tests. Native Chrome IndexedDB acceptance and real Drizzle
and SQLAlchemy SQLite persistence pass. Detailed limitations and schema/bridge
requirements are in browsefn/.conduct/cache-backends.md.

Browser providers now await extraction before cleanup, preserve primary errors,
apply proxy settings, and report final redirected URLs. Browser wrapper defaults
retain the browser sandbox. Nominatim bounds/components now work in both languages,
including polar/antimeridian cases. Local Chromium browser and mocked provider
contract evidence is in browsefn/.conduct/browser-geo-acceptance.md.

Still open: image-download security, packaged consumers, provider contract sweep,
dependency audit, reproducible scanner pinning, CI and remaining specification
requirements. Passing this gate does not close these wider requirements.

## 0.2 requirement and installed-consumer checkpoint (2026-10-15)

Completed the previously open image-security/transform and runtime-contract work. Image transfer validates DNS in the connecting lookup, rejects private/reserved addresses and redirects, bounds bytes/deadlines, and publishes files without accidental overwrite. Both SDKs perform decoded resize/crop/format/quality/watermarks and provider-size URL selection; prior detailed evidence remains in image-download-security.md and image-transformations.md.

This checkpoint fixes aggregate cross-provider quotas, status-aware retries, per-call retry overrides, configured fallbackOnErrors, Python request identity/TTL, structured Markdown, all matching selectors, and scope-aware Python cookies. Firecrawl and Jina now use their documented JSON protocols, preserve target authentication separately, return actual HTML and securely downloaded screenshots, and reject vendor-inexpressible lifecycle/proxy combinations. Cheerio's advertised proxy transport now works through a real CONNECT proxy. Deterministic web.userAgents rotation is implemented and tested through target HTTP requests in both SDKs.

Credential tests scan actual persistent cache files and SDK logs. Default option keys are SHA-256 fingerprints; credential-bearing URLs bypass caching. Known API/header/cookie credentials are redacted even when a provider echoes them in an error. Request-specific redaction secrets are released after completion, including cache-hit/error paths; provider config remains in process memory. Cached response contents remain plaintext and may themselves be sensitive. BrowseFn is not a credential vault; documented SecFn composition uses the existing encrypted server/runtime capability. Clear legacy caches whose old keys could contain credentials.

Version and publication requirements: TypeScript/Python/admin align at 0.2.0. Node >=20.19.0 and Python >=3.10 are explicit minimums. Shared @superfunctions/http 0.3.1 adds a router-only export and must be published first; middleware loads lazily so synchronous CJS router construction remains supported. Sharp ^0.35.5 removes the vulnerable image-library release. Turndown 7.2.4 supplies structural Markdown; Undici 6.29 supplies proxy transport; @noble/hashes 1.8 supplies synchronous SHA-256 in Node and browsers without breaking memory has(). The duplication scanner is now pinned to the measured jscpd5.4.1.

Validation of current source:

- Full source gate: build, typecheck, 130 TypeScript tests, 94 Python3.12 tests; duplicated lines527 / 4.738782% (unchanged maximum5%). Final log `/tmp/sf-browse-complete-gate.log`.
- Python3.10:94 tests pass (`/tmp/sf-browse-complete-py310.log`). Shared-core emits18 existing Pydantic deprecation warnings; no new failures.
- Admin typecheck/build and7 tests pass at0.2.0.
- Native Chrome154.0.8037.58 IndexedDB:20 concurrent writes, reopen, binary, rollback and namespace isolation pass (`/tmp/sf-browse-security-browser.log`). Browser SHA-256 path is included.
- Fresh production-only npm install from seven local tarballs (BrowseFn plus shared HTTP/middleware/db/storage/storage-local/observability), not workspace hoisting: ESM real HTTP+router and CJS synchronous Browse/shared router+lazy rate limiter pass on exact Node20.19.0. NodeNext declaration consumer passes. Fresh npm audit runtime graph has0 vulnerabilities (`/tmp/sf-browse-complete-pack.log`; consumer path in `/tmp/sf-browse-patched-consumer`). This does not claim the whole monorepo is vulnerability-free.
- Fresh Python3.12 venv installed built BrowseFn0.2.0 and shared-core wheels plus declared dependencies; actual localhost Markdown scraping and router construction pass (`/tmp/sf-browse-complete-wheel.log`). No editable checkout imports.
- Meaningful regressions include real HTTP503/404/retry counts, stalled remote timeout, actual CONNECT proxy, cross-credential persistent cache isolation/TTL, persisted-secret scans, upstream error redaction, concurrent aggregate quotas, native database/cache operations, decoded screenshots, and documented remote protocol fixtures.

External gates remain publication of the shared prerequisite, hosted CI, deployment/router authorization, and optional paid-provider acceptance under actual account entitlement. No paid remote requests, package publication, push or deployment occurred. The original gate flag alone is not a claim that these external gates ran. Provider-specific limitations and source links are in provider-contracts.md; runtime migration and credential-storage notes are linked from package READMEs.

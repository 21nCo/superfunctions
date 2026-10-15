# Next functions production readiness

Scope: every function on local `next` absent from remote `dev` and existing open PRs. PR presence excludes already-covered work but is not production-readiness evidence.

Snapshot: 2026-10-15; GitHub account `thyaravind`, repository `21nCo/superfunctions`.

- `next`: `523c66ae8cf981ff8331d56386cec1f81c704182`
- `origin/dev`: `5c0276d2e10d5d91472d9dde4347a651db048a62`
- `sf-next/next`: `b21477fc9a32ae425c38a2de810b5a8705fc711f`

Local next is 124 commits behind upstream. Check upstream changes for each selected function before porting.

| Function | Status |
| --- | --- |
| browsefn | Ported in codex/browsefn-readiness-20261015; release gate and implementation gaps remain |
| cachefn | In progress in codex/next-functions-readiness-20261015 |
| catchfn | Pending readiness assessment and port |
| chartfn | Ported in codex/chartfn-readiness-20261015; integrated vendor checks pass, framework runtime matrix in progress |
| cifn | Pending readiness assessment and port |
| cmsfn | Pending readiness assessment and port |
| compfn | Pending readiness assessment and port |
| contentfn | Pending readiness assessment and port |
| docsfn | Existing PR 133 |
| drawfn | Pending readiness assessment and port |
| flowfn | Pending readiness assessment and port |
| iconfn | Pending readiness assessment and port |
| logfn | Pending readiness assessment and port |
| probefn | Pending readiness assessment and port |
| recfn | Pending readiness assessment and port |
| testfn | Pending readiness assessment and port |
| userfn | Pending readiness assessment and port |
| watchfn | Pending readiness assessment and port |

## Completion gates

For each uncovered function: inspect specifications and both language implementations; identify missing implementation; preserve supported capabilities; port shared dependencies without duplicating them; integrate workspaces and CI; validate build, type checking, meaningful behavior tests, packaged consumers, and any required runtime acceptance. Prepare a scoped PR with accurate validation limits. No function is complete solely because it exists or its unit tests pass.

## CacheFn in progress

Ported source into an isolated worktree based on origin/dev. No differences between local and upstream next for cachefn. Assessment found namespace isolation defects in IndexedDB-backed bulk operations and pattern invalidation, plus unfinished synchronous memoization and IndexedDB transaction/error handling. These must be resolved before readiness.

### Current verified progress

- Versioned namespace key encoding isolates default, overlapping, and named namespaces. Legacy IndexedDB entries become cold cache; migration documented.
- IndexedDB operations settle on transaction completion and propagate errors/aborts. Expiration and tag metadata are consistent. `touch` no longer overwrites concurrent mutations.
- Memory capacity, concurrent writes, expired-entry reclamation and metadata isolation hardened.
- TS/Python memoization now handles TTL/LRU, undefined/None values, statistics, shared pending computations and stale-fill prevention. Async TS return types have compiler-checked consumer fixtures.
- Typed default memoization keys avoid JSON aliases and short-hash collisions. Serialization and event delivery corrected with dedicated tests.
- HTTP middleware preserves status/headers/body and respects Vary, authentication/private-response bypass and errors. Actual Express 4.21.2, Hono 4.11.9 and Fastify 5.6.1 tests pass.
- Latest integrated validation: 140 TS core tests, 8 admin tests, 55 Python 3.12 tests (52 pass/3 eager-factory skips on Python 3.10); TypeScript source/type-consumer checks and both core/admin builds pass; Python mypy (16 source files) and Ruff pass.
- Chrome 154 acceptance: 13 assertions pass. Reproducible script: `cachefn/typescript/scripts/browser-acceptance.mjs`; supports PLAYWRIGHT_MODULE_PATH and BROWSER_EXECUTABLE_PATH overrides.
- Python wheel/sdist rebuilt with py.typed and consistent 0.0.1 metadata; installed-wheel consumers pass on Python 3.10/3.12 and strict mypy consumes the package types. Final TS ESM/CJS tarball consumers pass on Node 20.20.0 and 22.22.1.
- Root workspace and lockfile integrated; scoped npm install passed. Admin targets current dev @superfunctions/admin 0.1.4, tests and build pass. CI discovery includes both TS packages and Python.

### Remaining CacheFn gates

1. Independently inspect the final implementation against the V0/public package contract, including mutation interleavings and middleware ordering/streaming/proxy/compression. Current tests do not prove the entire feature surface.
2. Recheck final packaged TS/Python consumers and supported runtime versions. Root install emits existing Node >=22 requirements while current shell is Node 20.20.0; validate appropriate runtime matrix.
3. Triage dependency advisories against origin/dev baseline; full workspace audit reports 119 advisories, not attributable to this port without comparison. Do not claim dependency readiness yet.
4. Reconcile package docs/spec/version/migration claims and remove inherited historical completion claims. Python currently supports memory storage; distinguish committed V0 requirements from future roadmap using source evidence.
5. Verify CI selection/execution and prepare a scoped CacheFn PR after readiness gates pass. Continue remaining functions in `_conduct/remaining-functions-assessment.md`; newly created PRs do not exclude this goal's unfinished work.

The full goal remains active. Nothing has been published, deployed, or declared production-ready.

### Additional verified work

- Python eager-task-factory fetch success, failure retry and invalidation fixed; guarded tests cover Python 3.12 while 3.10 skips that unavailable API.
- Express compression caching retains plaintext internally and reapplies the pipeline on hits; actual gzip regression confirms origin executes once. Failed If-Match/If-Unmodified-Since preconditions reach origin and retain 412 responses.
- Memoization key errors reject through the promised asynchronous API.
- Framework dev dependencies updated to Express 4.22.3, Fastify 5.12.7, Hono 4.13.13 and compression 1.8.2. Both CacheFn packages use Vitest/UI 4.1.11. npm 10's installed-tree resolution crashed; a clean manifests-only npm 10 calculation resolved the upgrade with only five version changes, all inside CacheFn. npm 11's broad lock rewrite was discarded.
- Baseline origin/dev full audit reports 119 advisories. Patched scoped audit still reports inherited/shared advisories, including root fast-uri 3.1.5 override and admin MCP SDK dependencies. These are unresolved dependency gates, not proven new regressions or a clean audit.
- CI planner selects @cachefn/core, @cachefn/admin and Python cachefn; root lockfile/workspace changes select full JS CI. Hosted CI has not run.
- BrowseFn port checkpoint: accb1d6aaa2afadba062364d19f7ac41b8cf15f3 in /Volumes/Dev/n/worktrees/superfunctions/browsefn-readiness. 55 TS, 49 Python and 7 admin tests pass. Full gate fails duplication 5.427% versus 5%; cache storage options and other runtime gaps remain documented in that worktree's _conduct/browsefn-readiness.md.

- Exact regenerated lock verified with real scoped `npm ci --ignore-scripts` (469 packages), then 140 core tests, 5 admin tests and core source/type-fixture checking passed.

### Schema contracts and shared runtime dependencies

- Schema-aware factory now preserves key/value correlation in single writes,
  fetchers and batch operations; compiler fixtures reject unknown keys and
  mismatched values. Direct generic CacheFn and untyped factory remain supported.
- CacheFn admin tests now exercise the real shared dispatcher authorization,
  input validation, confirmation, required audit and redaction boundaries.
  Current checks: 140 core, 8 CacheFn admin, 109 shared admin tests; source and
  consumer fixture typechecks and builds pass.
- Shared MCP SDK updated to 1.32.1 and fast-uri to 3.1.8, with Ajv minimum 8.18.
  Patched URI parsing required a JSON Pointer fragment adapter for encoded slash
  references. Authority parsing stays with fast-uri; 259 MCP tests pass,
  including encoded separator, literal percent, Unicode and authority cases.
- A clean scoped npm ci installed 496 packages from the regenerated npm 10
  lockfile. Existing lock changes are limited to MCP SDK and fast-uri versions
  plus MCP's Ajv minimum. Packed runtime graph audit is still pending.
- Public examples and runtime/version statements corrected; original V0 automatic
  fallback and adaptive memory remain explicitly unimplemented design items.
  See cachefn-contract-audit.md for current package behavior and limitations.


### Current scope correction and further checkpoints

Current-contract documentation is not a waiver of original V0 in-scope promises.
CacheFn automatic storage fallback, adaptive memory eviction and offline-first
fallback/queue/sync/refresh remain implementation requirements; automatic fallback
is underway. Firefox/Safari, quota and performance evidence remain open.
Memory tag consistency and eviction callback reentrancy defects fixed in44c5edad4;
144 core tests and typechecks pass. Packed declarations fixed in27d60b25f with
TS5.4/5.9 Node16/NodeNext acceptance and runtime audit zero advisories.

BrowseFn persistent caches/browser/geocoder checkpoint committed3d7ff011f;
92 TS and69 Python tests, native Chrome and real SQLite persistence passed.
Image-download security work continues.

ChartFn isolated branch codex/chartfn-readiness-20261015 ports all3 packages.
Core51/React3/Svelte2 tests, builds/types and149 native Chrome vendor assertions
pass after runtime ECharts upgrade6.1.0. Packed imports/declarations/SSR pass and
isolated runtime audit reports zero advisories. Real framework version matrix
remains active. No PR, publication or deployment claimed for these checkpoints.

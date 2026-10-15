# Next functions production readiness

Scope: every function on local `next` absent from remote `dev` and existing open PRs. PR presence excludes already-covered work but is not production-readiness evidence.

Snapshot: 2026-10-15; GitHub account `thyaravind`, repository `21nCo/superfunctions`.

- `next`: `523c66ae8cf981ff8331d56386cec1f81c704182`
- `origin/dev`: `5c0276d2e10d5d91472d9dde4347a651db048a62`
- `sf-next/next`: `b21477fc9a32ae425c38a2de810b5a8705fc711f`

Local next is 124 commits behind upstream. Check upstream changes for each selected function before porting.

| Function | Status |
| --- | --- |
| browsefn | Pending readiness assessment and port |
| cachefn | In progress in codex/next-functions-readiness-20261015 |
| catchfn | Pending readiness assessment and port |
| chartfn | Pending readiness assessment and port |
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
- Latest integrated validation: 136 TS core tests, 5 admin tests, 52 Python tests; TypeScript source/type-consumer checks and both core/admin builds pass; Python mypy (16 source files) and Ruff pass.
- Chrome 154 acceptance: 13 assertions pass. Reproducible script: `cachefn/typescript/scripts/browser-acceptance.mjs`; supports PLAYWRIGHT_MODULE_PATH and BROWSER_EXECUTABLE_PATH overrides.
- Python wheel/sdist built and fresh-wheel consumer checked. TS ESM/CJS packaged consumers passed before the final serializer/middleware additions; rerun final tarball consumers before readiness.
- Root workspace and lockfile integrated; scoped npm install passed. Admin targets current dev @superfunctions/admin 0.1.4, tests and build pass. CI discovery includes both TS packages and Python.

### Remaining CacheFn gates

1. Independently inspect the final implementation against the V0/public package contract, including mutation interleavings and middleware ordering/streaming/proxy/compression. Current tests do not prove the entire feature surface.
2. Recheck final packaged TS/Python consumers and supported runtime versions. Root install emits existing Node >=22 requirements while current shell is Node 20.20.0; validate appropriate runtime matrix.
3. Triage dependency advisories against origin/dev baseline; full workspace audit reports 119 advisories, not attributable to this port without comparison. Do not claim dependency readiness yet.
4. Reconcile package docs/spec/version/migration claims and remove inherited historical completion claims. Python currently supports memory storage; distinguish committed V0 requirements from future roadmap using source evidence.
5. Verify CI selection/execution and prepare a scoped CacheFn PR after readiness gates pass. Continue remaining functions in `_conduct/remaining-functions-assessment.md`; newly created PRs do not exclude this goal's unfinished work.

The full goal remains active. Nothing has been published, deployed, or declared production-ready.

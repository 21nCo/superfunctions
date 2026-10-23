# ContentFn next-target readiness

Target stack: `sf-next/next` b21477fc9 → shared prerequisites988fba320 → shared follow-up0ef7b9cb6 → this ContentFn branch. Source implementation:367b6ee93,62d9bef54,f287d3a59; evidence follow-upf06f37d45. Only ContentFn changes and its regenerated target lock are added above the shared branch. Historical .conduct requirements/specifications remain present; the public SPEC.md is also included.

## Clean target installation

Standard npm11.21 lock generation followed by default npm10.8.2 `npm ci` on Node22 installed588 packages without force, legacy-peer-deps, nested strategy or symlinked external installs. Selected workspaces were all five ContentFn packages plus DB, HTTP, admin, MCP core, storage, storage-local and the four Markdown runtime packages. DB0.4.0, HTTP0.3.1, admin0.1.5, MCP0.0.6, storage-local0.2.0 and ContentFn server0.2.0 resolved to this worktree's own workspace directories.

The initial legacy SecFn peer conflict was fixed in the shared branch by making MemoryFn's unused integration peer optional and removing stale optional lock nodes before ordinary regeneration. No compatibility range was falsely widened. A target-only client Vitest configuration prevents inheritance of unrelated root workspace test projects.

## Current target evidence

- All five ContentFn packages and their shared runtime dependencies built successfully; all five ContentFn strict typechecks passed.
- Core21, server191, client4, CLI7 and admin1 tests passed (224 total). Server tests include actual SQLite, PostgreSQL17 and MySQL8.4.11 services; real SQL tests cover Unicode documents above120KiB, unrestricted long IDs, exact case/accent/space identities, isolated patch/delete, publication/revision conflicts, rollback, concurrent CAS, durable HTTP idempotency, history/export/query and cleanup.
- Both disposable PostgreSQL/MySQL containers were removed, and docker readback found none.
- Fresh isolated tarball consumers passed exact Node20.19 ESM/CJS, real HTTP/CLI, query subscription/getSchema and strict NodeNext declaration checks. Independent core/server and admin consumers had zero production audit vulnerabilities.
- Separate exact Node18.18 consumer passed core/client ESM/CJS plus CLI version. No Node18 server support is claimed.
- Native Chrome passed CRUD, SSE presence/change, query snapshot and deletion refresh, cancellation and zero remaining connections against the target build.

Reproducible helpers are `packed-acceptance.py`, `packed-runtime.mjs` and `browser-acceptance.mjs` in this directory. Build packages first. Browser acceptance uses an installed Playwright package (or PLAYWRIGHT_MODULE path) and Chrome (CHROME_EXECUTABLE overrides the macOS default). The opt-in SQL suite documents its disposable database URLs and driver root in its source; it skips service tests unless URLs are provided.

## Release boundary

This is a draft stacked on shared PR55, not a deployment or publication. Shared prerequisites must land and be released before these package versions can be published. Existing database installations need the documented physical identity/schema migration. MySQL requires LONGTEXT for unrestricted JSON-text values/public strings or a matching native JSON codec. The live SQL matrix proves the default JSON-text Kysely path; it does not establish every adapter/driver combination. Historical performance or service-level claims are not inferred from these tests.

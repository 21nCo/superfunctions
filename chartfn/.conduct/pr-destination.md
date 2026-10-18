# Target branch validation

The branch starts at sf-next/next b21477fc9 and carries the ChartFn implementation from e1ed8a7c1. It replaces origin draft242 with sf-next PR50. Historical specifications/artifacts are retained; unrelated origin history is excluded.

## 2026-10-18 clean target checks

Root lockfile regenerated with npm11.21.0 after npm10.8.2 retained stale extraneous ChartFn metadata. Current core/React/Svelte workspace entries now match version0.0.3 and Vitest4.1.11. The generated lock includes five transitive upgrades and removes ten obsolete extraneous workspace records; no existing version is downgraded.

- Clean scoped npm11 ci installed458 packages on Node20.20.0; npm10.8.2 clean scoped ci also passed (458 packages).
- Tests:55core,3React,3Svelte passed with Vitest4.1.11.
- All three builds/typechecks passed; Svelte0errors/0warnings.
- Actual Chrome154:149vendor assertions, no page errors. Browser automation driver was supplied from an existing install; product/vendor dependencies came from the clean target installation.
- Fresh packed framework consumers:React16.8.6/16.14.0/18.3.1/19.3.1 and Svelte5.57.2 lifecycle checks passed, no page errors.
- Fresh packed ESM/CJS imports, React/Svelte SSR, strict Node16/NodeNext declaration consumers passed. Production dependency audit:0advisories.

Initial hosted JavaScript job39135564825 failed npm ci because the previous root lock was stale. Hosted checks must run on this corrected lock before merge; local checks do not establish hosted success. No deployment/publication or overall production-readiness completion is claimed.

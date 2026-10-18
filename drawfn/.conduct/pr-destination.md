# Target branch validation

This branch starts at sf-next/next b21477fc9 and applies DrawFn changes from 411ee9448. It replaces origin draft243 with sf-next PR51; unrelated origin history is excluded and historical artifacts retained.

## 2026-10-18 clean target checks

Root lock regenerated with npm11.21.0 against all350 tracked package manifests (sparse checkout initially omitted unrelated manifests; its first generated lock was discarded before regeneration). Clean scoped npm10.8.2 ci on Node20.20.0 installed454 packages. Generated lock changes include24 existing dependency upgrades,11 stale extraneous workspace records removed, and no existing version downgrades.

- Core58, React5 and Svelte6 tests passed with Vitest4.1.11.
- All builds and typechecks passed; Svelte reported0errors/0warnings.
- Chrome154 real canvas/example:47assertions, no page errors.
- Fresh packed React18.3.1/19.3.1 and Svelte5.57.2 consumers:36lifecycle assertions, no page errors.
- Packed strict Node16/NodeNext declarations, ESM/CJS imports, React/Svelte SSR passed on Node18.18.0/20.20.2/22.23.3.
- Isolated packed production audit:0advisories,29production dependencies.

Browser automation used an existing Playwright driver path; product dependencies came from the clean target installation or fresh packed consumers. Artifacts are included, root .gitignore unchanged. Hosted checks on this corrected lock and final contract verification remain outstanding; no release/deployment or whole-goal completion is claimed.

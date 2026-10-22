# React consumers and prerequisite integration — 2026-10-22

`CatchFnReporterButton` now explicitly returns the public `ReactElement` type.
Its previous inferred declaration embedded React18's detailed DOM attributes and
failed strict React19 consumers with TS2344 (`onChange` handler incompatibility).
The annotation preserves runtime behavior and public button props; no casts or
checker exclusions are added.

The existing packed status fixture accepts `CATCHFN_REACT_MAJOR=18|19` and now
checks actual React SSR as well as ESM/CommonJS Watch status reads and strict
Node16/NodeNext declarations. Both fresh installations pass (React18.3.1 and19.3.1).
Run `node catchfn/typescript/scripts/packed-status-acceptance.mjs` with the selected
major after building its documented packages; `NPM_CLI` can select an npm11 CLI.
The React19 declaration failure was reproduced before the annotation.

Ordinary merges retain Catch's implementation while incorporating Watch's public
alert manager and Shared prerequisites through `c0ce24b30`. Normal scoped npm11
lock regeneration adds only four nested React18 development runtime/type entries,
required alongside Shared's root React19 toolchain. Scoped `npm ci --dry-run`
passes without peer bypass flags; existing native bindings were preserved.

Validation: all107 SDK tests and4 service tests, SDK/service typechecks and builds
pass. Native Catch→Watch HTTP/SQLite reopen and the service's TypeScript/Python
SQLite interoperability fixture pass. Catch's sparse checkout lacks optional
Watch framework adapter build dependencies, so the existing `CATCHFN_WATCH_CORE`
fixture option selects the independently built, identical Watch source from its
checkout; source equality was checked. Fresh packed browser/Catch consumers pass.
Logs: `/tmp/catch-merge-*.log`. Native/browser fixtures close their owned resources.

These are local integration and consumer receipts. They do not prove a whole-root
installation, every framework version, production deployment, or the original
remaining Catch readiness requirements.

# Architecture sketch

- `plugfn/typescript/src/providers/linear/*` gains additional actions and verified webhook triggers for Conduct-compatible Linear workflows.
- `plugfn/typescript/src/providers/github/*` gains issue update/read plus PR/review capabilities and comment/closure triggers.
- `plugfn/typescript/src/providers/clickup/*` is added as a new provider package/module following existing provider patterns.
- `clifn/core/*` (or equivalent convention-compliant package path) provides credentials, config, HTTP client, UI, stdio, and prompt primitives.
- Ready shared packages are exercised through Conduct dependency harnesses rather than modified by default.
- `@superfunctions/cli` either grows the missing schema generation support or is paired with a documented/tested direct Drizzle fallback path.

# Dependency graph

1. Workspace/package placement decisions and shared dependency contracts
2. `clifn` package
3. PlugFn Linear provider additions
4. PlugFn GitHub provider additions
5. PlugFn ClickUp provider
6. Dependency harnesses, schema support path, docs, and release readiness

# Phases overview

| Phase | Goal | Delivered capability | Verification method |
|---|---|---|---|
| 00 | Lock down package placement and dependency contracts | workspace plan, public API contracts, no-duplication rules | workspace review + build graph check |
| 01 | Build `clifn` | reusable CLI runtime package | package tests + consumer import checks |
| 02 | Extend Linear provider | Conduct-ready Linear actions and triggers | provider unit/webhook tests |
| 03 | Extend GitHub provider | Conduct-ready GitHub actions and triggers | provider unit/webhook tests |
| 04 | Add ClickUp provider and validate Slack/ready packages | first-class ClickUp plus compatibility matrix | provider tests + dependency harnesses |
| 05 | Finalize schema support, docs, and release readiness | schema fallback/codegen support, examples, docs, release notes | full dependency matrix pass |

# Definition of Done (global)

No phase is complete unless its verification steps pass.


# PLAN: Generic Namespace Isolation

## Architecture Sketch

```
@datafn/core          ← ns() helper, DatafnSchema.namespaced type, defineSchema() update
    ↑
@datafn/server        ← namespaceProvider config, extractNamespace refactor, actorId, deprecation bridge
    ↑
@datafn/client        ← namespace config, storage factory, switchContext, currentNamespace, re-exports
    ↑
@datafn/cli           ← codegen checks namespaced (with multiTenant fallback)
```

`@superfunctions/auth` — **NOT modified**. datafn stops importing `AuthContext` for namespace purposes.
`@superfunctions/db`  — **NOT modified**. `RowLevelNamespaceConfig` and `wrapWithRowLevelNamespace` are generic.

## Dependency Graph

1. **@datafn/core** must be updated first (types + `ns()` helper). All other packages depend on it.
2. **@datafn/server** depends on core types. Can be done after Phase 0.
3. **@datafn/client** depends on core types. Can be done in parallel with server.
4. **@datafn/cli** depends on core types. Can be done in parallel with server/client.
5. **Tests and examples** depend on all packages.

## Phases Overview

| Phase | Goal | Delivered Capability | Verification |
|---|---|---|---|
| 0 | Core types + `ns()` helper | `ns()` exported, `DatafnSchema.namespaced` type, `defineSchema()` updated | Unit tests for `ns()`, type compilation |
| 1 | Server `namespaceProvider` + legacy bridge | Server accepts `namespaceProvider`, backward compat via `authContextProvider` | Existing server tests pass, new namespace provider tests pass |
| 2 | Client `namespace` config + storage factory | Client accepts `namespace`, factory signature, `createForNamespace`, `currentNamespace()` | Client unit tests, switchContext tests |
| 3 | CLI codegen + deprecation warnings + examples | CLI respects `namespaced`, deprecation warnings emitted, todo-app example updated | Codegen tests, example builds |
| 4 | Integration + cleanup | Full stack integration verified, all tests green | Full test suite, example app runs end-to-end |

## Definition of Done (Global)

No phase is complete unless:
1. All verification steps for that phase pass.
2. No existing tests are broken.
3. TypeScript compilation succeeds across all packages.
4. Deprecated APIs still work identically to their pre-change behavior.

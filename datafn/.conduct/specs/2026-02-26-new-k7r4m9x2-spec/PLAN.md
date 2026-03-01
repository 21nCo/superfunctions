# PLAN: Row-Level Namespace Isolation

## Architecture Sketch

```
┌─────────────────────────────────────────────────────┐
│  datafn server (createDatafnServer)                 │
│  ┌───────────────────────────────────────────────┐  │
│  │ extractNamespace(ctx) → "user:alice"          │  │
│  │ Passes namespace to every db.* call           │  │
│  └───────────────────────────────────────────────┘  │
│        │                                             │
│        ▼                                             │
│  ┌───────────────────────────────────────────────┐  │
│  │ wrapWithRowLevelNamespace(adapter, config)    │  │ ← NEW
│  │ • Intercepts all CRUD methods                 │  │
│  │ • Injects __ns WHERE on reads                 │  │
│  │ • Stamps __ns on creates                      │  │
│  │ • Strips __ns from outputs                    │  │
│  │ • Enforces mandatory namespace                │  │
│  │ • Passes through db.internal unchanged        │  │
│  └───────────────────────────────────────────────┘  │
│        │                                             │
│        ▼                                             │
│  ┌───────────────────────────────────────────────┐  │
│  │ @superfunctions/db Adapter (Drizzle/Memory)   │  │
│  │ • Executes queries with __ns in WHERE/data    │  │
│  │ • No adapter-specific changes needed          │  │
│  └───────────────────────────────────────────────┘  │
│        │                                             │
│        ▼                                             │
│  ┌───────────────────────────────────────────────┐  │
│  │ Database (Postgres/SQLite/MySQL)              │  │
│  │ • Tables have __ns TEXT NOT NULL column        │  │
│  │ • Index on __ns per table                     │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Modules and Responsibilities

1. **`packages/db/src/adapter/types.ts`** — Type extension for `rowLevelNamespace` config.
2. **`packages/db/src/adapter/row-level-namespace.ts`** — NEW. Standalone wrapper function `wrapWithRowLevelNamespace(adapter, config)`. Intercepts CRUD, injects/strips `__ns`.
3. **`packages/db/src/testing/namespace-contract-tests.ts`** — NEW. Reusable contract test suite.
4. **`packages/db/src/adapters/memory/index.ts`** — No changes needed (factory wrapper handles it).
5. **`datafn/server/src/server.ts`** — Auto-wrap adapter when `authContextProvider` is present.
6. **`datafn/core/src/schema.ts`** — Add `multiTenant` field to `DatafnSchema`.
7. **`datafn/cli/src/drizzle-codegen.ts`** — Generate `__ns` column + index when multiTenant.
8. **`datafn/server/__tests__/namespace-isolation.test.ts`** — Extend with data-level isolation tests.

## Dependency Graph

```
PHASE_00: Types + wrapper function (packages/db)
    │
    ├── PHASE_01: Contract tests + memory adapter verification (packages/db)
    │
    ├── PHASE_02: datafn server auto-wrapping (datafn/server)
    │       │
    │       └── PHASE_03: datafn server integration tests (clone, query, mutation, push)
    │
    ├── PHASE_04: Schema flag + codegen (datafn/core + datafn/cli)
    │
    └── PHASE_05: Migration guidance + Drizzle adapter integration test
```

## Phases Overview

- **Phase 0** → `@superfunctions/db` type extension + `wrapWithRowLevelNamespace` function → verified by unit tests
- **Phase 1** → Contract test suite + memory adapter verification → verified by running contract tests
- **Phase 2** → datafn server auto-wrap logic in `createDatafnServer` → verified by unit test
- **Phase 3** → End-to-end datafn server tests (clone, query, mutation, push with namespace isolation) → verified by integration tests
- **Phase 4** → `multiTenant` schema flag + Drizzle codegen `__ns` column/index generation → verified by codegen tests
- **Phase 5** → Drizzle adapter integration test + migration documentation → verified by SQLite end-to-end test

## Definition of Done (Global)

No phase is complete unless its verification steps pass. All existing tests MUST continue to pass after each phase (backward compatibility).

# PLAN: Schema Capabilities Implementation

## Architecture Sketch

```
@datafn/core (shared types + resolution)
├── types.ts              → CapabilityEntry, SchemaCapabilities, ResourceCapabilities types
├── capabilities.ts       → resolveCapabilities(), getCapabilityFields(), CAPABILITY_FIELD_DEFS
├── schema.ts             → validateSchema() updated to resolve + validate capabilities
└── index.ts              → exports (SYSTEM_FIELDS removed)

@datafn/server (runtime behavior)
├── execution/
│   ├── mutation/
│   │   ├── execute.ts    → capability field injection on mutations
│   │   ├── dfql.ts       → new operations (trash, restore, archive, unarchive)
│   │   └── share.ts      → share/unshare execution (new file)
│   ├── query/
│   │   └── pushdown.ts   → auto-filter injection for trash/archive
│   └── sync/
│       └── push.ts       → capability injection in push path
├── validation/
│   ├── mutation.ts       → accept new operations
│   ├── authz.ts          → capability field authz rules
│   └── schema.ts         → capability-aware SchemaIndex
└── routes/
    ├── query.ts           → pass metadata (includeTrashed, includeArchived)
    └── mutation.ts        → actorId extraction for audit/trash

@datafn/cli (codegen)
└── drizzle-codegen.ts    → generate capability columns + permissions tables

@datafn/client (API surface)
├── mutate.ts             → .trash(), .restore(), .archive(), .unarchive(), .share(), .unshare()
├── query.ts              → metadata support for filter overrides
└── plugins/softDelete.ts → deprecation warning
```

## Dependency Graph

```
Phase 0: Core types + resolution
    ↓
Phase 1: Schema validation integration
    ↓
Phase 2: Codegen (Drizzle)
    ↓
Phase 3: Server — timestamps + audit injection
    ↓
Phase 4: Server — trash + restore operations
    ↓
Phase 5: Server — archivable operations
    ↓
Phase 6: Server — auto-query filtering (trash + archive)
    ↓
Phase 7: Client — capability methods (trash, restore, archive, unarchive)
    ↓
Phase 8: Sync — push path + change tracking
    ↓
Phase 9: Remove SYSTEM_FIELDS + update all consumers
    ↓
Phase 10: Server — shareable permissions table execution
    ↓
Phase 11: Server — shareable query gating + mutation authz
    ↓
Phase 12: Client — share/unshare/getPermissions methods
    ↓
Phase 13: Deprecate createSoftDeletePlugin
    ↓
Phase 14: Example app update + integration test
```

## Phases Overview

| Phase | Goal | Delivered Capability | Verification |
|---|---|---|---|
| 0 | Core capability types + resolution | Type definitions, `resolveCapabilities()` | Unit tests on resolution logic |
| 1 | Schema validation with capabilities | `validateSchema()` handles capabilities, collision detection | Validation tests |
| 2 | Drizzle codegen for capabilities | Capability columns + permissions tables in generated schemas | Codegen snapshot tests |
| 3 | Timestamps + audit server injection | `createdAt`/`updatedAt`/`createdBy`/`updatedBy` auto-set on mutations | Mutation integration tests |
| 4 | Trash + restore server operations | New `trash`/`restore` DFQL operations | Mutation execution tests |
| 5 | Archive + unarchive server operations | New `archive`/`unarchive` DFQL operations | Mutation execution tests |
| 6 | Query auto-filtering | Trash/archive auto-filters injected server-side | Query integration tests |
| 7 | Client capability methods | `.trash()`, `.restore()`, `.archive()`, `.unarchive()` on client | Client unit tests |
| 8 | Sync integration | Push handles new operations + capability injection | Push integration tests |
| 9 | Remove SYSTEM_FIELDS | Legacy constants removed, all consumers updated | Build succeeds, no regressions |
| 10 | Shareable execution | `share`/`unshare` operations + permissions table management | Share operation tests |
| 11 | Shareable query gating + mutation authz | Private resource filtering + access level enforcement | Authorization integration tests |
| 12 | Client sharing methods | `.share()`, `.unshare()`, `.getPermissions()` | Client unit tests |
| 13 | Deprecate soft delete plugin | Console warning, validation error on conflict | Warning tests |
| 14 | Example app + integration test | Updated todo-app using capabilities | End-to-end test passes |

## Definition of Done (Global)

No phase is complete unless:
1. All listed verification steps pass
2. Existing tests continue to pass (no regressions)
3. TypeScript compilation succeeds with no new errors
4. The deliverables listed in the phase are fully implemented (not stubbed)

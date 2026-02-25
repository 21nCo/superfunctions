# PLAN: Schema Index Validation & Type-Safe Schema Declarations

## Architecture Sketch

```
@datafn/core (datafn/core/)
├── src/types.ts         ← Add defineSchema() function + generic types
├── src/schema.ts        ← Add index field validation to validateSchema()
└── src/index.ts         ← Export defineSchema

@datafn/cli (datafn/cli/)
├── src/cli.ts           ← Add `validate` command
└── __tests__/
    └── drizzle-codegen.test.ts  ← Add validation test cases

Example (datafn/examples/todo-app/server/)
└── src/schema.datafn.ts ← Fix index field name + use defineSchema()
```

## Dependency Graph

```
Phase 0: Runtime validation in validateSchema()
    ↓
Phase 1: CLI validate command (depends on Phase 0 — uses validateSchema())
    ↓  (parallel with Phase 1)
Phase 1: defineSchema() type helper (depends on Phase 0 — validates same fields)
    ↓
Phase 2: Fix example schema + regenerate (depends on Phases 0 & 1)
```

## Phases Overview

| Phase | Goal | Delivered Capability | Verification |
|---|---|---|---|
| 0 | Runtime validation of index fields | `validateSchema()` rejects invalid index field names with clear errors | Unit tests: valid schemas pass, invalid schemas fail with correct error messages |
| 1 | CLI validate command + defineSchema() helper | `datafn validate` command; compile-time type safety via `defineSchema()` | CLI manual test; TypeScript compile check on valid/invalid schemas |
| 2 | Fix example + regenerate | Corrected todo-app schema; regenerated Drizzle output | `datafn validate` passes on example; generated file has `table.createdAt` |

## Definition of Done

No phase is complete unless its verification steps pass. All existing tests in `datafn/cli/__tests__/drizzle-codegen.test.ts` must continue to pass after every phase.

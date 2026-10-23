# SPEC: Relation Capabilities for Many-Many Join Tables

## Metadata
- **Timestamp**: 2026-03-07T07:03:03Z
- **Agent name**: unknown-agent
- **Model**: unknown
- **Launcher**: CLI
- **Workspace / project path**: /Users/serro/Documents/dev/n/superfunctions/datafn
- **OS + shell**: Darwin 25.3.0 arm64 / /bin/zsh
- **Git branch**: heads/next
- **Git commit**: 635bf28
- **Git status**: dirty
- **spec_folder**: `2026-03-07-new-q7m3k9r2-spec`
- **spec_folder path**: `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/specs/2026-03-07-new-q7m3k9r2-spec`
- **spec_type**: `new`
- **spec_id**: `q7m3k9r2`
- **Input paths read**:
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/specs/2026-03-06-new-k4m7x9r3-spec/SPEC.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/specs/2026-03-06-new-k4m7x9r3-spec/REQUIREMENTS.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/specs/2026-02-15-change-m8k3x7p4-spec/REQUIREMENTS.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/intent/dfql.intent.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/core/src/types.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/core/src/schema.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/core/src/relations.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/cli/src/drizzle-codegen.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/cli/src/codegen.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/server/src/execution/mutation/execute.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/server/src/execution/mutation/relations.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/examples/todo-app/server/src/schema.datafn.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/examples/todo-app/server/src/datafn-schema.drizzle.ts`
  - Conversation intent (user request on 2026-03-07): join-table capability fields are not injected; desired ideal is explicit, intentional support.

## Overview
This specification introduces **explicit relation-level capabilities** for `many-many` relations so join-table rows can receive capability-managed fields (timestamps and audit) in a deterministic, server-managed way.

Current behavior is resource-scoped only: capability fields are injected for resources, while generic join tables only include `id/from/to` + relation metadata. This spec preserves that default and adds an opt-in path:

- Existing schemas remain unchanged unless relation capabilities are declared.
- Join-table capability behavior is explicit per relation.
- Server remains authoritative for readonly capability fields on join rows.

## Glossary
- **Relation capability**: A capability declared on a `many-many` relation that applies to its join table row lifecycle.
- **Join row**: The row persisted in the SQL join table for a `many-many` relation, keyed by composite id `${fromId}:${toId}`.
- **Readonly relation capability fields**: `createdAt`, `updatedAt`, `createdBy`, `updatedBy` on join rows.
- **Relation metadata**: User-defined fields declared in `relations[].metadata`, stored on join rows.
- **Relation payload metadata**: Metadata sent inside `relate` / `modifyRelation` DFQL payloads.

## Goals / Non-goals
### Goals
1. Add explicit capability declarations for `many-many` relation join tables.
2. Support server-managed join-row `timestamps` and `audit` fields.
3. Preserve current default behavior for schemas that do not opt in.
4. Keep mutation, push, change tracking, and codegen behavior consistent.
5. Provide deterministic validation and clear error codes for invalid relation capability config.

### Non-goals
1. No implicit inheritance of resource capabilities to relations.
2. No relation capability support for `one-many`, `many-one`, or `htree`.
3. No relation-level `trash`, `archivable`, or `shareable` in this spec.
4. No change to existing permissions-table behavior for resource-level `shareable`.
5. No Python package parity requirement in this spec revision (TypeScript packages only).

## Context
- **Project name**: datafn
- **One-sentence goal**: Add explicit many-many relation capabilities so join tables can receive server-managed capability fields safely and deterministically.
- **Target users**: DataFn schema authors using many-many relations with metadata/audit requirements.
- **Target environments**: TypeScript runtime (Node/Bun), SQL adapters through server, local-first sync clients.
- **Languages/packages required**: `@datafn/core`, `@datafn/server`, `@datafn/cli`, `@datafn/client`.
- **Existing integrations**: `@superfunctions/db` adapters, existing relation mutation and sync pipeline.
- **Data model summary**: resources + relations; many-many relations persisted as join tables.
- **Security model**: namespace isolation, actor-aware server mutation handling, server-owned readonly fields.
- **Performance constraints**: maintain current O(log n) join-table lookups/upserts; no extra full-table scans.
- **Hard constraints**: deterministic schema/codegen output, backward compatibility for non-opt-in schemas.

## Public API
### Schema API
`DatafnRelationSchema` is extended:

```ts
export type RelationSimpleCapability = "timestamps" | "audit";

export type DatafnRelationSchema = {
  from: string | string[];
  to: string | string[];
  type: "one-many" | "many-one" | "many-many" | "htree";
  relation?: string;
  inverse?: string;
  cache?: boolean;
  metadata?: Array<{ name: string; type: "string" | "number" | "boolean" | "date" | "object" | "json" }>;
  fkField?: string;
  pathField?: string;
  joinTable?: string;
  joinColumns?: { from: string; to: string };
  capabilities?: RelationSimpleCapability[]; // NEW
};
```

Example:

```ts
relations: [
  {
    from: "todos",
    to: "categories",
    type: "many-many",
    relation: "tags",
    inverse: "todos",
    capabilities: ["timestamps", "audit"],
    metadata: [{ name: "addedOrder", type: "number" }]
  }
]
```

### Relation capability fields
When relation capability resolution yields:
- `timestamps` -> inject `createdAt: date`, `updatedAt: date`
- `audit` -> inject `createdBy: string`, `updatedBy: string`

No other relation capability is valid in this spec.

### Canonical mutation envelope
This spec keeps existing mutation envelope and relation payload normalization:

```json
{
  "mutationId": "mut-rel-1",
  "resource": "todos",
  "operation": "relate",
  "id": "todo:1",
  "relations": {
    "tags": [
      { "$ref": "cat:1", "addedOrder": 1, "createdAt": 123 }
    ]
  }
}
```

Server normalization rule:
- `$ref` maps to target id.
- Remaining keys are relation metadata input.
- Readonly relation capability fields from client input are stripped before write.

### Canonical join-row shape
For relation `todos.tags -> categories` using default columns `from`/`to`:

```json
{
  "id": "todo:1:cat:1",
  "from": "todo:1",
  "to": "cat:1",
  "addedOrder": 1,
  "createdAt": 1710000000000,
  "updatedAt": 1710000000000,
  "createdBy": "user:alice",
  "updatedBy": "user:alice"
}
```

## Data formats / protocol
### Capability resolution for relations
`resolveRelationCapabilities(relation)` MUST:
1. Return `[]` when `relation.capabilities` is undefined.
2. Deduplicate declared entries.
3. Reject unknown values.
4. Return deterministic capability order: `["timestamps", "audit"]` subset order.

### Error codes
- `SCHEMA_INVALID`: malformed relation capability structure or wrong relation type.
- `INVALID_CAPABILITY`: unsupported relation capability value.
- `CAPABILITY_FIELD_COLLISION`: relation metadata field collides with relation capability field.
- `DFQL_UNSUPPORTED`: operation not valid for relation schema/capability context.
- `NOT_FOUND`: relation row not found for `modifyRelation` target.
- `INTERNAL`: adapter/runtime failure.

## Semantics
1. **Opt-in only**: relation capability behavior is active only when `relations[i].capabilities` is present.
2. **many-many only**: relation capabilities are valid only when `relations[i].type === "many-many"`.
3. **Readonly stripping**:
   - Before join-row write in `relate`/`modifyRelation`, strip client-provided `createdAt`, `updatedAt`, `createdBy`, `updatedBy` for enabled capabilities.
4. **Relate create path**:
   - Insert path sets `createdAt`/`updatedAt` to current epoch ms when `timestamps` enabled.
   - Insert path sets `createdBy`/`updatedBy` to `actorId ?? null` when `audit` enabled.
5. **Relate update path (idempotent upsert)**:
   - Upsert update path sets `updatedAt` and `updatedBy` when enabled.
   - `createdAt` and `createdBy` MUST remain immutable after first create.
6. **modifyRelation path**:
   - On existing join row: apply metadata delta + update capability fields (`updatedAt`, `updatedBy`).
   - On missing join row: return `NOT_FOUND` and perform no write.
7. **unrelate path**:
   - Behavior unchanged (hard delete join row); no soft-delete semantics.
8. **push parity**:
   - `/datafn/push` relation mutations MUST use identical stripping/injection behavior as direct mutation route.
9. **change-tracking parity**:
   - Join-row delta records MUST include capability fields when present so pull/clone consumers receive full edge state.

## Invariants
1. Server-owned relation capability fields are never authoritative from client payload.
2. Relation capability output is deterministic for identical schema input.
3. Existing schemas without relation capabilities remain byte-for-byte equivalent in generated join-table DDL (except unrelated existing behavior).
4. Namespace wrapping behavior remains unchanged; capability injection must not alter namespace conflict-target semantics.
5. For any join row, `createdAt/createdBy` are immutable after first persisted create.

## Security
1. Server MUST strip readonly relation capability fields from client relation metadata input.
2. Audit values MUST come only from server actor context (`actorId`) or `null` fallback.
3. Namespace MUST continue to scope join row writes/reads exactly as current behavior.
4. No direct client API to mutate relation capability fields outside relation operations.

## Limits / caps
1. Maximum relation capabilities per relation: 2 (`timestamps`, `audit`).
2. Unknown relation capability values are rejected.
3. Relation capability fields use same scalar types as resource capabilities:
   - `date` -> epoch ms numeric storage
   - `string` -> text storage

## Observability
1. Debug log SHOULD emit relation capability resolution per relation at schema load time.
2. Debug log SHOULD emit when readonly relation capability fields are stripped from relation payload metadata.
3. Error logs MUST include operation (`relate`/`modifyRelation`), relation name, and error code.
4. Logs MUST NOT include sensitive token material or full auth context objects.

## Compatibility / versioning strategy
1. Backward compatible by default: no schema change unless `relations[].capabilities` is declared.
2. Enabling relation capabilities is a schema migration event and requires regenerated Drizzle schema + DB migration.
3. Existing relation metadata semantics remain unchanged when relation capabilities are not enabled.
4. Generated type output remains stable except for relations that opt into capabilities.

## Assumptions and open questions
### Assumptions
1. Scope is TypeScript (`core/server/cli/client`) only.
2. Relation capabilities are explicit per relation; no global relation-capability block is introduced.
3. `audit` on relation rows permits `null` actor fallback for deployments without actor context.

### Open question (non-blocking)
1. Should a future schema version support relation capability inheritance from schema-level defaults? This spec sets behavior to explicit-only and leaves inheritance undefined.

## Undefined / Explicitly user-deferred only
1. Relation-level `trash`, `archivable`, and `shareable` semantics are Undefined.
2. Relation capabilities on `one-many`, `many-one`, `htree` are Undefined.
3. Python runtime parity is Undefined for this spec.
4. Historical backfill migration for pre-existing join rows (`createdAt`/`createdBy`) is Undefined.

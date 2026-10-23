# SPEC: Schema Capabilities — Timestamps, Audit, Trash, Archivable, Shareable

## Metadata

- **Timestamp**: 2026-03-06T18:00:00Z
- **Agent name**: claude-opus-4-6
- **Model**: Claude Opus 4.6
- **Launcher**: VS Code (Claude Code extension)
- **Workspace**: /Users/serro/Documents/dev/n/superfunctions
- **OS**: Darwin / zsh
- **Git branch**: heads/next
- **Git commit**: 664f92c (dirty)
- **spec_folder**: `2026-03-06-new-k4m7x9r3-spec`
- **spec_folder path**: `datafn/.conduct/specs/2026-03-06-new-k4m7x9r3-spec`
- **spec_type**: `new`
- **spec_id**: `k4m7x9r3`
- **Input paths**:
  - `datafn/.conduct/audits/2026-03-06-delete-system-fields-timeline-audit.md` (timeline audit of system fields drift)
  - `datafn/core/src/types.ts` (current schema types)
  - `datafn/core/src/system-fields.ts` (current system fields)
  - `datafn/server/src/execution/mutation/execute.ts` (mutation execution)
  - `datafn/server/src/execution/mutation/dfql.ts` (buildReplaceRecord)
  - `datafn/server/src/validation/authz.ts` (authorization)
  - `datafn/cli/src/drizzle-codegen.ts` (Drizzle schema generation)
  - `datafn/client/src/plugins/softDelete.ts` (current soft-delete plugin)
  - `~/Documents/dev/n/nucleus/client/components/flux/resourceStores/resource.type.ts` (nucleus patterns)
  - `~/Documents/dev/n/nucleus/client/components/flux/resourceStores/resource.store.ts` (nucleus patterns)

---

## Overview

Replace the vestigial `SYSTEM_FIELDS` / `READONLY_SYSTEM_FIELDS` constants with a declarative **capabilities** system on the DataFn schema. Capabilities are opt-in behaviors that auto-inject fields, auto-populate values on mutations, auto-filter queries, and expose abstracted client methods.

Five capabilities are defined:

| Capability | Auto-injected fields | Behavior |
|---|---|---|
| `timestamps` | `createdAt`, `updatedAt` | Auto-set on insert/update |
| `audit` | `createdBy`, `updatedBy` | Auto-set from auth context on insert/update |
| `trash` | `trashedAt`, `trashedBy` | Soft-delete with `.trash()`, `.restore()`, auto-filter |
| `archivable` | `isArchived` | Archive with `.archive()`, `.unarchive()`, auto-filter |
| `shareable` | Permissions join table | Per-record user-level access with `.share()`, `.unshare()`, query gating |

Capabilities can be declared globally (schema-level) and per-resource. Resource-level declarations merge with global — additive by default, with an explicit exclude mechanism.

This replaces:
- The `SYSTEM_FIELDS` / `READONLY_SYSTEM_FIELDS` constants (removed)
- The `createSoftDeletePlugin` client plugin (deprecated, superseded by `trash` capability)
- The orphaned `isArchived` system field (now only exists when `archivable` is enabled)

---

## Glossary

| Term | Definition |
|---|---|
| **Capability** | A named, opt-in behavior that auto-injects fields and provides auto-set/auto-filter/API semantics on a resource |
| **Capability-injected field** | A field that exists on a resource solely because a capability is enabled; not explicitly declared by the user in `fields` |
| **Global capability** | A capability declared at the schema level; applies to all resources unless explicitly excluded |
| **Resource capability** | A capability declared on a specific resource; merges additively with global capabilities |
| **Capability exclusion** | A resource-level declaration that removes a global capability from that specific resource |
| **Resolved capabilities** | The final set of capabilities for a resource after merging global + resource-level + exclusions |
| **Trash** | Soft-delete: the record is hidden from queries but recoverable via `.restore()` |
| **Archive** | Hide-from-active-view: the record is hidden from queries but immediately accessible via filter override |
| **Shareable** | Per-record, per-user access control with access levels within a namespace |
| **Access level** | The permission tier a user has on a shared record: `viewer`, `editor`, or `owner` |
| **Permissions table** | An auto-generated join table (`__datafn_permissions_{resource}`) that maps `(resourceId, userId)` to access levels |
| **Actor ID** | The identity of the current user, obtained from `namespaceProvider.getActorId()` |

---

## Goals

1. Replace the static `SYSTEM_FIELDS` constants with a dynamic, opt-in capabilities system
2. Auto-inject capability fields into schemas, codegen output, and database tables
3. Auto-populate capability fields on mutations (timestamps, audit trails) server-side
4. Auto-filter queries to exclude trashed and archived records by default
5. Provide first-class client methods (`.trash()`, `.restore()`, `.archive()`, `.unarchive()`, `.share()`, `.unshare()`)
6. Support global + per-resource capability declaration with exclusion
7. Implement per-record sharing with access levels within namespace boundaries

## Non-goals

- Replacing the existing `permissions` (field-level read/write policies) on resources — capabilities are orthogonal
- Cross-namespace sharing (sharing across tenants) — sharing operates within a namespace
- Role-based access control (RBAC) — this is user-to-record access, not role-based
- Automatic UI generation for capabilities — this is a data/API layer spec
- Modifying the existing `namespaceProvider` or namespace isolation mechanism

---

## Public API

### Schema Definition

```typescript
// New: capabilities field on schema and resources
const schema = defineSchema({
  capabilities: ["timestamps", "audit", "trash"],  // global
  resources: [
    {
      name: "todos",
      capabilities: ["archivable"],                 // additive to global
      fields: [
        { name: "text", type: "string", required: true },
        { name: "completed", type: "boolean", default: false },
      ]
    },
    {
      name: "audit_logs",
      capabilities: { exclude: ["trash"] },         // opt out of global trash
      fields: [
        { name: "message", type: "string", required: true },
      ]
    },
    {
      name: "documents",
      capabilities: [
        "archivable",
        { shareable: { levels: ["viewer", "editor", "owner"], default: "private" } }
      ],
      fields: [
        { name: "title", type: "string", required: true },
        { name: "body", type: "string", required: false },
      ]
    }
  ]
});
```

### Type Definitions

```typescript
// --- Capability types ---

/** Simple capabilities that require no configuration */
type SimpleCapability = "timestamps" | "audit" | "trash" | "archivable";

/** Shareable capability with required configuration */
type ShareableCapability = {
  shareable: {
    levels: AccessLevel[];
    default: "private" | "shared";
  };
};

type AccessLevel = "viewer" | "editor" | "owner";

/** A single capability entry */
type CapabilityEntry = SimpleCapability | ShareableCapability;

/** Resource-level capability declaration */
type ResourceCapabilities = CapabilityEntry[] | { exclude: SimpleCapability[] };

/** Schema-level capability declaration */
type SchemaCapabilities = CapabilityEntry[];

// --- Updated schema types ---

type DatafnSchema = {
  resources: DatafnResourceSchema[];
  relations?: DatafnRelationSchema[];
  namespaced?: boolean;
  capabilities?: SchemaCapabilities;          // NEW
};

type DatafnResourceSchema = {
  name: string;
  version: number;
  idPrefix?: string;
  isRemoteOnly?: boolean;
  fields: DatafnFieldSchema[];
  indices?: { base?: string[]; search?: string[]; vector?: string[] } | string[];
  permissions?: DatafnPermissionsPolicy;
  capabilities?: ResourceCapabilities;        // NEW
};
```

### Resolved Capability Fields

When capabilities are resolved for a resource, the following fields are injected:

| Capability | Field name | Type | Writable by client | Server-managed |
|---|---|---|---|---|
| `timestamps` | `createdAt` | `date` | No | Yes — set on insert |
| `timestamps` | `updatedAt` | `date` | No | Yes — set on insert and every mutation |
| `audit` | `createdBy` | `string` | No | Yes — set on insert from actorId |
| `audit` | `updatedBy` | `string` | No | Yes — set on every mutation from actorId |
| `trash` | `trashedAt` | `date` | No | Yes — set by `.trash()` |
| `trash` | `trashedBy` | `string` | No | Yes — set by `.trash()` from actorId |
| `archivable` | `isArchived` | `boolean` | Yes | No — client sets directly |

For `shareable`, no fields are injected into the resource table. Instead, a separate permissions join table is created.

### Client API

```typescript
// --- Table-level methods (added when capability is enabled) ---

// trash capability
table.trash(id: string): Promise<MutationResult>;
table.restore(id: string): Promise<MutationResult>;

// archivable capability
table.archive(id: string): Promise<MutationResult>;
table.unarchive(id: string): Promise<MutationResult>;

// shareable capability
table.share(id: string, userId: string, level: AccessLevel): Promise<MutationResult>;
table.unshare(id: string, userId: string): Promise<MutationResult>;
table.getPermissions(id: string): Promise<PermissionEntry[]>;

// delete (always available)
table.delete(id: string): Promise<MutationResult>;  // hard delete

// --- Query options ---

// Queries auto-exclude trashed and archived by default.
// Override with metadata:
table.query({ filters: {...}, metadata: { includeTrashed: true } });
table.query({ filters: {...}, metadata: { includeArchived: true } });
// Or query specifically for trashed/archived:
table.query({ filters: { isArchived: true }, metadata: { includeArchived: true } });
```

### Server-Side Mutation Handling

For `trash` and `audit`/`timestamps` capabilities, the server intercepts mutations:

1. **Insert**: Server injects `createdAt`, `updatedAt`, `createdBy`, `updatedBy` (if enabled)
2. **Merge/Replace**: Server injects `updatedAt`, `updatedBy` (if enabled)
3. **Trash operation** (`operation: "trash"`): Server sets `trashedAt`, `trashedBy`; new DFQL operation
4. **Restore operation** (`operation: "restore"`): Server clears `trashedAt`, `trashedBy`; new DFQL operation
5. **Archive operation** (`operation: "archive"`): Server sets `isArchived: true`; syntactic sugar for merge
6. **Unarchive operation** (`operation: "unarchive"`): Server sets `isArchived: false`; syntactic sugar for merge

The server MUST strip any client-provided values for readonly capability fields (`createdAt`, `updatedAt`, `createdBy`, `updatedBy`, `trashedAt`, `trashedBy`) from mutation records before execution. The server-set values always win.

### Shareable Operations

Share operations are new DFQL mutations:

```typescript
// Share a record with a user
{
  resource: "documents",
  operation: "share",
  id: "doc:1",
  shareWith: { userId: "user:alice", level: "editor" }
}

// Unshare
{
  resource: "documents",
  operation: "unshare",
  id: "doc:1",
  shareWith: { userId: "user:alice" }
}
```

These operations write to the permissions table `__datafn_permissions_{resource}`.

### Permissions Table Schema

For each resource with `shareable` enabled, a join table is auto-generated:

```
__datafn_permissions_{resource}
├── __ns: string (namespace)
├── id: string (primary key — auto-generated)
├── resourceId: string (FK to resource)
├── userId: string (the user being granted access)
├── level: string (access level: viewer/editor/owner)
├── grantedBy: string (actorId who granted)
├── grantedAt: date (timestamp)
```

### Query Gating for Shareable Resources

When a resource has `shareable` enabled and `default: "private"`:

1. All queries for that resource MUST be filtered to only return records where:
   - The current `actorId` is the record's `createdBy` (requires `audit` capability), OR
   - An entry exists in the permissions table for `(resourceId, actorId)`
2. When `default: "shared"`, all records within the namespace are visible (tenant-wide), and the permissions table is used to restrict or grant specific access levels for mutation authorization

### Query Auto-Filtering

When `trash` is enabled: queries auto-inject `{ trashedAt: null }` filter (exclude trashed records)
When `archivable` is enabled: queries auto-inject `{ isArchived: { $ne: true } }` filter (exclude archived records)

These filters are injected server-side in the query execution path, NOT as a client plugin. The client can override with metadata flags.

---

## Data Formats / Protocol

### Capability Resolution Algorithm

```
resolveCapabilities(schema, resource):
  1. Start with global: schema.capabilities ?? []
  2. If resource.capabilities is an array:
       result = union(global, resource.capabilities)
  3. If resource.capabilities is { exclude: [...] }:
       result = global minus excluded
  4. If resource.capabilities is undefined:
       result = global
  5. Validate: if "audit" is enabled, "timestamps" SHOULD also be enabled
     (audit implies createdBy/updatedBy which benefit from createdAt/updatedAt)
  6. Return resolved set
```

### Capability Field Injection in Schema Validation

When `validateSchema()` processes a schema with capabilities:
1. For each resource, resolve capabilities
2. For each resolved capability, merge the injected fields into the resource's effective field list
3. Injected fields MUST NOT collide with user-defined fields (validation error if they do)
4. The effective field list (user fields + capability fields) is used for all validation, codegen, and execution

### Capability Field Collision Rule

If a user defines a field with the same name as a capability-injected field, `validateSchema()` MUST return a validation error:

```
CAPABILITY_FIELD_COLLISION: Field "createdAt" on resource "todos" collides with
capability-injected field from "timestamps". Remove the field from your schema
definition — it is automatically managed by the capability.
```

### DFQL Extended Operations

New mutation operations:

| Operation | Valid when | Server behavior |
|---|---|---|
| `trash` | `trash` capability enabled | Sets `trashedAt` + `trashedBy`, records change |
| `restore` | `trash` capability enabled | Clears `trashedAt` + `trashedBy`, records change |
| `archive` | `archivable` capability enabled | Sets `isArchived: true`, records change |
| `unarchive` | `archivable` capability enabled | Sets `isArchived: false`, records change |
| `share` | `shareable` capability enabled | Inserts/updates permissions table entry |
| `unshare` | `shareable` capability enabled | Deletes permissions table entry |

Existing operations (`insert`, `merge`, `replace`, `delete`, `relate`, `modifyRelation`, `unrelate`) are unchanged.

---

## Semantics

### Timestamps Capability

- `createdAt`: Set to `Date.now()` (epoch ms) on `insert`. MUST NOT be modified on any subsequent mutation. If the record is created via upsert (merge on non-existent), `createdAt` is set on the implicit insert.
- `updatedAt`: Set to `Date.now()` (epoch ms) on every mutation (`insert`, `merge`, `replace`, `trash`, `restore`, `archive`, `unarchive`). Always reflects the last modification time.

### Audit Capability

- `createdBy`: Set to `actorId` on `insert`. MUST NOT be modified on any subsequent mutation. Requires `namespaceProvider.getActorId()` to be configured. If `actorId` is unavailable, the field is set to `null`.
- `updatedBy`: Set to `actorId` on every mutation. Same fallback to `null`.

### Trash Capability

- `trash` operation: Sets `trashedAt` to epoch ms, `trashedBy` to actorId. The record remains in the database but is excluded from queries.
- `restore` operation: Clears `trashedAt` to `null`, `trashedBy` to `null`. The record becomes visible in queries again.
- Trashing an already-trashed record is idempotent (updates `trashedAt`/`trashedBy` to new values).
- Restoring a non-trashed record is idempotent (no-op, returns `ok: true`).
- Hard `delete` of a trashed record is allowed — it permanently removes the record.
- Query auto-filter: `{ trashedAt: null }` injected unless `metadata.includeTrashed: true`.

### Archivable Capability

- `archive` operation: Sets `isArchived: true`. Record excluded from queries.
- `unarchive` operation: Sets `isArchived: false`. Record visible in queries.
- Archiving an already-archived record is idempotent.
- `isArchived` is also directly writable by clients via `merge` (for backward compatibility and bulk operations).
- Query auto-filter: `{ isArchived: { $ne: true } }` injected unless `metadata.includeArchived: true`.
- A record can be both archived AND trashed. Restoring from trash does not unarchive. Unarchiving does not restore from trash.

### Shareable Capability

- Requires `audit` capability (needs `createdBy` for ownership determination).
- When `default: "private"`:
  - Only the creator (`createdBy`) and users with permissions table entries can see/access the record
  - Queries are gated: server adds a subquery/join to filter by actorId ownership or permissions entry
- When `default: "shared"`:
  - All users within the namespace can read the record
  - The permissions table is used for write authorization: only `editor` and `owner` levels can mutate
  - `viewer` level can read but not mutate
- Access levels:
  - `viewer`: Read access only
  - `editor`: Read + write access (merge, replace, archive, trash)
  - `owner`: Read + write + share/unshare + delete
- The record creator is implicitly an `owner` (no permissions table entry needed).
- `share` operation: Inserts or updates a row in `__datafn_permissions_{resource}`. Only `owner` can share.
- `unshare` operation: Deletes the row. Only `owner` can unshare. Cannot unshare the creator.
- Deleting a record also deletes all its permissions entries (cascading).
- Trashing a record does NOT delete permissions. Restoring preserves all sharing.

---

## Invariants

1. **Capability fields are readonly except `isArchived`**: The server MUST strip `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, `trashedAt`, `trashedBy` from client-provided `record` on all mutations. `isArchived` MAY be set by clients directly.
2. **Capability fields never collide with user fields**: `validateSchema()` MUST reject schemas where user-defined fields overlap with capability-injected fields.
3. **Resolved capabilities are deterministic**: Given the same schema, capability resolution MUST always produce the same result.
4. **Auto-filters are additive**: Trash and archive auto-filters are added as additional conditions to user-provided filters, never replacing them.
5. **Namespace boundary**: Shareable permissions operate within a namespace. Permissions entries have the same `__ns` as the record.
6. **Creator is always owner**: The `createdBy` user has implicit `owner` access that cannot be revoked via `unshare`.
7. **Idempotent capability operations**: Trashing a trashed record, archiving an archived record, restoring a non-trashed record, and sharing with same level are all idempotent.
8. **Capability operations are change-tracked**: All new operations (trash, restore, archive, unarchive, share, unshare) MUST record change tracking entries for sync.
9. **Backward compatibility**: Existing schemas without `capabilities` continue to work exactly as before. The `SYSTEM_FIELDS` constant is removed but schemas that previously relied on it will get clear migration guidance.

---

## Security

1. **Readonly enforcement**: Server MUST strip capability-managed readonly fields from client mutation records before execution. A client cannot forge `createdAt` or `trashedBy`.
2. **ActorId requirement**: `audit`, `trash`, and `shareable` capabilities SHOULD have `namespaceProvider.getActorId()` configured. If not configured, audit fields default to `null`, and `shareable` MUST NOT be used (validation error).
3. **Share authorization**: Only users with `owner` access level can perform `share`/`unshare` operations. The server MUST validate this before execution.
4. **Mutation authorization for shareable**: When `shareable.default === "private"`, mutation operations on a record require at minimum `editor` access (or ownership). When `default === "shared"`, standard namespace-level access applies for reads; writes may optionally check permissions if configured.
5. **Query gating for shareable**: The server MUST enforce query filtering for `private` shareable resources — a user cannot see records they don't own and haven't been shared with. This is enforced server-side, not client-side.
6. **Permissions table is internal**: The `__datafn_permissions_{resource}` table MUST NOT be directly queryable/mutatable by clients. Access is only through `share`/`unshare`/`getPermissions` operations.
7. **Cascading delete**: Hard-deleting a record with `shareable` MUST cascade-delete all permissions entries for that record.

---

## Limits / Caps

1. **Maximum capabilities per resource**: No limit (bounded by the 5 defined capabilities).
2. **Maximum shares per record**: Configurable via server config, default 100.
3. **Maximum `shareable` resources per schema**: No limit.
4. **Permissions table growth**: The `__datafn_permissions_{resource}` table can grow large. Indexing on `(resourceId, userId)` is mandatory.

---

## Observability

1. **Capability resolution**: When `debug: true`, log the resolved capabilities for each resource during schema validation.
2. **Auto-injected fields**: Log (at debug level) when capability fields are injected into mutation records.
3. **Share operations**: Log share/unshare operations at info level (who shared what with whom at what level).
4. **Query gating**: Log (at debug level) when shareable query gating modifies a query.

---

## Compatibility / Versioning Strategy

### Migration from SYSTEM_FIELDS

1. `SYSTEM_FIELDS` and `READONLY_SYSTEM_FIELDS` constants are **removed** from `@datafn/core`.
2. Code that imports these constants MUST be updated to use the capability system.
3. Existing schemas that manually define `createdAt`, `updatedAt`, etc. as user fields MUST either:
   - Add the appropriate capability and remove the manual field definitions, OR
   - Keep the manual fields (no capability) — they remain user-managed fields with no auto-behavior.
4. The `isArchived` field is no longer a "system field" — it only exists when `archivable` is enabled.

### Migration from createSoftDeletePlugin

1. `createSoftDeletePlugin` is **deprecated** (not removed in Phase 1, removed in a later phase).
2. Users SHOULD migrate to the `trash` capability.
3. The `trash` capability uses different field names (`trashedAt`/`trashedBy`) than the plugin (`isDeleted`/`deletedAt`). Migration requires a data migration for existing records.
4. The deprecated plugin continues to work alongside capabilities but MUST NOT be used on resources that have `trash` capability enabled (validation error).

### Schema Version

The `capabilities` field is additive to the schema type. Existing schemas without it are valid and behave exactly as before (no capabilities, no auto-injection, no auto-filtering).

---

## Undefined / Explicitly Not Specified

1. **Cascading capabilities to relations**: Whether trashing/archiving a record should cascade to related records is NOT specified. This is application-specific logic (like nucleus's `onTrash`/`onArchive` hooks) and is left to the user.
2. **Trash retention / auto-purge**: Automatic deletion of trashed records after a retention period is NOT specified. This can be added as a future capability configuration.
3. **Shareable capability with offline/local-first**: How permissions sync works in offline mode is NOT specified in this version. Shareable resources SHOULD be `isRemoteOnly: true` in the initial implementation.
4. **Custom access levels**: The access levels are fixed at `viewer`, `editor`, `owner`. Custom levels are NOT supported.
5. **Bulk share/unshare**: Bulk sharing operations are NOT specified. Users can call `share` in a batch mutation.

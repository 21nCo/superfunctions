# REQUIREMENTS

## Table of Contents

### Core Infrastructure
- [CAP-001](#cap-001) Schema capabilities type definitions
- [CAP-002](#cap-002) Capability resolution algorithm
- [CAP-003](#cap-003) Capability field injection in schema validation
- [CAP-004](#cap-004) Capability field collision detection
- [CAP-005](#cap-005) Remove SYSTEM_FIELDS and READONLY_SYSTEM_FIELDS
- [CAP-006](#cap-006) Global + resource-level capability merging
- [CAP-007](#cap-007) Capability field readonly enforcement on server

### Timestamps Capability
- [TS-001](#ts-001) Auto-inject createdAt and updatedAt fields
- [TS-002](#ts-002) Auto-set createdAt on insert
- [TS-003](#ts-003) Auto-set updatedAt on every mutation
- [TS-004](#ts-004) Preserve createdAt immutability

### Audit Capability
- [AUD-001](#aud-001) Auto-inject createdBy and updatedBy fields
- [AUD-002](#aud-002) Auto-set createdBy on insert from actorId
- [AUD-003](#aud-003) Auto-set updatedBy on every mutation from actorId
- [AUD-004](#aud-004) Preserve createdBy immutability
- [AUD-005](#aud-005) Graceful fallback when actorId unavailable

### Trash Capability
- [TR-001](#tr-001) Auto-inject trashedAt and trashedBy fields
- [TR-002](#tr-002) Implement trash DFQL operation
- [TR-003](#tr-003) Implement restore DFQL operation
- [TR-004](#tr-004) Auto-filter trashed records from queries
- [TR-005](#tr-005) Query metadata override for includeTrashed
- [TR-006](#tr-006) Trash idempotency
- [TR-007](#tr-007) Hard delete of trashed records
- [TR-008](#tr-008) Trash change tracking

### Archivable Capability
- [AR-001](#ar-001) Auto-inject isArchived field
- [AR-002](#ar-002) Implement archive DFQL operation
- [AR-003](#ar-003) Implement unarchive DFQL operation
- [AR-004](#ar-004) Auto-filter archived records from queries
- [AR-005](#ar-005) Query metadata override for includeArchived
- [AR-006](#ar-006) isArchived direct write via merge
- [AR-007](#ar-007) Archive change tracking

### Shareable Capability
- [SH-001](#sh-001) Shareable capability configuration validation
- [SH-002](#sh-002) Permissions table auto-generation
- [SH-003](#sh-003) Implement share DFQL operation
- [SH-004](#sh-004) Implement unshare DFQL operation
- [SH-005](#sh-005) Implement getPermissions query
- [SH-006](#sh-006) Query gating for private shareable resources
- [SH-007](#sh-007) Mutation authorization for shareable resources
- [SH-008](#sh-008) Creator implicit owner
- [SH-009](#sh-009) Cascading permission delete
- [SH-010](#sh-010) Share authorization (owner-only)
- [SH-011](#sh-011) Shareable requires audit capability

### Codegen
- [CG-001](#cg-001) Drizzle codegen capability field injection
- [CG-002](#cg-002) Drizzle codegen permissions table generation
- [CG-003](#cg-003) Codegen capability resolution

### Client API
- [CL-001](#cl-001) Client trash() method
- [CL-002](#cl-002) Client restore() method
- [CL-003](#cl-003) Client archive() method
- [CL-004](#cl-004) Client unarchive() method
- [CL-005](#cl-005) Client share() method
- [CL-006](#cl-006) Client unshare() method
- [CL-007](#cl-007) Client getPermissions() method
- [CL-008](#cl-008) Client delete() method (existing, no change)
- [CL-009](#cl-009) Deprecate createSoftDeletePlugin

### Sync
- [SY-001](#sy-001) Push path capability field injection
- [SY-002](#sy-002) New operations in push validation
- [SY-003](#sy-003) Change tracking for new operations

### Validation
- [VA-001](#va-001) Validate capabilities in schema validation
- [VA-002](#va-002) Validate new DFQL operations against capabilities
- [VA-003](#va-003) Authz updates for capability fields

---

## Core Infrastructure

### CAP-001
- **ID**: CAP-001
- **Priority**: P0
- **Statement**: The `DatafnSchema` type MUST support an optional `capabilities` field accepting `CapabilityEntry[]`, and `DatafnResourceSchema` MUST support an optional `capabilities` field accepting `CapabilityEntry[] | { exclude: SimpleCapability[] }`.
- **Rationale**: Foundation type for the entire capability system.
- **Acceptance criteria**:
  - `defineSchema({ capabilities: ["timestamps", "audit"] })` compiles and validates
  - `defineSchema({ resources: [{ ..., capabilities: ["archivable"] }] })` compiles and validates
  - `defineSchema({ resources: [{ ..., capabilities: { exclude: ["trash"] } }] })` compiles and validates
  - Shareable with config: `{ shareable: { levels: ["viewer", "editor", "owner"], default: "private" } }` compiles and validates
- **Test vectors**: TV-CAP-001, TV-CAP-001N

### CAP-002
- **ID**: CAP-002
- **Priority**: P0
- **Statement**: A `resolveCapabilities(schema, resource)` function MUST compute the final set of capabilities for a resource by merging global and resource-level declarations with exclusion support.
- **Rationale**: Central algorithm that all other systems depend on.
- **Acceptance criteria**:
  - Global `["timestamps"]` + resource `["audit"]` → resolved `["timestamps", "audit"]`
  - Global `["timestamps", "trash"]` + resource `{ exclude: ["trash"] }` → resolved `["timestamps"]`
  - Global `["timestamps"]` + resource undefined → resolved `["timestamps"]`
  - Duplicate capabilities are deduplicated
  - Result is deterministic for same input
- **Test vectors**: TV-CAP-002, TV-CAP-002N

### CAP-003
- **ID**: CAP-003
- **Priority**: P0
- **Statement**: The schema validation function MUST resolve capabilities for each resource and inject the corresponding fields into the effective field list used for validation, codegen, and execution.
- **Rationale**: Capabilities must manifest as real fields in the schema index.
- **Acceptance criteria**:
  - A resource with `timestamps` capability has `createdAt` and `updatedAt` in its effective fields
  - Injected fields appear in the `SchemaIndex` field sets
  - Injected fields are usable in queries (select, filter, sort)
  - Injected fields appear in codegen output
- **Test vectors**: TV-CAP-003

### CAP-004
- **ID**: CAP-004
- **Priority**: P0
- **Statement**: `validateSchema()` MUST return a `CAPABILITY_FIELD_COLLISION` error if a user-defined field has the same name as a capability-injected field.
- **Rationale**: Prevents ambiguity between user-managed and capability-managed fields.
- **Acceptance criteria**:
  - Schema with `capabilities: ["timestamps"]` and field `{ name: "createdAt", ... }` fails validation
  - Error code is `CAPABILITY_FIELD_COLLISION`
  - Error message names the field and the capability
- **Test vectors**: TV-CAP-004N

### CAP-005
- **ID**: CAP-005
- **Priority**: P1
- **Statement**: The `SYSTEM_FIELDS` and `READONLY_SYSTEM_FIELDS` constants MUST be removed from `@datafn/core` and all consuming code updated to use capability-based field resolution.
- **Rationale**: These constants are the legacy system being replaced.
- **Acceptance criteria**:
  - `SYSTEM_FIELDS` and `READONLY_SYSTEM_FIELDS` are no longer exported from `@datafn/core`
  - All imports of these constants are replaced with capability-aware equivalents
  - Server validation, authz, codegen, and pushdown all use capability resolution
  - No regressions in existing tests
- **Test vectors**: TV-CAP-005N
- **Notes**: This is a breaking change. Must be coordinated with all consuming code.

### CAP-006
- **ID**: CAP-006
- **Priority**: P0
- **Statement**: Global capabilities MUST apply to all resources. Resource-level capabilities MUST merge additively with global capabilities when declared as an array, and MUST exclude specified capabilities when declared as `{ exclude: [...] }`.
- **Rationale**: Avoids repetition for common capabilities while allowing per-resource customization.
- **Acceptance criteria**:
  - Global `["timestamps", "audit"]` applies to all resources including those with no `capabilities` field
  - Resource `capabilities: ["trash"]` adds trash on top of global
  - Resource `capabilities: { exclude: ["audit"] }` removes audit but keeps timestamps
  - Resource with both additive and excludes: not supported (must be one form or the other)
- **Test vectors**: TV-CAP-006

### CAP-007
- **ID**: CAP-007
- **Priority**: P0
- **Statement**: The server MUST strip readonly capability-injected fields (`createdAt`, `updatedAt`, `createdBy`, `updatedBy`, `trashedAt`, `trashedBy`) from client-provided `record` objects before mutation execution.
- **Rationale**: Prevents clients from forging server-managed values.
- **Acceptance criteria**:
  - A client sending `{ record: { text: "hello", createdAt: "fake" } }` on a timestamps-enabled resource has `createdAt` stripped before DB write
  - The server-set value is used instead
  - `isArchived` is NOT stripped (it's client-writable)
  - Stripping happens before validation, not after
- **Test vectors**: TV-CAP-007, TV-CAP-007N

---

## Timestamps Capability

### TS-001
- **ID**: TS-001
- **Priority**: P0
- **Statement**: When `timestamps` capability is resolved for a resource, `createdAt` (type: `date`) and `updatedAt` (type: `date`) fields MUST be injected into the effective field list.
- **Rationale**: These fields exist only when opted in.
- **Acceptance criteria**:
  - Resource with `timestamps` has both fields in its schema index
  - Resource without `timestamps` does not have these fields
  - Fields have type `date`, are not required (server-managed), and are readonly
- **Test vectors**: TV-TS-001

### TS-002
- **ID**: TS-002
- **Priority**: P0
- **Statement**: On `insert` operations for resources with `timestamps`, the server MUST set `createdAt` to the current epoch milliseconds timestamp.
- **Rationale**: Automatic creation timestamp.
- **Acceptance criteria**:
  - After insert, the stored record has `createdAt` set to a valid epoch ms value
  - `createdAt` is not null
  - Value is within reasonable tolerance of current time
- **Test vectors**: TV-TS-002

### TS-003
- **ID**: TS-003
- **Priority**: P0
- **Statement**: On every mutation (`insert`, `merge`, `replace`, `trash`, `restore`, `archive`, `unarchive`) for resources with `timestamps`, the server MUST set `updatedAt` to the current epoch milliseconds timestamp.
- **Rationale**: Automatic last-modified timestamp.
- **Acceptance criteria**:
  - After any mutation, `updatedAt` reflects the mutation time
  - `updatedAt` is updated on every mutation, not just insert
- **Test vectors**: TV-TS-003

### TS-004
- **ID**: TS-004
- **Priority**: P0
- **Statement**: `createdAt` MUST NOT be modified after initial insert, regardless of subsequent mutations.
- **Rationale**: Creation time is immutable audit data.
- **Acceptance criteria**:
  - After merge/replace/trash/restore, `createdAt` retains its original value
  - Client-provided `createdAt` in a merge record is stripped (CAP-007)
- **Test vectors**: TV-TS-004

---

## Audit Capability

### AUD-001
- **ID**: AUD-001
- **Priority**: P0
- **Statement**: When `audit` capability is resolved for a resource, `createdBy` (type: `string`) and `updatedBy` (type: `string`) fields MUST be injected into the effective field list.
- **Rationale**: Audit trail of who performed operations.
- **Acceptance criteria**:
  - Resource with `audit` has both fields in its schema index
  - Fields have type `string`, are not required, and are readonly
- **Test vectors**: TV-AUD-001

### AUD-002
- **ID**: AUD-002
- **Priority**: P0
- **Statement**: On `insert` operations, the server MUST set `createdBy` to the current `actorId` from `namespaceProvider.getActorId()`.
- **Rationale**: Records who created the record.
- **Acceptance criteria**:
  - After insert with actorId "user:alice", `createdBy` is "user:alice"
  - Client-provided `createdBy` is stripped
- **Test vectors**: TV-AUD-002

### AUD-003
- **ID**: AUD-003
- **Priority**: P0
- **Statement**: On every mutation, the server MUST set `updatedBy` to the current `actorId`.
- **Rationale**: Records who last modified the record.
- **Acceptance criteria**:
  - After merge by "user:bob", `updatedBy` is "user:bob"
- **Test vectors**: TV-AUD-003

### AUD-004
- **ID**: AUD-004
- **Priority**: P0
- **Statement**: `createdBy` MUST NOT be modified after initial insert.
- **Rationale**: Creator identity is immutable.
- **Acceptance criteria**:
  - After any subsequent mutation, `createdBy` retains its original value
- **Test vectors**: TV-AUD-004

### AUD-005
- **ID**: AUD-005
- **Priority**: P1
- **Statement**: When `actorId` is unavailable (no `getActorId` configured or it returns undefined), audit fields MUST be set to `null` rather than causing an error.
- **Rationale**: Graceful degradation for development/testing without auth.
- **Acceptance criteria**:
  - Insert without actorId: `createdBy` is `null`, `updatedBy` is `null`
  - No error thrown
- **Test vectors**: TV-AUD-005

---

## Trash Capability

### TR-001
- **ID**: TR-001
- **Priority**: P0
- **Statement**: When `trash` capability is resolved, `trashedAt` (type: `date`, nullable) and `trashedBy` (type: `string`, nullable) fields MUST be injected.
- **Rationale**: Soft-delete metadata fields.
- **Acceptance criteria**:
  - Both fields exist in the effective schema for trash-enabled resources
  - Both fields are nullable (null when not trashed)
  - Both fields are readonly (server-managed)
- **Test vectors**: TV-TR-001

### TR-002
- **ID**: TR-002
- **Priority**: P0
- **Statement**: A new DFQL operation `trash` MUST be supported. When executed, the server MUST set `trashedAt` to current epoch ms and `trashedBy` to current actorId.
- **Rationale**: First-class trash operation replaces plugin-based approach.
- **Acceptance criteria**:
  - `{ resource: "todos", operation: "trash", id: "todo:1" }` succeeds
  - Record has `trashedAt` set to valid epoch ms, `trashedBy` set to actorId
  - Returns `{ ok: true, mutationId, affectedIds: ["todo:1"] }`
  - Operation fails with `DFQL_UNSUPPORTED` if trash capability not enabled
- **Test vectors**: TV-TR-002, TV-TR-002N

### TR-003
- **ID**: TR-003
- **Priority**: P0
- **Statement**: A new DFQL operation `restore` MUST be supported. When executed, the server MUST clear `trashedAt` and `trashedBy` to null.
- **Rationale**: Recovers a trashed record.
- **Acceptance criteria**:
  - `{ resource: "todos", operation: "restore", id: "todo:1" }` succeeds
  - Record has `trashedAt: null`, `trashedBy: null`
  - Operation fails with `DFQL_UNSUPPORTED` if trash capability not enabled
- **Test vectors**: TV-TR-003, TV-TR-003N

### TR-004
- **ID**: TR-004
- **Priority**: P0
- **Statement**: Queries on trash-enabled resources MUST automatically inject a filter excluding records where `trashedAt` is not null.
- **Rationale**: Trashed records should be invisible by default.
- **Acceptance criteria**:
  - A query without explicit trash filter returns only non-trashed records
  - A trashed record does not appear in default query results
  - The filter is injected server-side, not client-side
- **Test vectors**: TV-TR-004

### TR-005
- **ID**: TR-005
- **Priority**: P0
- **Statement**: When a query includes `metadata: { includeTrashed: true }`, the auto-filter for trashed records MUST be suppressed.
- **Rationale**: Users need to view/manage trashed records.
- **Acceptance criteria**:
  - Query with `includeTrashed: true` returns trashed records
  - Can combine with user filters to show only trashed: `{ trashedAt: { $ne: null } }`
- **Test vectors**: TV-TR-005

### TR-006
- **ID**: TR-006
- **Priority**: P1
- **Statement**: Trashing an already-trashed record MUST be idempotent, updating `trashedAt` and `trashedBy` to new values. Restoring a non-trashed record MUST be idempotent, returning `ok: true`.
- **Rationale**: Prevents errors from duplicate operations.
- **Acceptance criteria**:
  - Double-trash succeeds, updates timestamps
  - Restore on non-trashed record returns ok
- **Test vectors**: TV-TR-006

### TR-007
- **ID**: TR-007
- **Priority**: P1
- **Statement**: Hard `delete` operation on a trashed record MUST permanently remove it.
- **Rationale**: Users need to permanently delete trashed items.
- **Acceptance criteria**:
  - `delete` on a trashed record succeeds and removes the record
  - Record is gone from DB (not just hidden)
- **Test vectors**: TV-TR-007

### TR-008
- **ID**: TR-008
- **Priority**: P0
- **Statement**: `trash` and `restore` operations MUST record change tracking entries for sync.
- **Rationale**: Sync clients need to receive trash/restore state changes.
- **Acceptance criteria**:
  - After trash, a change entry with `op: "trash"` or `op: "merge"` is recorded
  - After restore, a change entry is recorded
  - Change entries include the full record state
- **Test vectors**: TV-TR-008

---

## Archivable Capability

### AR-001
- **ID**: AR-001
- **Priority**: P0
- **Statement**: When `archivable` capability is resolved, `isArchived` (type: `boolean`, default: `false`) field MUST be injected.
- **Rationale**: Archive flag field.
- **Acceptance criteria**:
  - Field exists in effective schema
  - Default value is `false`
  - Field is client-writable (not in readonly set)
- **Test vectors**: TV-AR-001

### AR-002
- **ID**: AR-002
- **Priority**: P0
- **Statement**: A new DFQL operation `archive` MUST be supported. When executed, the server MUST set `isArchived: true`.
- **Rationale**: First-class archive operation.
- **Acceptance criteria**:
  - `{ resource: "todos", operation: "archive", id: "todo:1" }` succeeds
  - Record has `isArchived: true`
  - Fails with `DFQL_UNSUPPORTED` if archivable not enabled
- **Test vectors**: TV-AR-002, TV-AR-002N

### AR-003
- **ID**: AR-003
- **Priority**: P0
- **Statement**: A new DFQL operation `unarchive` MUST be supported. When executed, the server MUST set `isArchived: false`.
- **Rationale**: Recovers an archived record.
- **Acceptance criteria**:
  - `{ resource: "todos", operation: "unarchive", id: "todo:1" }` succeeds
  - Record has `isArchived: false`
- **Test vectors**: TV-AR-003

### AR-004
- **ID**: AR-004
- **Priority**: P0
- **Statement**: Queries on archivable resources MUST automatically inject a filter excluding records where `isArchived` is true.
- **Rationale**: Archived records hidden by default.
- **Acceptance criteria**:
  - Default query excludes archived records
  - Filter injected server-side
- **Test vectors**: TV-AR-004

### AR-005
- **ID**: AR-005
- **Priority**: P0
- **Statement**: When a query includes `metadata: { includeArchived: true }`, the auto-filter for archived records MUST be suppressed.
- **Rationale**: Users need to view archived records.
- **Acceptance criteria**:
  - Query with `includeArchived: true` returns archived records
- **Test vectors**: TV-AR-005

### AR-006
- **ID**: AR-006
- **Priority**: P1
- **Statement**: `isArchived` MUST also be settable via direct `merge` operation (e.g., for bulk operations).
- **Rationale**: Backward compatibility and bulk archive use cases.
- **Acceptance criteria**:
  - `merge` with `{ isArchived: true }` archives the record
  - The record is then excluded from default queries
- **Test vectors**: TV-AR-006

### AR-007
- **ID**: AR-007
- **Priority**: P0
- **Statement**: `archive` and `unarchive` operations MUST record change tracking entries.
- **Rationale**: Sync propagation.
- **Acceptance criteria**:
  - Change entries recorded for archive/unarchive with record state
- **Test vectors**: TV-AR-007

---

## Shareable Capability

### SH-001
- **ID**: SH-001
- **Priority**: P0
- **Statement**: `shareable` capability MUST be declared with configuration: `{ shareable: { levels: AccessLevel[], default: "private" | "shared" } }`. `validateSchema()` MUST reject `shareable` without this configuration.
- **Rationale**: Shareable needs explicit configuration for access levels and default visibility.
- **Acceptance criteria**:
  - `capabilities: ["shareable"]` fails validation (missing config)
  - `capabilities: [{ shareable: { levels: ["viewer", "editor"], default: "private" } }]` passes
  - `levels` array must contain at least one level
  - `default` must be "private" or "shared"
- **Test vectors**: TV-SH-001, TV-SH-001N

### SH-002
- **ID**: SH-002
- **Priority**: P0
- **Statement**: For each resource with `shareable` enabled, a permissions table `__datafn_permissions_{resource}` MUST be auto-generated with columns: `__ns`, `id`, `resourceId`, `userId`, `level`, `grantedBy`, `grantedAt`.
- **Rationale**: Permissions data storage.
- **Acceptance criteria**:
  - Codegen generates the permissions table with correct schema
  - Table has composite primary key `(__ns, id)`
  - Table has unique index on `(__ns, resourceId, userId)` to prevent duplicate grants
  - Table has index on `(__ns, userId)` for query gating lookups
- **Test vectors**: TV-SH-002

### SH-003
- **ID**: SH-003
- **Priority**: P0
- **Statement**: A new DFQL operation `share` MUST be supported. It MUST insert or update a row in the permissions table with the specified `userId` and `level`.
- **Rationale**: Grants access to a record.
- **Acceptance criteria**:
  - `{ resource: "docs", operation: "share", id: "doc:1", shareWith: { userId: "user:alice", level: "editor" } }` creates a permissions entry
  - Re-sharing with different level updates the existing entry (upsert)
  - `grantedBy` set to current actorId, `grantedAt` set to current timestamp
  - Fails with `DFQL_UNSUPPORTED` if shareable not enabled
- **Test vectors**: TV-SH-003, TV-SH-003N

### SH-004
- **ID**: SH-004
- **Priority**: P0
- **Statement**: A new DFQL operation `unshare` MUST be supported. It MUST delete the permissions table entry for the specified `userId`.
- **Rationale**: Revokes access.
- **Acceptance criteria**:
  - `{ resource: "docs", operation: "unshare", id: "doc:1", shareWith: { userId: "user:alice" } }` removes the permissions entry
  - Unsharing a non-shared user is idempotent (ok: true)
  - Cannot unshare the creator (returns error)
- **Test vectors**: TV-SH-004, TV-SH-004N

### SH-005
- **ID**: SH-005
- **Priority**: P1
- **Statement**: A `getPermissions` query MUST be supported to retrieve all permission entries for a record.
- **Rationale**: UI needs to display who has access.
- **Acceptance criteria**:
  - Returns array of `{ userId, level, grantedBy, grantedAt }`
  - Only callable by users with owner access to the record
  - Returns empty array for records with no explicit shares
- **Test vectors**: TV-SH-005

### SH-006
- **ID**: SH-006
- **Priority**: P0
- **Statement**: When `shareable.default === "private"`, queries MUST be automatically filtered to return only records where the current actorId is the creator OR has a permissions table entry.
- **Rationale**: Private resources must not leak to unauthorized users.
- **Acceptance criteria**:
  - User A creates a record; User B cannot see it
  - User A shares with User B; User B can see it
  - After unshare, User B cannot see it again
  - Creator always sees their own records
- **Test vectors**: TV-SH-006

### SH-007
- **ID**: SH-007
- **Priority**: P0
- **Statement**: For shareable resources, mutations MUST be authorized based on access level: `viewer` cannot mutate, `editor` can mutate (merge/replace/archive/trash), `owner` can mutate + share/unshare + delete.
- **Rationale**: Access levels must mean something.
- **Acceptance criteria**:
  - Viewer attempting merge → FORBIDDEN
  - Editor merging → success
  - Editor attempting delete → FORBIDDEN
  - Owner deleting → success
  - Editor attempting share → FORBIDDEN
  - Owner sharing → success
- **Test vectors**: TV-SH-007, TV-SH-007N

### SH-008
- **ID**: SH-008
- **Priority**: P0
- **Statement**: The record creator (determined by `createdBy` from audit capability) MUST have implicit `owner` access without needing a permissions table entry.
- **Rationale**: Creator should always have full control.
- **Acceptance criteria**:
  - Creator can query, mutate, share, unshare, and delete their own records
  - No permissions table entry exists for the creator (implicit)
- **Test vectors**: TV-SH-008

### SH-009
- **ID**: SH-009
- **Priority**: P0
- **Statement**: Hard-deleting a record with shareable MUST cascade-delete all permissions entries for that record.
- **Rationale**: No orphaned permissions data.
- **Acceptance criteria**:
  - After deleting a shared record, no permissions entries remain for that record
  - Trash does NOT cascade permissions (they're preserved for restore)
- **Test vectors**: TV-SH-009

### SH-010
- **ID**: SH-010
- **Priority**: P0
- **Statement**: Only users with `owner` access level MUST be allowed to perform `share` and `unshare` operations.
- **Rationale**: Prevents unauthorized access granting.
- **Acceptance criteria**:
  - Non-owner attempting share → FORBIDDEN
  - Creator (implicit owner) sharing → success
  - Explicit owner sharing → success
- **Test vectors**: TV-SH-010

### SH-011
- **ID**: SH-011
- **Priority**: P0
- **Statement**: `shareable` capability MUST require `audit` capability on the same resource. `validateSchema()` MUST error if `shareable` is enabled without `audit`.
- **Rationale**: Shareable needs `createdBy` for ownership determination.
- **Acceptance criteria**:
  - Resource with `shareable` but no `audit` → validation error
  - Resource with both `shareable` and `audit` → valid
  - Global `audit` + resource `shareable` → valid
- **Test vectors**: TV-SH-011N

---

## Codegen

### CG-001
- **ID**: CG-001
- **Priority**: P0
- **Statement**: The Drizzle codegen MUST resolve capabilities for each resource and generate columns for all capability-injected fields.
- **Rationale**: Database tables must have the columns for capability fields.
- **Acceptance criteria**:
  - Resource with `timestamps` generates `createdAt` and `updatedAt` columns (bigint for epoch ms)
  - Resource with `audit` generates `createdBy` and `updatedBy` columns (text)
  - Resource with `trash` generates `trashedAt` (bigint, nullable) and `trashedBy` (text, nullable) columns
  - Resource with `archivable` generates `isArchived` (boolean, default false) column
  - Capability fields appear alongside user-defined fields
- **Test vectors**: TV-CG-001

### CG-002
- **ID**: CG-002
- **Priority**: P0
- **Statement**: The Drizzle codegen MUST generate a permissions table for each resource with `shareable` capability enabled.
- **Rationale**: Permissions table is the data store for sharing.
- **Acceptance criteria**:
  - Table name: `__datafn_permissions_{resource}`
  - Columns: `__ns` (text), `id` (text, PK), `resourceId` (text), `userId` (text), `level` (text), `grantedBy` (text), `grantedAt` (bigint)
  - Composite PK on `(__ns, id)`
  - Unique index on `(__ns, resourceId, userId)`
  - Index on `(__ns, userId)`
- **Test vectors**: TV-CG-002

### CG-003
- **ID**: CG-003
- **Priority**: P0
- **Statement**: Codegen MUST use the same `resolveCapabilities()` function as the server to ensure consistency.
- **Rationale**: Codegen and runtime must agree on what fields exist.
- **Acceptance criteria**:
  - `resolveCapabilities` is exported from `@datafn/core` and imported by both server and CLI
  - Same input schema produces same resolved capabilities in both
- **Test vectors**: TV-CG-003

---

## Client API

### CL-001
- **ID**: CL-001
- **Priority**: P0
- **Statement**: The client MUST expose a `.trash(id)` method on table objects for resources with `trash` capability.
- **Rationale**: Ergonomic client API for soft-delete.
- **Acceptance criteria**:
  - `table.trash("todo:1")` sends `{ operation: "trash", id: "todo:1" }` to server
  - Returns mutation result
  - Method not available when trash capability not enabled
- **Test vectors**: TV-CL-001

### CL-002
- **ID**: CL-002
- **Priority**: P0
- **Statement**: The client MUST expose a `.restore(id)` method for trash-enabled resources.
- **Rationale**: Recovery from soft-delete.
- **Acceptance criteria**:
  - `table.restore("todo:1")` sends `{ operation: "restore", id: "todo:1" }`
- **Test vectors**: TV-CL-002

### CL-003
- **ID**: CL-003
- **Priority**: P0
- **Statement**: The client MUST expose an `.archive(id)` method for archivable resources.
- **Rationale**: Ergonomic archive API.
- **Acceptance criteria**:
  - `table.archive("todo:1")` sends `{ operation: "archive", id: "todo:1" }`
- **Test vectors**: TV-CL-003

### CL-004
- **ID**: CL-004
- **Priority**: P0
- **Statement**: The client MUST expose an `.unarchive(id)` method for archivable resources.
- **Rationale**: Recovery from archive.
- **Acceptance criteria**:
  - `table.unarchive("todo:1")` sends `{ operation: "unarchive", id: "todo:1" }`
- **Test vectors**: TV-CL-004

### CL-005
- **ID**: CL-005
- **Priority**: P0
- **Statement**: The client MUST expose a `.share(id, userId, level)` method for shareable resources.
- **Rationale**: Ergonomic sharing API.
- **Acceptance criteria**:
  - `table.share("doc:1", "user:alice", "editor")` sends the share DFQL operation
- **Test vectors**: TV-CL-005

### CL-006
- **ID**: CL-006
- **Priority**: P0
- **Statement**: The client MUST expose an `.unshare(id, userId)` method for shareable resources.
- **Rationale**: Revoke access.
- **Acceptance criteria**:
  - `table.unshare("doc:1", "user:alice")` sends the unshare DFQL operation
- **Test vectors**: TV-CL-006

### CL-007
- **ID**: CL-007
- **Priority**: P1
- **Statement**: The client MUST expose a `.getPermissions(id)` method for shareable resources.
- **Rationale**: View who has access.
- **Acceptance criteria**:
  - Returns array of permission entries
- **Test vectors**: TV-CL-007

### CL-008
- **ID**: CL-008
- **Priority**: P0
- **Statement**: The existing `.delete(id)` method MUST continue to perform hard delete regardless of capabilities.
- **Rationale**: Hard delete is always available as an escape hatch.
- **Acceptance criteria**:
  - `table.delete("todo:1")` permanently removes the record
  - Works on both trashed and non-trashed records
- **Test vectors**: TV-CL-008

### CL-009
- **ID**: CL-009
- **Priority**: P2
- **Statement**: `createSoftDeletePlugin` and plugin-based soft-delete docs MUST be removed in favor of capability-based `trash`/`restore`.
- **Rationale**: Capability lifecycle is the single supported soft-delete model.
- **Acceptance criteria**:
  - `@datafn/client` no longer exports `createSoftDeletePlugin`, `restore`, or `SoftDeleteConfig`
  - `client/src/plugins/softDelete.ts` and plugin-specific tests are removed
  - Docs no longer include `/documentation/plugins/soft-delete` page or related cross-links
- **Test vectors**: TV-CL-009

---

## Sync

### SY-001
- **ID**: SY-001
- **Priority**: P0
- **Statement**: The push path MUST inject capability fields (timestamps, audit) before executing mutations, just like the mutation route.
- **Rationale**: Sync-originated mutations need the same auto-injection.
- **Acceptance criteria**:
  - Push mutations on timestamps-enabled resources get `createdAt`/`updatedAt` set
  - Push mutations on audit-enabled resources get `createdBy`/`updatedBy` set
- **Test vectors**: TV-SY-001

### SY-002
- **ID**: SY-002
- **Priority**: P0
- **Statement**: Push validation MUST accept the new DFQL operations (`trash`, `restore`, `archive`, `unarchive`, `share`, `unshare`).
- **Rationale**: Clients may push these operations via sync.
- **Acceptance criteria**:
  - Push with `operation: "trash"` validates and executes
  - Invalid operations still rejected
- **Test vectors**: TV-SY-002

### SY-003
- **ID**: SY-003
- **Priority**: P0
- **Statement**: All new operations MUST record change tracking entries suitable for pull sync.
- **Rationale**: Other clients need to receive these state changes.
- **Acceptance criteria**:
  - Change entry includes the operation type and full record state
  - Pull clients receive trash/restore/archive/unarchive changes
- **Test vectors**: TV-SY-003

---

## Validation

### VA-001
- **ID**: VA-001
- **Priority**: P0
- **Statement**: `validateSchema()` MUST validate the `capabilities` field on both schema and resource levels, rejecting invalid capability names and configurations.
- **Rationale**: Catch configuration errors early.
- **Acceptance criteria**:
  - `capabilities: ["invalid"]` → validation error
  - `capabilities: [{ shareable: {} }]` → validation error (missing config)
  - `capabilities: ["timestamps", "timestamps"]` → deduplication (not error)
- **Test vectors**: TV-VA-001, TV-VA-001N

### VA-002
- **ID**: VA-002
- **Priority**: P0
- **Statement**: Mutation validation MUST accept the new operations (`trash`, `restore`, `archive`, `unarchive`, `share`, `unshare`) and MUST reject them on resources where the corresponding capability is not enabled.
- **Rationale**: Operations are only valid when the capability is active.
- **Acceptance criteria**:
  - `operation: "trash"` on a resource without trash → `DFQL_UNSUPPORTED` error
  - `operation: "archive"` on a resource with archivable → valid
  - `operation: "share"` validates presence of `shareWith` field
- **Test vectors**: TV-VA-002, TV-VA-002N

### VA-003
- **ID**: VA-003
- **Priority**: P1
- **Statement**: Authorization validation MUST be updated to handle capability-injected fields correctly: readonly capability fields allowed in read policies, excluded from write validation.
- **Rationale**: Capability fields have special authz rules.
- **Acceptance criteria**:
  - Capability fields are readable without being in `permissions.read.fields` (they're always readable)
  - Readonly capability fields are not required in `permissions.write.fields`
  - `isArchived` respects the resource's write policy
- **Test vectors**: TV-VA-003

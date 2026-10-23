# TEST VECTORS

## Capability Types & Resolution

### TV-CAP-001: Valid capability declarations
- **Description**: Schema with various valid capability declarations compiles and validates
- **Input**:
  ```json
  {
    "capabilities": ["timestamps", "audit", "trash"],
    "resources": [
      {
        "name": "todos",
        "version": 1,
        "capabilities": ["archivable"],
        "fields": [{ "name": "text", "type": "string", "required": true }]
      },
      {
        "name": "docs",
        "version": 1,
        "capabilities": [
          "archivable",
          { "shareable": { "levels": ["viewer", "editor", "owner"], "default": "private" } }
        ],
        "fields": [{ "name": "title", "type": "string", "required": true }]
      }
    ]
  }
  ```
- **Expected**: `validateSchema()` succeeds; no errors

### TV-CAP-001N: Invalid capability name
- **Input**: `{ "capabilities": ["invalid_cap"], "resources": [...] }`
- **Expected**: Validation error with code `INVALID_CAPABILITY`, message contains "invalid_cap"

### TV-CAP-002: Capability resolution merging
- **Description**: Global + resource capabilities merge correctly
- **Input**: Global `["timestamps", "audit"]`, Resource `["trash"]`
- **Expected**: Resolved = `["timestamps", "audit", "trash"]`

### TV-CAP-002N: Capability resolution with exclusion
- **Input**: Global `["timestamps", "audit", "trash"]`, Resource `{ exclude: ["trash"] }`
- **Expected**: Resolved = `["timestamps", "audit"]`

### TV-CAP-003: Capability field injection
- **Description**: Resolved capabilities inject fields into effective schema
- **Input**: Resource with resolved `["timestamps", "audit"]` and user field `[{ name: "text", type: "string" }]`
- **Expected**: Effective fields = `["text", "createdAt", "updatedAt", "createdBy", "updatedBy"]`

### TV-CAP-004N: Capability field collision
- **Input**:
  ```json
  {
    "capabilities": ["timestamps"],
    "resources": [{
      "name": "todos",
      "version": 1,
      "fields": [
        { "name": "text", "type": "string", "required": true },
        { "name": "createdAt", "type": "date", "required": true }
      ]
    }]
  }
  ```
- **Expected**: Validation error: `CAPABILITY_FIELD_COLLISION`, message: `Field "createdAt" on resource "todos" collides with capability-injected field from "timestamps"`

### TV-CAP-005N: SYSTEM_FIELDS import removed
- **Description**: Importing SYSTEM_FIELDS from @datafn/core fails
- **Input**: `import { SYSTEM_FIELDS } from "@datafn/core"`
- **Expected**: TypeScript/runtime error — export does not exist

### TV-CAP-006: Global capabilities apply to all resources
- **Input**: Global `["timestamps"]`, Resource A has no `capabilities` field, Resource B has `capabilities: ["audit"]`
- **Expected**: Resource A resolved = `["timestamps"]`, Resource B resolved = `["timestamps", "audit"]`

### TV-CAP-007: Readonly field stripping
- **Input**: Insert mutation on timestamps-enabled resource with record `{ text: "hello", createdAt: 999, updatedAt: 888 }`
- **Expected**: `createdAt` and `updatedAt` stripped from record before DB write; server-set values used instead

### TV-CAP-007N: isArchived NOT stripped
- **Input**: Merge mutation on archivable resource with record `{ isArchived: true }`
- **Expected**: `isArchived: true` is preserved in DB write (not stripped)

---

## Timestamps

### TV-TS-001: Timestamps fields injected
- **Input**: Resource with `timestamps` capability, no user-defined `createdAt`/`updatedAt`
- **Expected**: Schema index includes `createdAt` (date) and `updatedAt` (date) fields

### TV-TS-002: createdAt set on insert
- **Input**: `{ resource: "todos", operation: "insert", id: "todo:1", record: { text: "hello" } }` (timestamps enabled)
- **Expected**: Stored record has `createdAt` = epoch ms (within 1000ms of current time)

### TV-TS-003: updatedAt set on every mutation
- **Input**: Insert, then merge `{ record: { text: "updated" } }` on same record
- **Expected**: `updatedAt` after merge > `updatedAt` after insert

### TV-TS-004: createdAt immutable
- **Input**: Insert (createdAt = T1), then merge with different data (createdAt should not change)
- **Expected**: After merge, `createdAt` still equals T1

---

## Audit

### TV-AUD-001: Audit fields injected
- **Input**: Resource with `audit` capability
- **Expected**: Schema index includes `createdBy` (string) and `updatedBy` (string)

### TV-AUD-002: createdBy set on insert
- **Input**: Insert with actorId = "user:alice"
- **Expected**: `createdBy` = "user:alice"

### TV-AUD-003: updatedBy set on merge
- **Input**: Insert by "user:alice", then merge by "user:bob"
- **Expected**: `updatedBy` = "user:bob", `createdBy` = "user:alice"

### TV-AUD-004: createdBy immutable
- **Input**: Insert by "user:alice", then merge by "user:bob"
- **Expected**: `createdBy` still "user:alice"

### TV-AUD-005: Audit without actorId
- **Input**: Insert on audit-enabled resource, no actorId configured
- **Expected**: `createdBy` = null, `updatedBy` = null, no error thrown

---

## Trash

### TV-TR-001: Trash fields injected
- **Input**: Resource with `trash` capability
- **Expected**: Schema index includes `trashedAt` (date, nullable) and `trashedBy` (string, nullable)

### TV-TR-002: Trash operation
- **Input**: `{ resource: "todos", operation: "trash", id: "todo:1" }` (actorId = "user:alice")
- **Expected**: `{ ok: true, mutationId: "...", affectedIds: ["todo:1"] }`, record has `trashedAt` = epoch ms, `trashedBy` = "user:alice"

### TV-TR-002N: Trash on non-trash resource
- **Input**: `{ resource: "audit_logs", operation: "trash", id: "log:1" }` (trash not enabled)
- **Expected**: `{ ok: false, errors: [{ code: "DFQL_UNSUPPORTED", message: "..." }] }`

### TV-TR-003: Restore operation
- **Input**: Trash "todo:1", then `{ resource: "todos", operation: "restore", id: "todo:1" }`
- **Expected**: `{ ok: true }`, record has `trashedAt` = null, `trashedBy` = null

### TV-TR-003N: Restore on non-trash resource
- **Input**: `{ resource: "audit_logs", operation: "restore", id: "log:1" }`
- **Expected**: `{ ok: false, errors: [{ code: "DFQL_UNSUPPORTED" }] }`

### TV-TR-004: Auto-filter excludes trashed records
- **Input**: Insert 3 todos, trash 1, query all todos (no explicit filter)
- **Expected**: Query returns 2 records (trashed one excluded)

### TV-TR-005: includeTrashed overrides auto-filter
- **Input**: Same as TV-TR-004, but query with `metadata: { includeTrashed: true }`
- **Expected**: Query returns 3 records (including trashed)

### TV-TR-006: Trash idempotency
- **Input**: Trash "todo:1" twice
- **Expected**: Both succeed with `ok: true`, second updates `trashedAt`/`trashedBy`

### TV-TR-007: Hard delete on trashed record
- **Input**: Trash "todo:1", then delete "todo:1"
- **Expected**: Record permanently removed from DB

### TV-TR-008: Trash change tracking
- **Input**: Trash "todo:1"
- **Expected**: Change tracking entry recorded with operation and full record state

---

## Archivable

### TV-AR-001: isArchived field injected
- **Input**: Resource with `archivable` capability
- **Expected**: Schema index includes `isArchived` (boolean, default: false)

### TV-AR-002: Archive operation
- **Input**: `{ resource: "todos", operation: "archive", id: "todo:1" }`
- **Expected**: `{ ok: true }`, record has `isArchived: true`

### TV-AR-002N: Archive on non-archivable resource
- **Input**: `{ resource: "logs", operation: "archive", id: "log:1" }`
- **Expected**: `{ ok: false, errors: [{ code: "DFQL_UNSUPPORTED" }] }`

### TV-AR-003: Unarchive operation
- **Input**: Archive "todo:1", then `{ operation: "unarchive", id: "todo:1" }`
- **Expected**: `{ ok: true }`, record has `isArchived: false`

### TV-AR-004: Auto-filter excludes archived records
- **Input**: Insert 3 todos, archive 1, query all todos
- **Expected**: Query returns 2 records

### TV-AR-005: includeArchived overrides auto-filter
- **Input**: Same as TV-AR-004, query with `metadata: { includeArchived: true }`
- **Expected**: Query returns 3 records

### TV-AR-006: isArchived via direct merge
- **Input**: `{ operation: "merge", id: "todo:1", record: { isArchived: true } }`
- **Expected**: Record archived; excluded from default queries

### TV-AR-007: Archive change tracking
- **Input**: Archive "todo:1"
- **Expected**: Change tracking entry recorded

---

## Shareable

### TV-SH-001: Valid shareable config
- **Input**: `capabilities: [{ shareable: { levels: ["viewer", "editor", "owner"], default: "private" } }]`
- **Expected**: Validates successfully

### TV-SH-001N: Invalid shareable (string form)
- **Input**: `capabilities: ["shareable"]`
- **Expected**: Validation error: `INVALID_CAPABILITY_CONFIG`, shareable requires configuration

### TV-SH-002: Permissions table generated
- **Input**: Resource "docs" with shareable enabled, run Drizzle codegen
- **Expected**: Generated schema includes `__datafn_permissions_docs` table with columns: `__ns`, `id`, `resourceId`, `userId`, `level`, `grantedBy`, `grantedAt`

### TV-SH-003: Share operation
- **Input**: `{ resource: "docs", operation: "share", id: "doc:1", shareWith: { userId: "user:alice", level: "editor" } }` (actorId = "user:bob", creator)
- **Expected**: `{ ok: true }`, permissions table has entry `(doc:1, user:alice, editor, user:bob, <timestamp>)`

### TV-SH-003N: Share on non-shareable resource
- **Input**: `{ resource: "todos", operation: "share", id: "todo:1", shareWith: {...} }` (no shareable)
- **Expected**: `{ ok: false, errors: [{ code: "DFQL_UNSUPPORTED" }] }`

### TV-SH-004: Unshare operation
- **Input**: Share doc:1 with alice, then `{ operation: "unshare", id: "doc:1", shareWith: { userId: "user:alice" } }`
- **Expected**: `{ ok: true }`, permissions entry removed

### TV-SH-004N: Cannot unshare creator
- **Input**: `{ operation: "unshare", id: "doc:1", shareWith: { userId: "user:bob" } }` where user:bob is the creator
- **Expected**: `{ ok: false, errors: [{ code: "FORBIDDEN", message: "Cannot unshare the record creator" }] }`

### TV-SH-005: getPermissions query
- **Input**: Share doc:1 with alice(editor) and charlie(viewer), then getPermissions("doc:1")
- **Expected**: `[{ userId: "user:alice", level: "editor", grantedBy: "user:bob", grantedAt: ... }, { userId: "user:charlie", level: "viewer", ... }]`

### TV-SH-006: Private query gating
- **Input**: User:bob creates doc:1, User:alice queries docs (no share)
- **Expected**: alice's query returns 0 results; after share → alice sees doc:1

### TV-SH-007: Mutation authorization by access level
- **Input (editor merge)**: user:alice (editor) merges doc:1 → `{ ok: true }`
- **Input (viewer merge)**: user:charlie (viewer) merges doc:1 → `{ ok: false, code: "FORBIDDEN" }`

### TV-SH-007N: Non-owner cannot share
- **Input**: user:alice (editor) attempts share → `{ ok: false, code: "FORBIDDEN" }`

### TV-SH-008: Creator implicit owner
- **Input**: user:bob creates doc:1 (no permissions entry for bob)
- **Expected**: bob can query, mutate, share, delete doc:1

### TV-SH-009: Cascading permission delete
- **Input**: Share doc:1 with alice and charlie, then hard delete doc:1
- **Expected**: All permissions entries for doc:1 are removed

### TV-SH-010: Owner-only share authorization
- **Input**: user:alice (editor) attempts `operation: "share"` → `{ ok: false, code: "FORBIDDEN" }`

### TV-SH-011N: Shareable without audit
- **Input**: Resource with `capabilities: [{ shareable: {...} }]` but no audit
- **Expected**: Validation error: `CAPABILITY_DEPENDENCY`, message: `"shareable" capability requires "audit" capability`

---

## Codegen

### TV-CG-001: Drizzle codegen with capabilities
- **Input**: Resource "todos" with capabilities `["timestamps", "audit", "trash", "archivable"]`
- **Expected**: Generated Drizzle schema includes:
  ```typescript
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  createdBy: text("created_by"),
  updatedBy: text("updated_by"),
  trashedAt: bigint("trashed_at", { mode: "number" }),
  trashedBy: text("trashed_by"),
  isArchived: boolean("is_archived").notNull().default(false),
  ```

### TV-CG-002: Drizzle codegen permissions table
- **Input**: Resource "docs" with shareable capability
- **Expected**: Generated schema includes `__datafn_permissions_docs` table

### TV-CG-003: Codegen and server use same resolution
- **Input**: Same schema processed by codegen and server
- **Expected**: Both produce identical effective fields for each resource

---

## Sync

### TV-SY-001: Push with capability injection
- **Input**: Push insert mutation on timestamps-enabled resource (no createdAt in record)
- **Expected**: Stored record has server-set `createdAt` and `updatedAt`

### TV-SY-002: Push with new operations
- **Input**: Push with `operation: "trash"` on trash-enabled resource
- **Expected**: Mutation accepted and executed, record trashed

### TV-SY-003: Change tracking for new operations
- **Input**: Trash operation via push
- **Expected**: Change entry recorded, available via pull

---

## Client

### TV-CL-001: Client trash method
- **Input**: `table.trash("todo:1")`
- **Expected**: Sends `{ resource: "todos", operation: "trash", id: "todo:1" }` to server

### TV-CL-002: Client restore method
- **Input**: `table.restore("todo:1")`
- **Expected**: Sends `{ resource: "todos", operation: "restore", id: "todo:1" }`

### TV-CL-003: Client archive method
- **Input**: `table.archive("todo:1")`
- **Expected**: Sends `{ resource: "todos", operation: "archive", id: "todo:1" }`

### TV-CL-004: Client unarchive method
- **Input**: `table.unarchive("todo:1")`
- **Expected**: Sends `{ resource: "todos", operation: "unarchive", id: "todo:1" }`

### TV-CL-005: Client share method
- **Input**: `table.share("doc:1", "user:alice", "editor")`
- **Expected**: Sends `{ resource: "docs", operation: "share", id: "doc:1", shareWith: { userId: "user:alice", level: "editor" } }`

### TV-CL-006: Client unshare method
- **Input**: `table.unshare("doc:1", "user:alice")`
- **Expected**: Sends `{ resource: "docs", operation: "unshare", id: "doc:1", shareWith: { userId: "user:alice" } }`

### TV-CL-007: Client getPermissions method
- **Input**: `table.getPermissions("doc:1")`
- **Expected**: Returns array of permission entries

### TV-CL-008: Client delete (hard)
- **Input**: `table.delete("todo:1")` on trash-enabled resource
- **Expected**: Permanently removes record (hard delete, not trash)

### TV-CL-009: Deprecated soft delete plugin warning
- **Input**: `createSoftDeletePlugin({ resources: ["todos"] })`
- **Expected**: Console warning: "createSoftDeletePlugin is deprecated. Use the 'trash' capability instead."

---

## Validation

### TV-VA-001: Valid capability names
- **Input**: `capabilities: ["timestamps", "audit", "trash", "archivable"]`
- **Expected**: All valid, no errors

### TV-VA-001N: Invalid capability name
- **Input**: `capabilities: ["softDelete"]`
- **Expected**: Error: `INVALID_CAPABILITY`, unknown capability "softDelete"

### TV-VA-002: New operations validated against capabilities
- **Input**: `{ operation: "trash", resource: "todos" }` where todos has trash capability
- **Expected**: Validation passes

### TV-VA-002N: Operation without capability
- **Input**: `{ operation: "archive", resource: "logs" }` where logs has no archivable
- **Expected**: Error: `DFQL_UNSUPPORTED`

### TV-VA-003: Capability fields in authz
- **Input**: Query selecting `createdAt` on timestamps-enabled resource (not in explicit read.fields)
- **Expected**: Allowed (capability fields are always readable)

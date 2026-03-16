# DataFn Sharing & Namespacing Sufficiency Analysis
Date: 2026-03-11  
Agent: Claude Opus 4.6 - Max (Cursor extension)

---
## Executive Summary

DataFn provides a **solid foundation** with row-level namespace isolation, per-record sharing (user-to-user), and field-level authorization. However, the current implementation has **5 critical gaps** that make it **insufficient as-is** for the full set of use cases listed. The gaps are: no group/team sharing primitives, no cross-namespace sharing, no permission inheritance, no public/link sharing, and no hierarchical permission model. Below is a detailed case-by-case analysis.

---

## Current DataFn Capabilities (What Exists)

| Capability | Status | Details |
|---|---|---|
| Row-level namespace isolation | Complete | `__ns` column, server-derived, composable via `ns()` |
| Per-record sharing | Complete | `shareable` capability with `share(id, userId, level)` |
| Access levels | Complete | `viewer` (read), `editor` (modify), `owner` (full control) |
| Field-level authorization | Complete | Declarative read/write field policies, deny-by-default |
| Private-by-default auto-filtering | Complete | `shareable.default: "private"` injects `WHERE id IN (accessIds)` |
| Audit trail | Complete | `createdBy`, `updatedBy`, `grantedBy`, `grantedAt` |
| 7-layer security pipeline | Complete | Rate limit → payload → JSON → authz → schema → field-authz → namespace |
| Namespace switching | Complete | `client.switchContext()` for runtime namespace changes |

---

## How the Current Shareable Capability Works (End-to-End)

### Schema Declaration

```typescript
const schema = defineSchema({
  capabilities: ["timestamps", "audit"],  // audit is REQUIRED for shareable
  resources: [
    {
      name: "documents",
      version: 1,
      capabilities: [{
        shareable: {
          levels: ["viewer", "editor", "owner"],
          default: "private",  // or "shared"
        }
      }],
      fields: [
        { name: "title", type: "string", required: true },
        { name: "content", type: "string" },
      ],
      permissions: {
        read: { fields: ["title", "content", "createdAt", "createdBy"] },
        write: { fields: ["title", "content"] },
      },
    },
  ],
});
```

### Internal Storage

Shareable does NOT add columns to the resource table. Instead, it creates a separate internal permissions table:

```
Table: __datafn_permissions_documents
{
  id:          "doc:123:user:alice"     // composite key: resourceId:userId
  resourceId:  "doc:123"               // which record
  userId:      "user:alice"            // who it's shared with
  level:       "editor"                // viewer | editor | owner
  grantedBy:   "user:bob"             // who performed the share
  grantedAt:   1710000000000           // timestamp
}
```

### Client API Surface

The shareable capability gates three additional methods on the client table:

```typescript
const docs = client.table("documents");

// Share a record with another user
await docs.share("doc:123", "user:alice", "editor");

// Remove a user's access
await docs.unshare("doc:123", "user:alice");

// List all permissions (owner-only)
const perms = await docs.getPermissions("doc:123");
// → [{ userId: "user:alice", level: "editor", grantedBy: "user:bob", grantedAt: 1710000000000 }]
```

### Share Operation: Step-by-Step DB Calls

When `docs.share("doc:123", "user:alice", "editor")` is called:

```
Client                              Server
  │                                   │
  │  POST /datafn/mutation            │
  │  { resource: "documents",         │
  │    operation: "share",            │
  │    id: "doc:123",                 │
  │    shareWith: {                   │
  │      userId: "user:alice",        │
  │      level: "editor"             │
  │    }                              │
  │  }                                │
  │ ─────────────────────────────────►│
  │                                   │
  │                    ┌──────────────────────────────────────────┐
  │                    │  LAYER 1-3: Rate limit, payload, parse  │
  │                    └──────────────────────────────────────────┘
  │                                   │
  │                    ┌──────────────────────────────────────────┐
  │                    │  LAYER 4: authorize(ctx, "mutation", _)  │
  │                    │  → Application-level auth check          │
  │                    └──────────────────────────────────────────┘
  │                                   │
  │                    ┌──────────────────────────────────────────┐
  │                    │  LAYER 5: Schema validation              │
  │                    │  → "documents" exists, shareable enabled │
  │                    └──────────────────────────────────────────┘
  │                                   │
  │                    ┌──────────────────────────────────────────┐
  │                    │  executeShare() begins                   │
  │                    │                                          │
  │                    │  DB CALL 1: Fetch the record             │
  │                    │  db.findOne({                            │
  │                    │    model: "documents",                   │
  │                    │    where: [{ field: "id",                │
  │                    │              operator: "eq",             │
  │                    │              value: "doc:123" }],        │
  │                    │    namespace: "user:bob"                 │
  │                    │  })                                      │
  │                    │  → Returns record, checks createdBy      │
  │                    │                                          │
  │                    │  If createdBy !== actorId:               │
  │                    │  DB CALL 2: Check explicit owner perm   │
  │                    │  db.findMany({                           │
  │                    │    model: "__datafn_permissions_documents",│
  │                    │    where: [{ field: "resourceId",        │
  │                    │              operator: "eq",             │
  │                    │              value: "doc:123" }],        │
  │                    │    namespace: "user:bob"                 │
  │                    │  })                                      │
  │                    │  → Must find entry with                  │
  │                    │    userId=actorId AND level="owner"      │
  │                    │                                          │
  │                    │  DB CALL 3: Load existing permissions    │
  │                    │  db.findMany({                           │
  │                    │    model: "__datafn_permissions_documents",│
  │                    │    where: [{ field: "resourceId",        │
  │                    │              operator: "eq",             │
  │                    │              value: "doc:123" }],        │
  │                    │    namespace: "user:bob"                 │
  │                    │  })                                      │
  │                    │  → Check if user:alice already has entry │
  │                    │                                          │
  │                    │  DB CALL 4a (if exists): Update perm     │
  │                    │  db.update({                             │
  │                    │    model: "__datafn_permissions_documents",│
  │                    │    where: [{ field: "id",                │
  │                    │              operator: "eq",             │
  │                    │              value: "doc:123:user:alice"}],│
  │                    │    data: { level: "editor",              │
  │                    │            grantedBy: "user:bob",        │
  │                    │            grantedAt: 1710000000000 },   │
  │                    │    namespace: "user:bob"                 │
  │                    │  })                                      │
  │                    │                                          │
  │                    │  DB CALL 4b (if new): Create perm        │
  │                    │  db.create({                             │
  │                    │    model: "__datafn_permissions_documents",│
  │                    │    data: {                               │
  │                    │      id: "doc:123:user:alice",           │
  │                    │      resourceId: "doc:123",              │
  │                    │      userId: "user:alice",               │
  │                    │      level: "editor",                    │
  │                    │      grantedBy: "user:bob",              │
  │                    │      grantedAt: 1710000000000            │
  │                    │    },                                    │
  │                    │    namespace: "user:bob"                 │
  │                    │  })                                      │
  │                    └──────────────────────────────────────────┘
  │                                   │
  │  ◄──── 200 OK { permissionRecord } │
```

**Total DB calls for a share operation:**
- **2-3 calls** if the actor IS the creator (skip owner permission lookup)
- **3-4 calls** if the actor is NOT the creator (needs explicit owner check)

### Query with Private Shareable: Step-by-Step DB Calls

When `docs.query({ filters: { title: { $contains: "report" } } })` is called on a `shareable.default: "private"` resource:

```
Client                              Server
  │                                   │
  │  POST /datafn/query               │
  │  { resource: "documents",         │
  │    filters: { title:              │
  │      { $contains: "report" } } }  │
  │ ─────────────────────────────────►│
  │                                   │
  │                    ┌──────────────────────────────────────────┐
  │                    │  LAYERS 1-6: Standard validation         │
  │                    └──────────────────────────────────────────┘
  │                                   │
  │                    ┌──────────────────────────────────────────┐
  │                    │  resolveShareableAccessIds()             │
  │                    │                                          │
  │                    │  TWO PARALLEL DB CALLS:                  │
  │                    │                                          │
  │                    │  DB CALL A: Records I created            │
  │                    │  db.findMany({                           │
  │                    │    model: "documents",                   │
  │                    │    where: [{ field: "createdBy",         │
  │                    │              operator: "eq",             │
  │                    │              value: "user:bob" }],       │
  │                    │    namespace: "user:bob"                 │
  │                    │  })                                      │
  │                    │  → Returns [doc:1, doc:3, doc:7, ...]    │
  │                    │                                          │
  │                    │  DB CALL B: Records shared with me       │
  │                    │  db.findMany({                           │
  │                    │    model: "__datafn_permissions_documents",│
  │                    │    where: [{ field: "userId",            │
  │                    │              operator: "eq",             │
  │                    │              value: "user:bob" }],       │
  │                    │    namespace: "user:bob"                 │
  │                    │  })                                      │
  │                    │  → Returns [{ resourceId: "doc:42" }]    │
  │                    │                                          │
  │                    │  Merge: accessIds = [doc:1, doc:3,       │
  │                    │                      doc:7, doc:42]      │
  │                    └──────────────────────────────────────────┘
  │                                   │
  │                    ┌──────────────────────────────────────────┐
  │                    │  injectCapabilityAutoFilters()           │
  │                    │                                          │
  │                    │  Original: { title: { $contains: ... } } │
  │                    │  Injected: { $and: [                     │
  │                    │    { title: { $contains: "report" } },   │
  │                    │    { id: { $in: ["doc:1","doc:3",        │
  │                    │                  "doc:7","doc:42"] } },  │
  │                    │    { trashedAt: { $in: [null] } }        │
  │                    │  ]}                                      │
  │                    └──────────────────────────────────────────┘
  │                                   │
  │                    ┌──────────────────────────────────────────┐
  │                    │  DB CALL C: Execute the actual query     │
  │                    │  db.findMany({                           │
  │                    │    model: "documents",                   │
  │                    │    where: [converted auto-filters],      │
  │                    │    namespace: "user:bob"                 │
  │                    │  })                                      │
  │                    └──────────────────────────────────────────┘
  │                                   │
  │  ◄──── 200 OK { data: [...] }     │
```

**Total DB calls for a query on a private shareable resource:**
- **3 calls**: 2 parallel (owned records + permission entries) + 1 actual query

**Performance concern:** The `resolveShareableAccessIds` function fetches ALL records where `createdBy === actorId` just to get their IDs. For users with thousands of records, this becomes a full table scan returning all owned record IDs before the actual query even runs.

### Mutation Access Control on Shared Records

When user:alice (an editor) tries to modify a shared record:

```
  │                    ┌──────────────────────────────────────────┐
  │                    │  resolveAccessLevel()                    │
  │                    │                                          │
  │                    │  DB CALL 1: Fetch the record             │
  │                    │  → Check createdBy === actorId?          │
  │                    │  → If yes: return "owner"                │
  │                    │                                          │
  │                    │  DB CALL 2: Check permissions table      │
  │                    │  db.findOne({                            │
  │                    │    model: "__datafn_permissions_documents",│
  │                    │    where: [{ field: "id",                │
  │                    │              operator: "eq",             │
  │                    │              value: "doc:123:user:alice"}],│
  │                    │    namespace: ...                        │
  │                    │  })                                      │
  │                    │  → Returns { level: "editor" }           │
  │                    │                                          │
  │                    │  Access level enforcement:               │
  │                    │  • owner  → ALL operations allowed       │
  │                    │  • editor → merge/insert OK,             │
  │                    │             delete/share/unshare DENIED  │
  │                    │  • viewer → ALL mutations DENIED         │
  │                    │  • null   → FORBIDDEN                    │
  │                    └──────────────────────────────────────────┘
```

### Delete Cascade (Permission Cleanup)

When deleting a record that has share permissions:

```typescript
// From execute.ts — when a shareable record is deleted:
if (hasShareableCapability(resolvedCapabilities)) {
  // DB CALL: Find all permission entries for this record
  const permissionRows = await db.findMany({
    model: "__datafn_permissions_documents",
    where: [{ field: "resourceId", operator: "eq", value: "doc:123" }],
    namespace,
  });
  // DB CALL per entry: Delete each permission
  for (const row of permissionRows) {
    await db.delete({
      model: "__datafn_permissions_documents",
      where: [{ field: "id", operator: "eq", value: row.id }],
      namespace,
    });
  }
}
```

**Total DB calls:** 1 (find permissions) + N (delete each). If shared with 5 users = 6 DB calls for cleanup alone.

### Key Observations

1. **All permissions live in the same namespace as the resource** — this means cross-namespace sharing is architecturally impossible without changes
2. **Access ID resolution is eager** — fetches ALL owned record IDs before every query (potential scaling issue)
3. **No batching on permission cleanup** — deletes are sequential, one per shared user
4. **Permission checks on mutations add 1-2 extra DB calls per operation**
5. **`shareable.default: "shared"` skips the access ID resolution entirely** — queries return all records in the namespace (no per-record filtering)

---

## Case-by-Case Analysis

### Memotron

| Use Case | Feasibility | Gap |
|---|---|---|
| **Shared collections** | Partial | Sharing a collection record is possible, but children (nodes inside the collection) would NOT inherit the share. Each node must be shared individually. |
| **Shared memories** (trips, dates, occasions) | Partial | Can share individual memory records user-to-user. Cannot create a "shared space" that both users contribute to. |
| **Sharing ideas/inspiration/quotes** | Works | Single-record sharing is exactly this. `share(nodeId, friendUserId, "viewer")` works today. |
| **Sharing a note/markdown/bookmark** | Works | Direct per-record share. Read-only via `viewer`, editable via `editor`. |
| **Shared space** | Not Possible | No concept of a shared namespace that multiple users write into. Namespace is always `user-X` — there's no `space-Y` that both users operate within. |

### Selftron

| Use Case | Feasibility | Gap |
|---|---|---|
| **Sharing menstrual cycle** | Partial | Can share individual cycle log records, but cannot share "all future records" automatically. Every new entry must be explicitly shared. |
| **Shared habits / activity tracking** | Not Possible | Habits generate frequent records (IFR). Auto-sharing every new record with a partner isn't supported. No "share all records in resource X with user Y" rule. |

### Pointron

| Use Case | Feasibility | Gap |
|---|---|---|
| **Group focus** | Not Possible | No group entity. Cannot share a focus session with a team/group. Would need to `share()` with each individual member separately, and no broadcast mechanism exists. |
| **Shared objectives** | Partial | Can share a goal record with individuals. But tracking progress from multiple users against a shared objective is not supported — each user's sessions live in their own namespace. |

### Events

| Use Case | Feasibility | Gap |
|---|---|---|
| **Shared events** | Partial | Can share event records. But RSVP, attendee lists, and multi-party coordination require cross-namespace writes that don't exist. |

### Finatron

| Use Case | Feasibility | Gap |
|---|---|---|
| **Shared accounts** | Not Possible | A shared bank account needs a shared namespace both partners write into. Current model: each user has their own namespace, sharing is read-access to individual records. |
| **Household expenses** | Not Possible | Same as above. Two users creating expense records in a shared ledger requires a writable shared namespace. |
| **Splitwise** | Not Possible | Requires: (1) shared expense records, (2) balance computation across users, (3) settlement tracking. All require cross-namespace data access or a shared namespace. |

### Feedtron

| Use Case | Feasibility | Gap |
|---|---|---|
| **Shared listening** | Not Possible | Feed items are high-frequency. Would need either a shared namespace or automatic forward-sharing rules. Neither exists. |

### Compoundum (Org/Workspace Model)

| Use Case | Feasibility | Gap |
|---|---|---|
| **Workspaces/Orgs** | Partial | `ns("org-123")` works for namespace-level isolation. But a single user belonging to multiple orgs requires namespace switching, and there's no built-in org membership model. |
| **Projects/Sub-orgs** | Partial | `ns("org-123", "project-456")` composes fine. But no ACL on who can access which project. |
| **Teams/Groups** | Not Possible | No group entity in DataFn. Cannot say "share with team X" — must enumerate and share with each member. |
| **Individuals** | Works | Per-user namespace isolation is the default. |
| **Private resources** | Works | `shareable.default: "private"` handles this perfectly. |
| **Restricted/shared among some groups** | Not Possible | No group-level permission grants. |
| **Org-wide/Project-wide** | Not Possible | No "share with all members of namespace X" or wildcard sharing. |

---

## 5 Critical Gaps

### Gap 1: No Group/Team Sharing Primitive

**Current:** `share(recordId, userId, level)` — individual user only.

**Needed:** `share(recordId, groupId, level)` where `groupId` resolves to a set of users. This is required by: shared collections, group focus, shared objectives, shared accounts, household expenses, splitwise, Compoundum teams.

**Suggestion:** Introduce a `ShareTarget` abstraction:

```typescript
// Instead of just userId
shareWith: { userId: string } | { groupId: string }

// With a group resolution provider on the server
groupProvider: {
  getMembers: (groupId: string) => Promise<string[]>
  isMember: (groupId: string, userId: string) => Promise<boolean>
}
```

Access ID resolution would then check both individual permissions AND group memberships. The permissions table would store both user-level and group-level entries. This avoids N individual share operations when a group has N members.

### Gap 2: No Shared/Writable Namespace (Shared Spaces)

**Current:** Namespace = strict isolation. User A in `ns("user-A")` cannot write to `ns("user-B")` or any shared partition.

**Needed:** A namespace that multiple users can write into (e.g., `ns("household-123")` for shared expenses, `ns("trip-paris-2024")` for shared memories).

**Suggestion:** Allow a user to operate in a "shared namespace" via namespace resolution:

```typescript
namespaceProvider: {
  getNamespace: (ctx) => {
    // If request targets a shared space, use that namespace
    if (ctx.headers["x-space-id"]) {
      return ns("space", ctx.headers["x-space-id"]);
    }
    // Otherwise, personal namespace
    return ns("user", ctx.session.userId);
  }
}
```

This is already **technically possible** with the current architecture — the `namespaceProvider` is fully flexible. But it requires:
- An external membership/ACL model to verify the user has access to the shared namespace
- The `authorize` callback to enforce this
- Client-side `switchContext()` to switch between personal and shared namespaces

This is more of a **pattern documentation gap** than a code gap. DataFn already supports it, but it's non-obvious and requires significant application-layer plumbing.

### Gap 3: No Permission Inheritance / Cascading

**Current:** Sharing is per-record. Sharing a collection does NOT share its children.

**Needed:** Share a collection → all nodes in it are accessible. Share a goal → all sessions under it are visible.

**Suggestion:** Two possible approaches:

**A) Eager cascading (at share-time):**

```typescript
// When sharing a collection, also share all its children
onShare: async (resource, recordId, userId, level) => {
  if (resource === "collection") {
    const children = await getChildren(recordId);
    for (const child of children) {
      await table.share(child.id, userId, level);
    }
  }
}
```

Problem: new children added later won't be shared.

**B) Lazy inheritance (at query-time):**

Add a `parentAccessField` to the shareable config:

```typescript
shareable: {
  levels: ["viewer", "editor", "owner"],
  default: "private",
  inheritFrom: { resource: "collection", via: "collectionId" }
}
```

When computing `shareableAccessIds`, also include IDs of records whose parent collection is accessible. This is more correct but adds query complexity.

### Gap 4: No Public/Link Sharing

**Current:** All sharing requires knowing the target `userId` upfront.

**Needed:** "Share via link" for notes, bookmarks, ideas — anyone with the link can view.

**Suggestion:** Add a `"public"` pseudo-level or a `shareLink` operation:

```typescript
// Option A: Special userId
share(recordId, "__public__", "viewer")

// Option B: Dedicated operation
const link = await table.createShareLink(recordId, {
  level: "viewer",
  expiresAt: ...
})
// Returns: { token: "abc123", url: "https://app.com/shared/abc123" }
```

This would require a `__datafn_share_links_{resource}` table and a token-based auth bypass in the query pipeline.

### Gap 5: No Resource-Level Sharing Rules

**Current:** Sharing is always per-record, always manual.

**Needed:** "Share all my cycle logs with partner X" or "Share all expenses in household namespace."

**Suggestion:** Introduce resource-level share rules:

```typescript
// Persistent rule: all future records of this resource are shared
await table.addShareRule({
  resource: "cycleLog",
  userId: "partner-123",
  level: "viewer",
  // Optional filters
  filter: { type: "period" }
})
```

The server would check share rules during insert/merge operations and auto-create permission entries.

---

## Sufficiency Matrix

| Scenario | Works Today | With App-Layer Plumbing | Needs DataFn Changes |
|---|---|---|---|
| Share a single note/bookmark | Yes | — | — |
| Share ideas with a friend | Yes | — | — |
| Private resources | Yes | — | — |
| Per-user isolation | Yes | — | — |
| Org-level namespace | Yes | — | — |
| Shared space (both write) | — | Yes (namespace trick) | Better with docs/helpers |
| Shared collection (with children) | — | — | Gap 3: Inheritance |
| Shared memories (ongoing) | — | — | Gap 5: Resource rules |
| Menstrual cycle sharing | — | — | Gap 5: Resource rules |
| Shared habits/activity | — | — | Gap 5: Resource rules |
| Group focus | — | — | Gap 1: Group sharing |
| Shared objectives | — | Partial | Gap 2 + Gap 1 |
| Shared accounts | — | — | Gap 2: Shared namespace |
| Household expenses | — | — | Gap 2: Shared namespace |
| Splitwise | — | — | Gap 2 + custom logic |
| Shared listening | — | — | Gap 5: Resource rules |
| Teams/groups | — | — | Gap 1: Group primitive |
| Restricted to groups | — | — | Gap 1 |
| Org-wide sharing | — | — | Gap 1 + Gap 5 |
| Share via link (public) | — | — | Gap 4: Public sharing |
| Compoundum full model | — | Partial | Gaps 1, 2, 3, 5 |

---

## Performance Considerations

### Current Scaling Concerns

1. **Access ID resolution is eager and unbounded.** `resolveShareableAccessIds()` runs `db.findMany({ where: createdBy === actorId })` on the main resource table BEFORE every query. For a user with 10,000 notes, this returns 10,000 IDs, then injects `WHERE id IN (10000 items)` into the actual query. This is O(N) per query where N = total owned records.

2. **Permission cleanup is sequential.** Deleting a record shared with 20 users makes 21 DB calls (1 find + 20 deletes) sequentially.

3. **No caching of access IDs.** Every query re-resolves the full access ID set. No invalidation-based cache exists.

### Suggested Mitigations

- **Index `createdBy`** on shareable resources (if not already indexed)
- **Use a subquery/join** instead of materializing all IDs: `WHERE id IN (SELECT id FROM documents WHERE createdBy = ?) OR id IN (SELECT resourceId FROM __datafn_permissions_documents WHERE userId = ?)`
- **Batch permission deletes**: `DELETE FROM __datafn_permissions_documents WHERE resourceId = ?` instead of per-entry
- **Consider caching** access IDs with invalidation on share/unshare mutations

---

## Recommendations (Priority Order)

### P0 — Shared Namespace Pattern (Unblocks most use cases)

Document and formalize the "shared namespace" pattern. This is already possible with `namespaceProvider` + `authorize` callback + `switchContext()`, but it needs:
- A membership table/provider interface
- Authorization logic that checks membership before allowing namespace access
- Client helpers for switching between personal and shared contexts
- Example: household expenses, shared memories, shared accounts

### P1 — Group Sharing Primitive (Unblocks Compoundum)

Add `groupId` as a share target alongside `userId`. Requires a `groupProvider` interface for member resolution. This is foundational for any team/org feature.

### P2 — Resource-Level Share Rules (Unblocks ongoing sharing)

Add persistent share rules that auto-apply to new records. Critical for Selftron (cycle sharing), shared habits, and Feedtron.

### P3 — Permission Inheritance (Unblocks collection sharing)

Add `inheritFrom` config on shareable resources so children inherit parent permissions. Important for Memotron collections and Pointron goal hierarchies.

### P4 — Public/Link Sharing (Nice to have)

Add share links with tokens. Lower priority since most use cases are between known users, but needed for "share a note publicly."

---

## Conclusion

DataFn's architecture is **well-designed and extensible** — the namespace system, capability model, and authorization pipeline are solid foundations. Roughly **3 out of 20 use cases work today out-of-the-box**, another **3-4 are achievable with significant app-layer plumbing** using existing primitives (namespace tricks + authorize callback), and the remaining **13+ require new DataFn primitives** (primarily gaps 1, 2, and 5). The shared namespace pattern (P0) alone would unblock the largest cluster of use cases with minimal DataFn core changes.

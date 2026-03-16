
# Cross namespace sharing
This is the key tension. Right now namespace is a hard partition — queries always filter `WHERE __ns = :ns`. So if Alice's note lives in `ns:user:alice` and Bob queries `ns:user:bob`, he'll never see it regardless of permissions. The permissions rows themselves also live under `__ns = user:alice`.

There are a few ways to handle this without an overarching namespace:

**Option A: "Shared with me" query path**

Permissions table is queried *first*, across namespaces:

```SQL
1. SELECT resourceId, __ns FROM permissions_notes WHERE userId = 'bob'
   → returns [{resourceId: "n1", __ns: "user:alice"}]
2. Fetch those records from their source namespaces
```

This is a dedicated query mode — Bob isn't querying "his" namespace, he's querying "things shared with me." The namespace isolation stays intact for normal queries, but this path crosses namespaces via the permissions table.

**Option B: Permissions table is global (not namespace-scoped)**

Move the permissions table out of namespace scoping entirely. It becomes a global cross-cutting table:

```
permissions: (resourceId, resourceNs, principalType, principalId, level)
```

Now a single query can say "give me all notes where `visibility = 'shared'` and I have a permission entry" without knowing which namespace they live in. The resource itself stays in its source namespace.

**Option C: Shadow reference in receiver's namespace**

When Alice shares note `n1` with Bob, create a lightweight reference row in Bob's namespace:

```
ns:user:bob → { id: "ref:n1", sourceNs: "user:alice", sourceId: "n1", type: "shared_ref" }
```

Bob's normal queries pick it up in his namespace. The client resolves the actual content from the source. This keeps namespace queries clean but adds a write on share and a delete on revoke.

---

**My take**: Option A is probably the most natural fit with the visibility column approach. You'd have two query modes:

- **Normal query** — namespace-scoped, uses visibility column (`private`/`ns`), no cross-ns concern
- **"Shared with me" query** — permissions-first, crosses namespaces, only for `visibility: "shared"` records

This way you don't pollute namespace isolation for the 90% case, and cross-ns sharing is a distinct, explicit operation. No overarching namespace needed. The client knows when it wants "my stuff" (normal query) vs "stuff others shared with me" (shared-with-me query).



## Option A vs Option B

**For intra-ns shared queries, they're identical:**

```sql
-- Option A
SELECT * FROM notes WHERE __ns = 'org:acme' AND visibility = 'shared'
AND id IN (SELECT resourceId FROM permissions WHERE __ns = 'org:acme' AND userId = 'bob')

-- Option B
SELECT * FROM notes WHERE __ns = 'org:acme' AND visibility = 'shared'
AND id IN (SELECT resourceId FROM permissions WHERE resourceNs = 'org:acme' AND userId = 'bob')
```

Same performance, same indexes, same result. No difference for the common case.

**For cross-ns, Option B wins clearly:**

```sql
-- Option A: two steps
-- Step 1: find permissions across namespaces
SELECT resourceId, __ns FROM permissions WHERE userId = 'bob'
-- Step 2: fetch from each source namespace (grouped or multi-clause)
SELECT * FROM notes WHERE (__ns = 'user:alice' AND id = 'n1')
   OR (__ns = 'org:acme' AND id = 'n3')

-- Option B: single join
SELECT n.* FROM notes n
JOIN permissions p ON n.id = p.resourceId AND n.__ns = p.resourceNs
WHERE p.userId = 'bob' AND n.visibility = 'shared'
```

**Option B is better.** Here's why:

**One query path, not two.** With Option A, your server needs separate code paths for "shared within ns" vs "shared with me across ns." With Option B, the same query handles both — just add `AND resourceNs = :ns` when you want to scope it, drop it when you want cross-ns. The permissions table doesn't change, only the filter does.

**Indexing is cleaner.** Option A's permissions table has `(__ns, userId)` as its primary index. For intra-ns queries that's perfect. But for "shared with me" (cross-ns), you'd need a *separate* index on just `(userId)` because you're querying without `__ns`. Option B's `(userId)` and `(resourceNs, userId)` indexes naturally serve both patterns.

**The permissions table is inherently cross-cutting.** A permission row says "Bob can view note n1" — that's a relationship between a principal and a resource, not something that belongs to a namespace. Forcing it into namespace partitioning is artificial. The resource lives in a namespace, but the permission is *about* the resource, not *in* the namespace.

**One caveat for sync:** In both options, syncing permissions for offline requires an actor-based pull ("give me permission changes relevant to me"), not a namespace-based pull. This is the same challenge in both options — the permissions table needs its own sync path based on the actor's identity, not the namespace cursor. Option B just makes this more obvious rather than hiding it behind namespace partitioning.

So: **Option B — global permissions table with `resourceNs` as a data column, not a partition key.**


## Cross NS - schema level permission
"do you think using option A is good for even cases when ns is same but resources are shared only to a few people or groups or projects etc... like in a org ns - Or should we have like fourth visibility -> "shared" - for within ns, "cross-shared" for outside ns as well... will this be any better for any security or other reasons?"


Just `shared` is enough. The intra-ns vs cross-ns distinction belongs to the **query mode**, not the record itself.

Think about it from the record's perspective — a record doesn't care *where* the person accessing it lives. It just has permission entries. Whether Bob is in the same org namespace or a different personal namespace, the permissions row is identical:

```
(resourceId: "n1", principalType: "user", principalId: "bob", level: "editor")
```

The split happens at **query time**:

- **"Show me shared docs in this org"** → `WHERE __ns = :ns AND visibility = 'shared' AND id IN (permissions lookup scoped to same ns)` — fast, namespace-bounded
- **"Show me everything shared with me"** → permissions-first query across namespaces — only when the user explicitly asks for it

If you added `cross-shared` as a fourth value, you'd run into awkward situations:
- Alice shares a note with Bob (same org) → `shared`
- Later Alice also shares it with Charlie (different org) → now it needs to become `cross-shared`?
- And if Charlie's access is revoked, flip it back to `shared`?

The visibility column would be coupling to the *current state of who has access*, which changes over time. That's exactly what the permissions table tracks. The visibility column should only answer: "does this record need per-actor access checks at all?"

**For security** — if you want to prevent cross-ns sharing for certain resources (e.g., "org-internal docs must never leave the org"), that's a **validation rule at share-time**, not a visibility value. When someone calls `shareWith`, the server checks: "is this resource allowed to be shared outside its namespace?" and rejects if not. Schema-level config like `crossNsShareable: false` on the resource definition handles that cleanly.

So the model stays clean at three values:

| visibility | query cost | use case |
|---|---|---|
| `private` | `createdBy = actor` | personal data |
| `ns` | namespace filter only | org-wide, team-wide |
| `shared` | permissions lookup | selective sharing (intra or cross ns) |



# Principals, principal types

**Principal types should not be a fixed enum.** The permissions table doesn't need to know or care what a principal type *means*. It just stores:

```
(resourceId, principalType, principalId, level)
```

Where `principalType` is just a string — `"user"`, `"team"`, `"role"`, `"department"`, `"whatever-your-app-invents"`. The permissions table treats them all identically. It's just a tag that tells the *membership resolution layer* where to look.

**For RBAC, it's exactly as you said:**

```
principalType: "role", principalId: "editor"
principalType: "role", principalId: "viewer"
principalType: "role", principalId: "admin"
```

No extra columns. No schema change. The permissions table is already generic enough.

**How hierarchy resolution works without fixed types:**

The resolution layer doesn't need a hardcoded hierarchy either. It just needs a generic membership table:

```
memberships: (actorId, principalType, principalId)
```

For example, Bob's memberships:
```
(bob, team, engineering)
(bob, role, editor)
(bob, org, acme)
(bob, project, atlas)
```

At query time:

```
1. Get actor's memberships → [(team, engineering), (role, editor), (org, acme), ...]
2. SELECT * FROM permissions 
   WHERE resourceId = :id 
   AND (principalType, principalId) IN (:memberships)
   OR (principalType = 'user' AND principalId = :actorId)
```

The query doesn't care what the principal types are. It just matches tuples. If your app defines a new principal type `"department"` tomorrow, you add membership rows and permission rows — zero schema changes, zero code changes to the query path.

**For nested hierarchies** (team within an org, sub-team within a team), the memberships table just has more rows. Either you flatten at write time (when Bob joins team `engineering` under org `acme`, you write both membership rows), or you resolve recursively at read time. Flattening at write time is better for query performance — the permission check stays a single `IN` clause regardless of hierarchy depth.

So the recommendation in that report should be:

- `principalType`: **free-form string**, not an enum
- Resolution is generic: memberships table maps actors to `(principalType, principalId)` tuples
- RBAC is just `principalType = "role"` — no special handling
- New principal types are a data concern, not a schema concern


## Need for principal type?

why do we need principal types along with principals?
---------
You don't, if principal IDs are unique.

The permissions check is just: "does a permission row exist where `principalId` matches one of the actor's memberships?" It doesn't care if that principal is a team, role, group, or anything else.

```
-- before
permissions: (resourceId, resourceType, resourceNs, principalType, principalId, level)
memberships: (actorId, principalType, principalId)

-- after
permissions: (resourceId, resourceType, resourceNs, principalId, level)
memberships: (actorId, principalId)
```

Query:
```sql
-- get actor's principals
SELECT principalId FROM memberships WHERE actorId = :actor
-- check permissions
... WHERE principalId IN (:principals)
```

The `principalType` was only useful if IDs could collide across types — like a team called "admin" and a role called "admin." Use unique IDs and that goes away.

If you ever need to know *what kind* of principal something is, that's a property of the principal entity itself, not something the permissions or memberships table needs to carry.

---------
okay, datafn as a system doesn't care about it? pricnicpal ids can be anything like role:some org:some team:some etc
---------
Exactly. From datafn's perspective, a `principalId` is just an opaque string. Datafn doesn't interpret it, validate it, or resolve it. It just matches strings.

```
principalId: "role:admin"
principalId: "org:acme"
principalId: "team:engineering"
principalId: "user:bob"
principalId: "project:atlas"
principalId: "literally-anything"
```

Datafn does two things with it:

1. **Memberships** — given an actorId, return all principalIds
2. **Permissions** — match those principalIds against permission rows

That's it. The semantics of what a principal *means*, the hierarchy, the naming convention — all application-level concerns. Datafn just stores and matches strings.

The app decides its own convention. Could be `type:id` prefixed strings. Could be UUIDs. Could be URNs. Datafn doesn't care.



## Hierarchy resolution of principals - flattened memberships vs hierarchy resolution at query time
This is the core trade-off. Let me lay out the approaches clearly.

**What you described — flattened memberships:**

Bob joins sub-project C → write membership rows for the entire chain:
```
(bob, subproject, C)   ← direct
(bob, subproject, B)   ← inherited
(bob, project, A)      ← inherited
(bob, org, acme)       ← inherited
```

Query time is trivial — just `IN (:memberships)`. But:

**Pros:**
- Fastest possible permission check — single flat `IN` clause
- No hierarchy awareness needed at query time at all
- Works identically regardless of hierarchy depth

**Cons:**
- **Hierarchy restructure is painful.** Move project A from org `acme` to org `beta` → rewrite flattened memberships for *every member* of A and all its descendants. If A has 500 members across sub-projects, that's potentially thousands of row updates in one operation.
- **Add/remove ancestor level** — insert a new project level between B and A → rewrite all memberships for everything below it.
- **Consistency risk** — if the hierarchy update and membership rewrite aren't atomic, you have a window where permissions are wrong.
- **Write amplification on every user join** — adding one user to a deep leaf writes N rows.

---

**Alternative: Store hierarchy separately, resolve at query time**

Two small tables:

```
memberships:  (actorId, principalType, principalId)  ← direct only
hierarchy:    (principalType, principalId, parentType, parentId)
```

Hierarchy:
```
(subproject, C) → parent: (subproject, B)
(subproject, B) → parent: (project, A)
(project, A)    → parent: (org, acme)
```

Bob's membership — just one row:
```
(bob, subproject, C)
```

At query time:
```
1. Bob's direct memberships: [(subproject, C)]
2. Walk hierarchy up: C → B → A → acme
3. Effective principals: [(subproject, C), (subproject, B), (project, A), (org, acme)]
4. Check permissions with IN (:effectivePrincipals)
```

**Pros:**
- Hierarchy changes are one row update — move project A under different org, just update A's parent pointer. Done. Zero membership rewrites.
- User join/leave is one row.
- Hierarchy is always the source of truth, no sync risk.

**Cons:**
- Query-time resolution adds a recursive lookup.

**But — the hierarchy table is tiny.** It's just the org structure, not per-user data. An org with 200 projects/teams/sub-projects is 200 rows. This easily fits in memory. The "recursive walk" is an in-memory tree traversal that takes microseconds.

---

**Recommended approach: hierarchy resolution with caching**

```
1. Cache the full hierarchy in memory (it's small, changes rarely)
2. On hierarchy change → invalidate cache
3. At query time:
   - Get actor's direct memberships (DB lookup, indexed)
   - Walk up cached hierarchy (in-memory, microseconds)
   - Use resolved list for permissions IN clause
```

The hierarchy table has maybe hundreds of rows for even large orgs. Cache it on server startup, invalidate on the rare hierarchy mutation. The query-time cost becomes: one indexed DB lookup (direct memberships) + in-memory tree walk. Practically identical to the flattened approach in terms of latency.

**Hierarchy restructuring goes from "rewrite thousands of membership rows" to "update one parent pointer + invalidate cache."**

So: **don't flatten memberships. Store hierarchy, resolve at query time with a cached hierarchy tree.** You get the same query performance without the write amplification and consistency headaches.



# Visibility column, per resource sharing

- Sharing should be per resource config instead of whole schema level capability
- When sharing is enabled on a resource - along with permissions table usage, there should be a `visibility` column on that table
- Visibility column is a snapshot of access level for a record - helps with faster queries in many scenarios
- This column should be system column and is managed by datafn itself

visibility: null | "private" | "shared"

- `null` is the default
- use `private` when ns can have multiple actors and we need a way to have private resources within ns
- use `shared` (as a snapshot of this record has been shared with some others - check permissions table for exact details) when ns = actor and resource count type is finite



## Cases

1. Give me all private records for "actor:x"

If ns = actor => then select all records where visibility != "shared"
If ns != actor => then select all records where visibility == "private"



2. Give me documents shared across the org

documents where ns = :org and visibility == null


## Anti patterns for visibility
- Defaulting to "private" visibility in an already private ns - This will cause problems like if there is a scope level permission change (ex: All note resource type of Alice can now be viewed by Bob) - then we have to edit all 1000s of records from visibility:private to visibility:shared or similar



# Scope level sharing
- making `resourceId` null and setting `resourceType` in permissions table means all of that specific resourceType table in that particular ns is shared
- Useful for future data cases or indefinite sharing cases and bulk data cases ex: user A wants to share their cycle data with user B indefinitely until cancelled.


# Relation inheritance


ex:
collection - n number of node resource records can be linked

when collection:x is shared with actor:b and actor:c
actor:b and actor:c can acess all the node records linked to collection despite 
those node records not having permission entries directly to actor:b or actor:c

collection:x is the proxy permission for all node records linked to it

- linking entries from cross ns by members instead of owner? - when inserting join row - check permissions for that user for the collection
- when a new member joins - consent (the records you add to this collection:x will be auto shared to members in this collection)



# namespace - dos and donts

- `ns` is colocation or isolation of data per user or org etc...
- within org or user - using `ns` to cater memberships would make things complicated

--------------------------
# Use case analysis


Nucleus (~/Documents/dev/n/nucleus project)
## Collections - shared collections

### Shared memories with a partner - trips, dates, occasions etc
Other examples: Sharing ideas or inspiration or quotes etc with a friend or partner etc

- user A creates a collection:x (ns:userA) and shares it with parter user B
- this sets visibility = "shared" for this collection and adds entry in permissions table 
- permissions entry: (resourceId = collection:x, resourceType = collection, resourceNs = ns:userA, level: edit, principal = userB)
- Relation inheritance - all the items added to collection are visible to all shared principals - without 
individually adding permission records per record


give me my own private collections that I haven't shared with anyone (userA)
-> select collections where visibility !== "shared" and ns = ns:userA


give me shared collections for user A (client query)
-> select collections where visibility == "shared" and ns = ns:userA
-> select all collections from other NS from permissions which are shared with userA


give me shared collections for user B
-> select collections where visibility == "shared" and ns = ns:userB
-> select all collections from other NS from permissions which are shared with userB




## Memotron

## Sharing a particular note or markdown or bookmark etc

sets record visibility to "shared" and adds entry in permissions

## Shared space
namespace is shared and individual's private records are marked as "private" visibility



## Selftron

### sharing menstrual cycle
- creates permissions entry on resource level instead of record level
- the records stay in owner's namespace with visibilty = null


### Shared habits, activity tracking
- habit is created in owner's ns and shared
- habit's related records like activity data etc for all members will be visible to each other via relation inheritance

- The argument for shared `ns` per shared habit might sound intuitive but it will complicate things - 
   - like again maintaining memberships for ns
   - ex: for each shared habit - a new namespace is not helping anyway (just 1 record for that namespace) - and the 
   relation records are anyways in individual user's namespaces


## Pointron
- Group focus - master record in owner ns, shared with members, relation inheritance (session logs by different members linked to focus)
- Shared objectives - owner ns, shared, relation inheritance
- Events - owner ns, shared

# Finatron
- Shared accounts - account record in owner ns, shared with members, relation inheritance (for transactions)
- Household expenses - household category record in owner ns, shared with memebers, relation inheritance (for transactions)
- Splitwise


# Feedtron
- Shared listening?



# Compoundum (Future team collaboration and all-in-one super tool)
namespace per org or project

- Workspaces or Orgs
- Projects or sub orgs
- Teams or groups etc
- Individuals

- Private resources (visibilty = "private")
- Restricted and shared among some groups or individuals (visibitlity = "shared")
- Org wide or project wide etc (visibility = null)
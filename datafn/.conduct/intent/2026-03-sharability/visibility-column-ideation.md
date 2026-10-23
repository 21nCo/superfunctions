# A case for per-row "visibility" column

**A per-row `visibility` column with values like `private | ns | shared`:**

- `private` → `WHERE createdBy = actorId` — only owner sees it, no permissions lookup
- `ns` → no filter beyond namespace — everyone in the namespace sees it, no permissions lookup
- `shared` → needs permissions table lookup (the selective case)

**What this buys you over the current `shareable.default: "private"` schema-level declaration:**

Currently, the default is set at the resource type level — *all* notes are private, or *all* notes are shared. That's rigid. A user can't create some notes as org-wide and some as private within the same resource type without hitting the permissions table for every query.

With a per-row column:

- A note created as `visibility: "ns"` is instantly visible to the whole namespace — zero permissions lookup
- A note created as `visibility: "private"` is owner-only — just a `createdBy` check, zero permissions lookup
- Only `visibility: "shared"` (selective sharing to specific people/principals) triggers the permissions table join

So yes — **`private` and `ns` cases are fully covered without any ACL table at all.** The query becomes:

```sql
WHERE __ns = :ns
AND (
  visibility = 'ns'
  OR (visibility = 'private' AND createdBy = :actorId)
  OR (visibility = 'shared' AND id IN (SELECT resourceId FROM permissions WHERE ...))
)
```

The permissions subquery only activates for rows marked `shared`. For apps where most records are either fully private or fully org-wide, this eliminates the vast majority of ACL lookups.

**Scenarios this covers without permissions table:**
- Personal notes (private)
- Org-wide announcements (ns)
- Couple shared memories where most are visible to both (ns), some are private (private)
- Team-wide resources (ns)
- User's own data in a shared workspace (private)

**Only scenario that still needs the permissions table:** "share this specific record with Bob but not Charlie" → `shared` visibility + permissions row.

This is a meaningful simplification. The current schema-level default forces you into the permissions table for the entire resource type the moment *any* record needs selective visibility.


## Visibility in query
If the client declares the visibility scope upfront in the query, the server can short-circuit entirely:

**Query with `visibility: "private"`** → server just does `WHERE createdBy = actorId AND visibility = 'private'`. No permissions table, no membership resolution, no joins. Done.

**Query with `visibility: "ns"`** → server just does `WHERE __ns = :ns AND visibility = 'ns'`. Not even a `createdBy` check needed. Cheapest possible query.

**Query with `visibility: "shared"`** → only now does the server resolve memberships + permissions.

**No visibility filter** → server applies the full conditional (all three branches).

This means the client controls the cost of the query. Concrete examples:

- **"Show me my private journal entries"** → `{ where: ..., visibility: "private" }` → fast, zero ACL overhead
- **"Show me all org announcements"** → `{ visibility: "ns" }` → fast, just namespace filter
- **"Show me notes shared with me"** → `{ visibility: "shared" }` → permissions lookup, but only for this specific query
- **"Show me everything I can see"** → no visibility filter → full resolution, but only when the user actually needs the combined view

This also cascades nicely to **sync paths**:

- Clone/pull with `visibility: "private"` → server streams only owner's rows, no ACL filtering needed
- Clone/pull with `visibility: "ns"` → server streams full namespace, no per-actor filtering
- Clone/pull with `visibility: "shared"` → actor-filtered via permissions

So you can have a client that syncs private data and ns data with zero permissions overhead, and only pays the ACL cost if/when it actually needs selectively shared records. For most consumer apps (personal + household/couple), you might never even hit the permissions table at all — `private` + `ns` covers the entire data model.

The visibility column basically turns ACL from "always-on cost for the entire resource type" into "opt-in cost per query, only when selective sharing is actually used."


# Case against visibility column



## updating visibility column for too many records on permissions change per scope level instead of record level
I see a problem in visibility column now... if I start with private and after 1000 records in resourcetype: note - I want to share everything with another actor - now we have to update 1000 records visibility?
---------


That's a real problem. And it reveals that the visibility column shouldn't be the **gate** for scope-level permissions. It should be the **override**.

Flip the mental model:

**Don't think:** "record must be marked `shared` for permissions to apply"
**Think:** "scope-level permission applies to all records, `private` opts specific records out"

**Visibility column becomes an override, not a prerequisite:**

| value | meaning |
|---|---|
| `null` (default) | governed by whatever permissions exist |
| `private` | hard opt-out — owner only, scope-level permissions don't apply |
| `ns` | hard opt-in — everyone in namespace, no permissions needed |

No `shared` value needed at all.

**How your scenario works now:**

```
Day 1:   Alice creates 1000 notes. visibility = null on all of them.
         No permissions exist → only Alice sees them (same as private).

Day 30:  Alice shares all notes with Bob.
         → ONE scope-level permission row created.
         → Bob instantly sees all 1000 notes. Zero record updates.

Day 31:  Alice wants to hide 3 sensitive notes from Bob.
         → Set visibility = 'private' on those 3 records. 
         → 3 updates, not 1000.

Day 60:  Alice creates note 1001. visibility = null (default).
         → Bob sees it immediately via scope-level permission.
```

**The query:**

```sql
WHERE __ns = :ns AND (
  createdBy = :actorId                              -- owner always
  OR visibility = 'ns'                              -- namespace-wide
  OR (visibility IS NULL AND (                      -- not opted-out
    EXISTS (scope-level permission check)            -- one check, not per-record
    OR id IN (per-record permission check)
  ))
)
```

The scope-level `EXISTS` is a single index lookup for the entire result set — not per-record. If it returns true, all `visibility = null` records are included. `private` records are excluded regardless.

**Client-side query optimization still works:**

- "Show me my stuff" → `WHERE createdBy = :actorId` — no permissions
- "Show me org-wide stuff" → `WHERE visibility = 'ns'` — no permissions
- "Show me stuff shared with me" → permissions-first query (scope + per-record)

The key shift: **`null` is the default, and it means "I don't have an opinion, let permissions decide." `private` is an active choice that overrides everything.**


## Crash of visibility column

if private is an override and default is null... the remaining is "ns" - I feel this is also not needed now right? it depends on query - if query asks for private -> visibility = private and owner = actor
if query asks for ns - then simply visibility != private and all ns records
if query asks for shared - then check permissions table?
---------

You're right. If `null` means "governed by permissions/context" and `private` is the only explicit value, then `ns` is just a query pattern, not a data state.

**The visibility column becomes boolean: `private` or not.**

```
visibility: "private" | null
```

That's it. One column, one meaningful value. The rest is query logic:

```
"my private stuff"    → WHERE visibility = 'private' AND createdBy = :actorId
"namespace stuff"     → WHERE visibility IS NULL AND __ns = :ns
"shared with me"      → permissions-first query
"everything I can see"→ combine all three
```

The record itself only ever answers one question: **"am I excluded from normal access?"** If `private`, yes. If `null`, the query context decides.

**One edge case to be aware of:** within an org namespace, the "ns query" returns ALL non-private records. That means if Alice creates a record with `visibility: null` and adds a per-record permission for only Bob — Charlie's ns query still returns it because it's not private.

That's actually fine if your model is: **namespace membership = read access to all non-private records.** Selective restriction within a namespace = mark it `private` + grant specific permissions. This works cleanly:

```
Org announcement  → visibility: null   → everyone in ns sees it
HR-only document  → visibility: private → only HR team sees it 
                    + scope-level permission for principal (team, hr)
Alice's journal   → visibility: private → only Alice sees it
```

So `private` doesn't mean "only owner forever." It means **"excluded from namespace-wide access, requires explicit permission."** Owner sees it by default (createdBy check), and anyone else needs a permission row.

This gives you the clean binary: **null = namespace-accessible, private = permission-required.**


---------
HR-only document  → visibility: private → only HR team sees it                      + scope-level permission for principal (team, hr)

In this case, we are back to square one

"my private stuff"    → WHERE visibility = 'private' AND createdBy = :actorId - this will not hold true
---------

You're right. I contradicted myself. If `private` means "just check owner, no permissions lookup," then I can't also use it for "restricted but shared with a team via permissions." Those are two different things.

The real problem: **within-namespace selective restriction.**

```
private = owner only     → no permissions check ✓
null    = namespace-wide  → no permissions check ✓
???     = shared with specific people within same namespace
```

The binary model has a gap. Three ways to handle it:

**1. Just use namespaces for it**

HR docs don't go in `ns:org:acme` with restricted visibility. They go in `ns:org:acme:hr`. Team docs go in `ns:org:acme:engineering`. The namespace model already handles access boundaries — use it.

Binary visibility (private/null) stays clean. No gap.

**2. Accept that within-namespace restriction goes through permissions**

Keep records as `null` visibility but check permissions. The NS query becomes: "non-private records where actor has namespace membership OR explicit permission." But then `null` no longer means "skip permissions check" — you're always checking.

This erases the optimization.

**3. Bring back a third value**

```
private  = owner only, no permissions
null     = namespace-accessible, no permissions  
restricted = permissions required
```

But now we're back to updating records when sharing state changes.

---

**Honestly — option 1 is the cleanest.** The namespace is already your access boundary. If a subset of an org needs isolated access, that's what sub-namespaces are for. Trying to solve namespace-level access control through a visibility column is fighting the wrong layer.

Binary visibility (private/null) + namespace hierarchy + scope-level permissions covers everything without contradiction. The HR case isn't a visibility problem — it's a namespace problem.

Does that hold up for your use cases?

---------
now if start my entries with ns: userid and then i want to start sharing all entries with some actor - should I change ns? or just add permissions entry with resource scope?

but now how is binary visibility is helping at all
---------
You're right to question it. Let me be honest.

**For your scenario:** scope-level permission is the answer. Don't change namespace. One permissions row, zero record updates, partner sees everything via cross-ns "shared with me" query.

**But you've exposed the real issue:** what is the visibility column actually doing now?

Walk through the queries:

- **Alice queries her own stuff** → `WHERE createdBy = :actorId` — doesn't need visibility column
- **Bob queries "shared with me"** → permissions-first query, finds scope-level grant, fetches from Alice's ns — doesn't need visibility column
- **NS query in personal namespace** → it's just Alice's data, same as owner query — doesn't need visibility column

The query optimization argument has dissolved. Once you have scope-level permissions and cross-ns sharing via global permissions table, the permissions path is doing the real work regardless.

**The only thing the visibility column still does:** per-record opt-out from scope-level sharing.

```
Alice shares all notes with Bob (scope-level permission)
Alice marks 3 sensitive notes as private
→ Bob sees 997 notes, not 1000
```

Without it, you'd need deny permissions or 997 individual permission rows to exclude 3 records. That's the only remaining value.

**So it's not really a "visibility column" anymore. It's just an `isPrivate` boolean.**

```sql
-- Bob's "shared with me" query
WHERE __ns = 'user:alice' 
AND isPrivate != true
AND EXISTS (scope-level permission check)
```

That's it. One boolean flag. Its job is exclusively: **"exclude this record from any non-owner access, regardless of what permissions exist."**

The grand vision of `private | ns | shared` optimizing different query paths — that collapsed as we simplified. And that's fine. The system is simpler for it.
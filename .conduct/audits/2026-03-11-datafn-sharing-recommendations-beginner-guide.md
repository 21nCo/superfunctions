# Beginner-Friendly Guide: How To Implement DataFn Sharing Recommendations For Real Use Cases

Date: 2026-03-11  
Repository: `/Users/serro/Documents/dev/n/superfunctions`  
Related audit: `/Users/serro/Documents/dev/n/superfunctions/.conduct/audits/2026-03-11-datafn-sharing-permissions-sufficiency-report.md`

---

## Why this document exists

This guide explains the earlier audit recommendations in very simple language, with practical examples from your use cases.

This guide is written for readers who are not deeply familiar with DataFn internals.

---

## DataFn in 3 minutes (plain language)

DataFn has two important layers for collaboration:

1. A **server** that stores the source of truth.
2. A **client** that keeps local data for fast and offline use.

When you collaborate, three server sync operations matter:

1. **Clone**: first full download of data.
2. **Pull**: get new server changes since your last cursor.
3. **Push**: upload your local offline changes to server.

If sharing rules are only checked in query paths but not checked in clone/pull/push paths, private data can leak.

---

## Important words (no jargon assumed)

| Word | Simple meaning | Example |
|---|---|---|
| Namespace | A data partition key. Think “workspace bucket”. | `org:acme:project:alpha` |
| Actor | The person currently making a request. | `user:alice` |
| Record | One data item. | A single note, event, expense, habit entry |
| Share level | Permission for a record. | viewer, editor, owner |
| Access control rules | Rules that decide who can read or write a record. | “Bob can edit note N1” |
| Principal | Any share target identity type. | user, team, project, org |
| Membership | Who belongs to which team/project/org. | Alice is in Team Red |
| Cursor | A bookmark saying “I have synced up to server change number X”. | `cursor=12845` |
| Tombstone delete | A sync event saying “remove this record from local store”. | Bob lost access, local note removed |

Note on abbreviations:
- You may see “Access control list” in other systems. In this guide, I say “access control rules” to keep it clear.

---

## The recommendations, explained simply

## Recommendation 1: Always send actor identity through every server path

What this means:
- The server must know exactly who is calling every endpoint: mutation, transaction, clone, pull, push, reconcile.

Why this matters:
- If clone or pull does not know who is calling, it can return all namespace data, including data that should be private.

Beginner example:
- Alice and Bob are both in the same household namespace.
- A menstrual-cycle note is private to Alice.
- If pull does not use actor identity, Bob can receive Alice’s private note.

Use cases this protects:
- sharing menstrual cycle
- private resources
- shared memories where some memories are private
- finance records where only account owners should see some entries

---

## Recommendation 2: Enforce record share levels on push, not only on mutation

What this means:
- Offline uploaded changes (push) must pass the same permission checks as normal online mutation calls.

Why this matters:
- Without this, someone can edit/delete/share records through push even when they should only view.

Beginner example:
- Bob has viewer access to a note.
- Bob goes offline and edits the note locally.
- On push, server must reject edit because viewer is read-only.

Use cases this protects:
- sharing a particular note
- shared ideas and inspiration
- shared habits with role differences
- group focus where some users should only view

---

## Recommendation 3: Filter clone and pull by the caller for private shared records

What this means:
- For records that are private-by-default, clone and pull should only include records visible to the current actor.

Why this matters:
- Offline sync is where leaks become permanent on device if wrong data is downloaded.

Beginner example:
- Couple has 100 records in one namespace.
- 20 records are private to Alice.
- Bob’s clone and pull should never include those 20 records.

Use cases this protects:
- shared memories with partner
- shared accounts with private sub-records
- household expenses with private notes and attachments

---

## Recommendation 4: Protect relation expansion paths

What this means:
- When query expands related data (for example, `project -> tasks -> comments`), each related record still needs permission checks.

Why this matters:
- A user can be allowed to see a project summary but not confidential comments inside linked records.

Beginner example:
- Team members can view event title and date.
- Only admins can view attendee medical notes.
- Relation expansion must hide restricted linked fields.

Use cases this protects:
- events
- group objectives with private comments
- finatron with linked account metadata

---

## Recommendation 5: Move from user-only sharing to principal-based sharing

What this means:
- Do not only support `shareWith.userId`.
- Support sharing to:
  - user
  - team
  - group
  - project
  - organization
  - workspace

Why this matters:
- Enterprise and group products cannot scale if you duplicate per-user share rows manually.

Beginner example:
- Share a project plan to Team Red once.
- All current and future Team Red members get correct access through membership rules.

Use cases this unlocks:
- Compoundum workspaces and orgs
- Compoundum projects and sub-orgs
- Compoundum teams and groups
- org-wide or project-wide access

---

## Recommendation 6: Add explicit membership and inheritance rules

What this means:
- The system needs a clear way to resolve effective access through memberships.
- Example rule: user belongs to team, team belongs to project, project belongs to org.

Why this matters:
- Otherwise “who should see this record?” becomes app-specific, inconsistent, and fragile.

Beginner example:
- Expense shared to `project:p1`.
- Alice is in `team:t1`, and `team:t1` belongs to `project:p1`.
- Alice should get access without direct per-record share row.

Use cases this unlocks:
- splitwise-style group debts
- team objectives
- feed audience targeting

---

## Recommendation 7: Treat revocation as first-class sync behavior

What this means:
- When access is removed, server should emit deterministic delete events for that actor so their local store removes data quickly and correctly.

Why this matters:
- If revocation only updates permissions but does not remove cached local records, user still sees old data offline.

Beginner example:
- Bob removed from a shared account.
- Next pull should contain deletes for account records Bob should no longer have.

Use cases this protects:
- shared accounts
- household expenses
- private notes in shared spaces

---

## Recommendation 8: Improve indexes and caching for speed

What this means:
- Add database indexes for permission lookups and ownership checks.
- Cache membership resolution for short periods.

Why this matters:
- Collaboration systems do a lot of permission checks.
- Without indexes and caching, latency increases as data grows.

Beginner example:
- Org with 10,000 users and many shared records.
- Pull and query stay fast only if permission lookups are indexed.

Use cases this supports:
- feedtron
- group focus
- large compoundum organizations

---

## Recommendation 9: Keep TypeScript and Python behavior aligned

What this means:
- Same security and sharing outcomes regardless of language runtime.

Why this matters:
- Mixed deployments should not accidentally be less secure in one runtime.

Beginner example:
- Same schema deployed in TypeScript service and Python service.
- Both must deny missing permission policies consistently.

Use cases this supports:
- any multi-service deployment

---

## Use-case cookbook: how to model each one

| Use case | Suggested modeling approach | Sharing style | Needed recommendations |
|---|---|---|---|
| Collections - shared collections | Namespace per collection space, with per-record private option when needed | Team or user sharing | 1,2,3,5,6,7 |
| Shared memories with a partner | Namespace per couple, optional private memories using record-level access | Mostly user-to-user | 1,2,3,7 |
| Sharing ideas and inspiration and quotes | Record-level shares to users or friend group principal | user or group principal | 1,2,3,5 |
| Memotron | Personal namespace by default, optional shared memory board | individual plus optional shared | 1,2,3 |
| Share note and markdown and bookmark | Record-level share with viewer and editor levels | user, team, project | 1,2,3,5 |
| Shared space | Namespace-level shared visibility | full space sharing | 1,7 |
| Selftron | One namespace per individual | no sharing needed | 1 only |
| sharing menstrual cycle | Highly sensitive private-by-default records, strict actor-filtered clone and pull | user-only, explicit consent share | 1,2,3,4,7 |
| Shared habits and activity tracking | Habit board per group plus per-entry private notes | group plus user exceptions | 1,2,3,5,6,7 |
| Pointron | Group leaderboard namespace, optional private score notes | group principal | 1,2,5,6 |
| Group focus | Team principal shares for focus sessions and goals | team and project principal | 1,2,5,6 |
| Shared objectives | Objective records shared to project and team, comments with separate visibility rules | project and team principal | 1,2,4,5,6 |
| Events | Event records org and project wide, sensitive linked fields protected in relations | org and project plus field restrictions | 1,3,4,5,6 |
| Finatron | Account data with strict role controls and auditable revocation | org and project and team and user principals | 1,2,3,4,5,6,7 |
| Shared accounts | Account principal plus member roles | team and org principal | 1,2,3,5,6,7 |
| Household expenses | Household namespace plus per-expense participant principal shares | household group plus user | 1,2,3,5,6,7 |
| Splitwise | Group principal for ledger, user principals for personal items | group plus user | 1,2,3,5,6,7 |
| Feedtron | Audience principals (org/team/project/user) for each post | principal-based audience | 1,3,5,6,8 |
| Shared listening | Session principal for room and party, optional private notes | group and session principal | 1,2,3,5,6 |
| Compoundum workspaces and orgs | Workspace and org principal hierarchy | org and workspace principal | 1,5,6,8 |
| Compoundum projects and sub-orgs | Project principal under org inheritance | project principal | 1,5,6,8 |
| Compoundum teams and groups | Team principal with membership mapping | team and group principal | 1,5,6,8 |
| Compoundum individuals | User principal and personal namespace | user principal | 1 |
| Private resources | private-by-default with actor-filtered sync | user and private principal | 1,2,3,7 |
| Restricted among some groups and individuals | Principal model with mixed audience list | user plus group principals | 1,2,3,5,6,7 |
| Org-wide or project-wide | Single principal share at org and project scope | org and project principal | 1,3,5,6,8 |

---

## Detailed offline sync explanation for shared resources

This section explains exactly how clone, pull, and push should work for shared resources in a safe way.

## How it works today versus how it should work

Current behavior today (important caveat):
- Clone and pull are namespace-scoped and can return too much data when the namespace contains multiple users with different private visibility.
- Push may not enforce the same record-level share checks as mutation in all paths.
- Result: offline local storage can contain records the user should not have, and stale unauthorized edits may be attempted on push.

Recommended behavior:
- Clone and pull are actor-filtered for private records.
- Push enforces the same share-level rules as normal mutation endpoint.
- Unshare generates deterministic delete events so revoked records are removed from local storage.
- Net result: online and offline security behavior stays consistent.

## The shared resource example used below

- Record: `note:n1`
- Owner: Alice
- Shared to Bob with editor permission
- Shared to Team Red with viewer permission

---

## Step 1: Clone (first full download)

What clone should do:
1. Client sends clone request.
2. Server resolves actor identity.
3. Server computes actor-visible records only.
4. Server returns only visible records plus cursors.
5. Client writes records to local storage.

Why this matters:
- Clone is the largest payload.
- If clone is wrong once, private data is stored locally and may remain visible offline.

Expected behavior for example:
- Alice clone sees `note:n1` (owner).
- Bob clone sees `note:n1` (shared editor).
- Charlie (not shared) clone does not see `note:n1`.

---

## Step 2: Pull (incremental download)

What pull should do:
1. Client sends current cursors.
2. Server finds changes since those cursors.
3. Server filters change set by actor visibility.
4. Server returns upserts and deletes.
5. Client applies changes in order and advances cursors monotonically.

Why this matters:
- Pull keeps all devices in sync after clone.
- Visibility filtering must be applied at change level.

Expected behavior for example:
- Alice edits `note:n1` online.
- Bob pull receives upsert for `note:n1`.
- Charlie pull receives nothing for `note:n1`.

---

## Step 3: Push (upload local offline changes)

What push should do:
1. Client sends queued offline mutations.
2. Server checks each mutation against share level for actor.
3. Allowed mutations are committed and change events recorded.
4. Rejected mutations return explicit errors.
5. Client removes successful entries and keeps or resolves failed entries.

Why this matters:
- Offline work is common.
- Push is a security boundary, not just a transport step.

Expected behavior for example:
- Bob (editor) changes note text offline, push succeeds.
- Team Red member (viewer) tries edit offline, push is rejected.

---

## Step 4: Unshare and revocation flow

What revocation should do:
1. Owner removes Bob’s access.
2. Server updates permission state.
3. Server emits deterministic delete visibility events for Bob.
4. Bob pull removes local records he no longer can access.
5. If Bob pushes stale offline edit later, server rejects it.

Why this matters:
- Security is not complete until old local copies are removed.

Expected behavior for example:
- After unshare, Bob’s next pull contains delete for `note:n1`.
- Bob local store removes `note:n1`.
- Bob stale push for `note:n1` returns forbidden error.

---

## Step 5: Conflict handling for shared records

Simple default behavior:
- Last server-accepted write wins.
- Server sequence number gives deterministic order.

Safer behavior for important data:
- Add conditional write checks so clients can detect stale updates.

Example:
- Alice and Bob both edit same expense amount offline.
- First accepted push updates amount.
- Second push either overwrites by default strategy or fails by strict conditional rule.

---

## Step 6: Relation-safe sync behavior

For linked data (for example project -> tasks -> comments):
- Clone and pull must apply actor visibility checks for each linked resource.
- Relation expansion in queries must not bypass permissions.

Example:
- User can see objective title but not private coaching comments.
- Pull should not deliver restricted comment records.

---

## What to implement first (practical order)

1. Identity propagation and share-level checks in push and transact and clone and pull.
2. Revocation delete events and client removal behavior.
3. Relation-safe permissions checks.
4. Principal-based sharing and membership resolution.
5. Index and cache performance improvements.
6. Python parity with TypeScript behavior.

---

## Concrete shared-resource flows by product example

## Example A: Shared memories with partner

Setup:
- Namespace: `couple:alice-bob`
- Records default to shared for normal memories.
- Sensitive memory entries default private and explicitly shared.

How recommendations apply:
- Recommendation 1 ensures each request identifies Alice or Bob.
- Recommendation 3 ensures clone and pull only include private entries for allowed partner.
- Recommendation 7 removes entries from local device if sharing is revoked.

Offline behavior:
- Both can add memories offline.
- Push validates who can update which private memory entries.

---

## Example B: Household expenses and splitwise

Setup:
- Namespace: `household:green-home`
- Expense record shared to participant group principal.
- Some receipt attachments shared only to payers.

How recommendations apply:
- Recommendation 5 and 6 avoid per-user fan-out on each expense.
- Recommendation 4 protects linked sensitive fields.
- Recommendation 8 keeps query and pull fast for larger ledgers.

Offline behavior:
- Family member logs expense offline.
- Push accepted if member has expense-create permission.
- Removed member receives deletes on next pull.

---

## Example C: Compoundum workspaces and projects and teams

Setup:
- Principals:
  - `org:o1`
  - `project:p1`
  - `team:t-red`
  - `user:u-alice`
- Resource shares are assigned to these principals.

How recommendations apply:
- Recommendation 5 allows direct sharing to project and team and org.
- Recommendation 6 resolves user access from membership graph.
- Recommendation 3 ensures each user only syncs project records they can access.

Offline behavior:
- User switches project context and syncs only visible project data.
- Team removal revokes local data via pull delete events.

---

## Example D: Feedtron and shared listening

Setup:
- Each post or session has audience principals.
- Audience can include org-wide plus specific teams.

How recommendations apply:
- Recommendation 5 models audience naturally.
- Recommendation 8 reduces repeated audience-resolution cost.
- Recommendation 3 prevents audience leaks in offline clone and pull.

Offline behavior:
- Device can queue likes and comments offline.
- Push validates audience write permission.

---

## Data model direction (beginner view)

Current simplified share row:
- `resourceId`, `userId`, `level`

Recommended share row:
- `resourceId`, `principalType`, `principalId`, `level`, `grantedBy`, `grantedAt`

Membership table (example):
- `memberUserId`, `principalType`, `principalId`, `role`

This model supports both simple friend sharing and enterprise hierarchy with one consistent pattern.

---

## Simple success criteria checklist

A system is ready for your use cases when all are true:

1. Clone and pull and push and transact all enforce same access control rules.
2. Removing access causes local data removal on next pull.
3. Linked relation queries do not expose restricted child data.
4. Sharing works for users and teams and projects and organizations.
5. Offline edits from unauthorized users are rejected on push.
6. TypeScript and Python services behave the same for security decisions.

---

## Final practical takeaway

For your use cases, the winning approach is:

1. Keep namespace for coarse partitioning.
2. Add principal-based record sharing for fine-grained access.
3. Make sync actor-aware and revocation-aware.
4. Treat offline security as equal to online security.

That combination supports both:
- consumer-style sharing (partner and friends and household), and
- enterprise hierarchy (workspace and org and project and team and individual),

without changing your product model every time the sharing shape changes.

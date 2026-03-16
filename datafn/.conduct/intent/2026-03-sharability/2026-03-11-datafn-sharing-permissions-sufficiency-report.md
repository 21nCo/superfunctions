# DataFn Sharing, Namespacing, and Permissions Sufficiency Audit

Date: 2026-03-11  
Repository: `/Users/serro/Documents/dev/n/superfunctions`  
Scope: `datafn` (TypeScript + Python), focused on sharing, namespacing, permissions, offline/sync suitability for listed product use cases.
Agent: GPT Codex 5.3 extra high
---

## Executive Verdict

Current `datafn` capabilities are **not sufficient** to safely cover all listed sharing and permissions use cases in production, especially when offline sync is required.

What is good now:
- Namespace isolation is strong for coarse partitioning.
- Per-record sharing exists (`shareable`) with `viewer/editor/owner` for **user principals**.
- Field-level read/write policies exist.

What is blocking:
- Critical authz gaps across sync/transact paths (detailed below).
- Share model is user-only (no first-class team/group/org/project principals).
- Offline clone/pull behavior is namespace-wide, not actor-filtered for private shareables.
- Relation expansion can expose unauthorized related data.

Bottom line:
- **Sufficient only for simple namespace-scoped collaboration where everyone in a namespace should see the same data.**
- **Insufficient for mixed-visibility, selective-sharing, and hierarchical B2B access models (workspaces/projects/teams/individuals) with offline-first guarantees.**

---

## Method and Evidence

I reviewed implementation paths for schema/capabilities, server authz, mutation/transact/sync execution, relation expansion, client offline apply/sync engine, and Python parity.

Key files inspected include:
- `datafn/core/src/capabilities.ts`
- `datafn/core/src/schema.ts`
- `datafn/core/src/ns.ts`
- `datafn/server/src/validation/authz.ts`
- `datafn/server/src/routes/query.ts`
- `datafn/server/src/execution/mutation/execute.ts`
- `datafn/server/src/execution/sync/push.ts`
- `datafn/server/src/routes/sync.ts`
- `datafn/server/src/routes/transact.ts`
- `datafn/server/src/execution/transact.ts`
- `datafn/server/src/execution/db-store.ts`
- `datafn/server/src/execution/query/select.ts`
- `datafn/client/src/sync/engine.ts`
- `datafn/client/src/sync/apply.ts`
- `datafn/client/src/storage.ts`
- `datafn/python/datafn/authz.py`
- `datafn/python/datafn/handlers/sync.py`

---

## Current Capability Model (What Exists)

## 1) Namespacing
- Namespace helper is composable string join (`ns("a","b") -> "a:b"`), no built-in hierarchy semantics: `datafn/core/src/ns.ts:13-19`.
- Schema defaults to `namespaced: true`: `datafn/core/src/schema.ts:78-90`.
- Server resolves namespace and optional actor via `namespaceProvider`: `datafn/server/src/server.ts:442-466`.

## 2) Shareable capability
- Access levels are fixed (`viewer|editor|owner`), default visibility (`private|shared`): `datafn/core/src/capabilities.ts:5-12`.
- `shareable` requires `audit` capability: `datafn/core/src/schema.ts:227-233`.
- Query path supports private-record gating via owner (`createdBy`) + permissions rows (`userId`): `datafn/server/src/routes/query.ts:75-110`, `datafn/server/src/execution/query/pushdown.ts:84-99`.
- Mutation path enforces level-based authz for shareable records: `datafn/server/src/execution/mutation/execute.ts:803-851`.

## 3) Permission principal shape
- Principal in API is user-only (`shareWith.userId`): `datafn/server/src/execution/mutation/dfql.ts:31`, `datafn/server/src/validation/mutation.ts:190-223`.
- Permission table schema is user-centric (`resourceId`, `userId`, `level`): `datafn/cli/src/drizzle-codegen.ts:133-147`.

## 4) Static field-level policies
- Read/write policies are schema-declared per resource (not dynamic by role/group at runtime): `datafn/server/src/validation/authz.ts:58-356`.

---

## Critical Findings (Production Blocking)

## F1 (P0): Push path bypasses shareable record-level authorization

Evidence:
- Normal mutation path enforces `resolveAccessLevel` for shareable non-insert ops: `datafn/server/src/execution/mutation/execute.ts:803-851`.
- Sync push mutation execution path does **not** call `resolveAccessLevel`; operations execute directly: `datafn/server/src/execution/sync/push.ts:253-643`.

Impact:
- An actor with push access can modify/delete/share/unshare records in same namespace by ID without level checks.
- This breaks ownership/editor/viewer guarantees for offline-first flows.


## F2 (P0): Transact path drops actor context

Evidence:
- `executeMutation` supports `actorId`: `datafn/server/src/execution/mutation/execute.ts:739-750`.
- Mutation route passes actorId correctly: `datafn/server/src/routes/mutation.ts:194-218`.
- Transact route does not extract actorId: `datafn/server/src/routes/transact.ts:24-195`.
- Transaction executor calls `executeMutation(..., namespace)` without actorId: `datafn/server/src/execution/transact.ts:71-79`.

Impact:
- Shareable authorization inside transact is inconsistent and can reject valid actions or mis-attribute audit.
- Permission behavior differs between `/mutation` and `/transact`.


## F3 (P0): Clone/Pull are namespace-wide and not actor-filtered for private shareables

Evidence:
- Clone/pull handlers receive namespace extractor only, not actor extractor: `datafn/server/src/routes/sync.ts:37-148`, `139-237`.
- Server wiring passes no actor extraction to clone/pull handlers: `datafn/server/src/server.ts:542-559`.
- Clone returns all rows per requested table in namespace: `datafn/server/src/execution/sync/clone.ts:237-257`.
- Pull returns changes by resource/cursor in namespace, no actor ACL filtering: `datafn/server/src/execution/sync/pull.ts:259-340`.

Impact:
- Private shareable data isolation is not preserved in offline sync snapshots/change feeds.
- Any client in same namespace can sync records intended for only specific users.


## F4 (P0): Relation expansion can leak unauthorized related data

Evidence:
- Query authz primarily validates fields on the primary resource; relation tokens are not explicitly policy-gated as relation permissions: `datafn/server/src/validation/authz.ts:88-118`.
- Related records are loaded by ID in `DbDataStore` without shareable actor filtering: `datafn/server/src/execution/db-store.ts:123-253`, `320-380`.
- `expandRelation` materializes full schema fields of related resource: `datafn/server/src/execution/query/select.ts:509-627`.

Impact:
- A permitted query on resource A can expose restricted/private records/fields from related resource B.
- This is especially risky for sensitive domains (health/finance/intimate personal data).


## F5 (P1): Principal model is user-only; no native group/team/org/project principal sharing

Evidence:
- `shareWith` only supports user ID: `datafn/server/src/execution/mutation/dfql.ts:31`.
- Permission tables keyed by `userId`: `datafn/cli/src/drizzle-codegen.ts:135-147`.
- Client share APIs are user-based only: `datafn/client/src/tables/table.ts:250-259`, `datafn/client/src/mutate.ts:48-76`.

Impact:
- Group sharing requires fan-out N permission rows per record per member.
- Membership churn (join/leave team/project) requires massive backfills/cleanup.
- Hierarchical enterprise access patterns cannot be expressed cleanly.


## F6 (P1): `ownerField` exists in types/docs but not enforced in runtime authz

Evidence:
- Declared in core/server types: `datafn/core/src/types.ts:39-43`, `datafn/server/src/core-types.ts:37-41`.
- No runtime usage beyond docs/types (`rg ownerField` only finds docs/types references).

Impact:
- Owner-scoped policies implied by schema are not actually enforced.


## F7 (P1): Python implementation parity is not production-equivalent for authz/sharing

Evidence:
- Python authz returns allow when permissions are missing (`return None`), not deny-by-default: `datafn/python/datafn/authz.py:20-31`, `107-118`.
- No shareable/share/unshare implementation in Python handlers.
- Python sync clone/pull/push are namespace-level and not actor-private aware: `datafn/python/datafn/handlers/sync.py:44-322`.

Impact:
- Cross-language deployments cannot assume equivalent security behavior.


## F8 (P2): Performance and latency risks under real collaboration scale

Evidence and symptoms:
- Private query gating does owner + permission lookups per query: `datafn/server/src/routes/query.ts:86-109`.
- No auto-generated index for `createdBy` on shareable resources (potential scan hotspot).
- Pull canonical loads per-resource changes then flattens and sorts in memory: `datafn/server/src/execution/sync/pull.ts:259-283`.
- WebSocket invalidation is namespace-scoped (not actor-scoped): `datafn/server/src/ws.ts:205-217`.

Impact:
- Higher p95/p99 latency with many resources/users.
- Excess pull wakeups and network churn.
- Poor scaling for large org/project/team usage.

---

## Use-Case Sufficiency Matrix

Status legend:
- `Sufficient`: Works with current built-ins without major security model gaps.
- `Partial`: Implementable with constraints/workarounds; not robust for all production conditions.
- `Insufficient`: Requires platform changes.

| Use case | Status | Practical fit today | Why not fully sufficient |
|---|---|---|---|
| Collections - shared collections | Partial | Works if each collection space is its own namespace and all members can see all data in that namespace | No selective per-member offline-safe visibility inside same namespace |
| Shared memories with partner (trips/dates/occasions) | Partial | Works well with one namespace per couple | Breaks when selective item sharing is needed beyond a fixed pair/group |
| Sharing ideas/inspiration/quotes with friend/partner | Partial | User-to-user `shareable` works for online query/mutation | Sync paths do not enforce private ACL per actor |
| Memotron | Partial | Personal mode works (namespace per user) | Shared/private mixed mode needs ACL-safe sync and richer principals |
| Sharing a particular note/markdown/bookmark | Partial | Online per-record sharing works | Offline clone/pull leakage risk for private shareables |
| Shared space | Sufficient | Namespace model is directly suitable | Assumes all actors in space have same visibility |
| Selftron | Sufficient | Namespace per individual is straightforward | None major if no cross-user sharing |
| Sharing menstrual cycle | Insufficient | Could model data, but domain is high sensitivity | Current sync and relation leaks are unacceptable for this sensitivity level |
| Shared habits/activity tracking | Partial | Namespace-per-group or user-share can work at small scale | Group principal, revocation, and offline ACL correctness missing |
| Pointron | Partial | Namespace-per-group scoreboard possible | Fine-grained role/visibility and group lifecycle are weak |
| Group focus | Partial | Basic group space possible | No first-class team principal + inherited ACL |
| Shared objectives | Partial | Shared namespace/project workable | Mixed private+shared objective visibility not safe offline |
| Events | Partial | Org/project event spaces via namespace | Complex audience targeting needs principal model |
| Finatron | Insufficient | Data model possible | Finance-grade access control/audit parity requires stronger ACL guarantees |
| Shared accounts | Insufficient | Can emulate with per-user shares | User-only ACL and sync gaps are not enough for account-level controls |
| Household expenses | Partial | Small household namespace can work | Per-expense participant ACL and revocation semantics are weak |
| Splitwise | Insufficient | Core record storage possible | Requires participant/group debt graph + robust principal and membership ACL |
| Feedtron | Partial | Shared feed space possible | Audience segmentation (org/project/team/individual) lacks principal hierarchy |
| Shared listening | Partial | Group/room namespace works | Cross-group selective sharing and revocation need principal ACL support |
| Compoundum: Workspaces/Orgs | Partial | Namespace can represent workspace/org | No built-in org-wide role inheritance across sub-scopes |
| Compoundum: Projects/sub-orgs | Partial | Namespace-per-project is possible | Cross-project and inherited policies are manual and brittle |
| Compoundum: Teams/groups | Insufficient | Team namespace works only for coarse sharing | No native team principal membership ACL in permissions tables |
| Compoundum: Individuals | Sufficient | Namespace per user supported | Good for isolated personal data |
| Private resources | Insufficient | Query path has private gating | Clone/pull/relation paths break private guarantees |
| Restricted/shared among some groups or individuals | Insufficient | Individuals only via `userId` share rows | Group principals not native; sync ACL enforcement missing |
| Org-wide or project-wide access | Partial | Namespace-per-org/project works | Lacks hierarchical and mixed-scope policy model |

---

## Production Readiness Assessment

## Security Readiness: **Not Ready** for mixed-visibility collaboration

Blocking issues:
- Push ACL bypass (F1).
- Actor loss in transact (F2).
- Actor-blind clone/pull for private shareables (F3).
- Relation expansion leakage (F4).

If deployed now for sensitive shared/private data, confidentiality and authorization guarantees are not reliable.


## Correctness Readiness: **Partial**

- Core namespace partitioning and basic query/mutation path are solid.
- Behavior diverges across endpoints (`mutation` vs `push` vs `transact`).
- Feature semantics differ between TypeScript and Python.


## Performance/Latency Readiness: **Partial**

Current architecture can support moderate loads if namespaces are coarse and visibility is uniform.

Pain points expected at scale:
- Per-query ACL resolution cost without ACL indexes/caching.
- Pull flatten/sort memory growth with many resources.
- Namespace-wide WS invalidations trigger unnecessary pulls for actor-specific views.


## Offline/Sync Readiness for selective sharing: **Not Ready**

The offline engine itself is robust (monotonic cursors, idempotency, changelog), but server sync payload correctness for actor-private visibility is not enforced.

---

## Practical Usage Guidance (Current State)

Safe patterns you can use immediately:
- Namespace-per-individual (`selftron` style).
- Namespace-per-shared-space where all members can see all records.
- Avoid relying on private per-record shareability for offline clients until sync ACL fixes land.

If you must ship now with existing code:
- Treat `shareable.default: private` as **online-only** behavior.
- Gate `/clone`, `/pull`, `/push` with strict `authorize` policy for sensitive resources.
- Use `/query` + `/mutation` for sensitive selective sharing until sync is corrected.

---

## Recommended Implementation Roadmap

## Phase P0 (must-do before production for selective sharing)

## 1) Unify actor propagation everywhere
- Pass `extractActorId` into transact, clone, pull, reconcile handlers.
- Update `executeTransaction` to pass actorId to `executeMutation`.

Target files:
- `datafn/server/src/server.ts`
- `datafn/server/src/routes/transact.ts`
- `datafn/server/src/execution/transact.ts`
- `datafn/server/src/routes/sync.ts`

## 2) Enforce shareable ACL in push mutation execution
- Reuse centralized access checker for push operations.
- Apply same operation matrix as `/mutation` (`owner/editor/viewer`).
- Require actor presence for private-shareable inserts to avoid orphan invisible rows.

Target files:
- `datafn/server/src/execution/sync/push.ts`
- `datafn/server/src/validation/authz.ts`

## 3) Make clone/pull/reconcile actor-aware for private shareables
- Clone: filter rows per resource by actor access when `shareable.default=private`.
- Pull: filter changes by actor visibility; include deletes/tombstones for revoked access.
- Reconcile: counts must be actor-visible counts, not namespace totals.

Target files:
- `datafn/server/src/execution/sync/clone.ts`
- `datafn/server/src/execution/sync/pull.ts`
- `datafn/server/src/execution/sync/reconcile.ts`

## 4) Close relation authorization leaks
- Read authz must validate relation tokens and nested traversals against policy.
- Relation materialization must apply target-resource policy and shareable visibility.

Target files:
- `datafn/server/src/validation/authz.ts`
- `datafn/server/src/execution/db-store.ts`
- `datafn/server/src/execution/query/select.ts`


## Phase P1 (needed for full use-case coverage)

## 5) Introduce principal-based sharing (not only userId)

Evolve permission model from:
- `(resourceId, userId, level)`

to:
- `(resourceId, principalType, principalId, level)`

Recommended principal types:
- `user`, `team`, `group`, `project`, `org`, `workspace`.

Backwards compatibility:
- Keep accepting `{ shareWith: { userId } }`.
- Add new shape `{ shareWith: { principal: { type, id }, level } }`.

Also add membership graph:
- `actor -> principals` resolution for effective access.

Target files:
- `datafn/cli/src/drizzle-codegen.ts`
- `datafn/server/src/execution/mutation/dfql.ts`
- `datafn/server/src/validation/mutation.ts`
- `datafn/server/src/execution/mutation/share.ts`
- `datafn/client/src/mutate.ts`, `datafn/client/src/tables/table.ts`

## 6) Implement `ownerField` runtime enforcement or remove it
- Either wire it into authz checks and docs/tests, or remove from schema surface.


## Phase P2 (performance and latency hardening)

## 7) Indexing for ACL-heavy workloads
- Auto-index `createdBy` for shareable resources.
- Add indexes for principal resolution patterns:
  - `(__ns, principal_type, principal_id)`
  - `(__ns, resource_id)`
  - `(__ns, resource_id, principal_type, principal_id)` unique.

## 8) Access resolution caching
- Short-TTL cache for effective principal memberships and per-record access checks.
- Invalidate on share/unshare/membership changes.

## 9) Pull scalability improvements
- Replace full in-memory flatten/sort of resource changes with k-way merge iterator.
- Add bounded per-resource prefetch and streaming emission.

## 10) WebSocket granularity
- Move from namespace-only cursor invalidation to actor/principal-aware channels or payload hints to reduce unnecessary pulls.


## Phase P3 (cross-language parity and operational confidence)

## 11) Python parity plan
- Align deny-by-default behavior with TS.
- Add shareable capability and principal model parity.
- Align sync actor filtering semantics.

## 12) Docs and migration
- Update docs to clearly separate:
  - namespace-level collaboration,
  - actor-private shareability,
  - principal-based sharing.
- Provide migration guides for permission schema v2.

---

## Offline/Sync Invariants to Preserve While Fixing

Any ACL/sync redesign should preserve these guarantees:
- Monotonic cursor advancement (`serverSeq`) and idempotent apply.
- Deterministic application order for pull changes.
- No resurrection of revoked records (must emit deterministic delete/tombstone events).
- Existing changelog/idempotency semantics.
- Namespace-based local storage partitioning, with optional actor-layer partitioning where needed.

Current relevant implementation anchors:
- Cursor monotonicity and apply paths: `datafn/client/src/sync/apply.ts:232-275`
- Sync loop and retries/backoff: `datafn/client/src/sync/engine.ts`
- Offline storage contract: `datafn/client/src/storage.ts`

---

## Test Plan Required Before Marking Ready

## Security tests
- Push: viewer/editor/owner matrix parity with mutation endpoint.
- Transact: same ACL outcomes as mutation endpoint for identical operations.
- Clone/pull: actor A cannot receive actor B private records in same namespace.
- Relation traversal: unauthorized related fields/records are not exposed.

## Correctness tests
- Share/unshare revocation emits proper delete/tombstone on pull.
- Membership change affects effective access without stale grants.
- `ownerField` behavior (if kept) has deterministic enforcement.

## Performance tests
- Query p95/p99 with 100k+ permission rows.
- Pull latency under multi-resource high-change workloads.
- WS-triggered pull amplification under many actor-specific clients.

## Parity tests
- TS vs Python behavior matrix for authz and sync visibility.

---

## Final Sufficiency Answer

For the full set of requested cases (consumer sharing + Compoundum org/project/team/individual hierarchy + private/group/org-wide scopes + offline-first), **current DataFn sharing and namespacing is not sufficient**.

It can support a subset today (coarse namespace-sharing and individual isolation), but to cover all use cases safely and at production quality, the platform needs:
- endpoint-consistent actor-aware ACL enforcement,
- principal-based sharing beyond user IDs,
- actor-filtered sync semantics,
- relation-safe authz/materialization,
- and cross-language parity.


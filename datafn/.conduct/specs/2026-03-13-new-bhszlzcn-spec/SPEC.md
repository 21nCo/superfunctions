# Metadata
- Timestamp: 2026-03-13T12:48:28Z
- agent_name: unknown-agent
- model: gpt-5-codex
- launcher: Codex Desktop
- Workspace: `/Users/serro/Documents/dev/n/superfunctions`
- OS + shell: `Darwin 25.3.0 (arm64)`, `zsh`
- Git:
  - branch: `heads/next`
  - commit: `5fe59b66a1ebf692ef723eb68f708e60a90de457`
  - dirty: `true` (228 changed files at spec generation time)
- spec_folder: `2026-03-13-new-bhszlzcn-spec`
- spec_folder_path: `/Users/serro/Documents/dev/n/superfunctions/.conduct/specs/2026-03-13-new-bhszlzcn-spec`
- spec_type: `new`
- spec_id: `bhszlzcn`
- Input paths read:
  - `/Users/serro/.codex/skills/spec/SKILL.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/intent/2026-03-sharability/2025-03-12-datafn-sharing-scenarios.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/intent/2026-03-sharability/2026-03-11-datafn-sharing-permissions-sufficiency-report.md`
- Audit-fix linkage: `N/A` (this spec is `new`, not explicitly requested as audit-fix)

## Overview
Project name: Superfunctions DataFn

One-sentence goal:
Implement a production-grade, capability-native sharing and permissions architecture in `datafn` that supports selective collaboration, cross-namespace sharing, principal hierarchies, and offline-safe sync semantics across all listed consumer and B2B use cases.

Target users:
- DataFn framework maintainers.
- Product teams building Nucleus-family apps (Collections, Memotron, Selftron, Pointron, Finatron, Feedtron, Compoundum).
- Backend teams requiring secure offline-first collaboration with mixed visibility.

Target environments:
- TypeScript server runtime (`@datafn/server`) with SQL adapters.
- TypeScript client runtime (`@datafn/client`) with offline storage and sync engine.
- Python runtime parity (`datafn/python`).
- Online and offline operation, including push/pull/clone/reconcile.

Languages/packages required:
- TypeScript (`datafn/core`, `datafn/server`, `datafn/client`, `datafn/cli`).
- Python (`datafn/python`).

Existing systems to integrate:
- Existing DataFn capabilities model and DFQL APIs.
- Namespace/actor extraction via `namespaceProvider`.
- Existing changelog/idempotency/sync cursor machinery.
- Existing `authorize` callback model.

Data model summary:
- Resource records in namespaced tables.
- Global sharing permissions table keyed by resource and principal.
- Principal memberships table (actor -> direct principal memberships).
- Principal hierarchy table (principal -> parent principal).
- Optional relation-inheritance grants derived from configured parent relations.
- System-managed visibility column per share-enabled resource.

Security model:
- Multi-tenant namespaces remain isolation boundaries for baseline access.
- Per-record and scope-level authorization via capability-managed ACL resolution.
- Actor-aware authorization on query/mutation/transact/sync/relation expansion.
- PII-sensitive domains (health/finance/intimate personal data) require strict deny-by-default and revoke-safe sync.

Performance constraints:
- MUST support principal/permission cardinalities at enterprise scale (100k+ permission rows per tenant) without full-table scans in hot paths.
- Pull latency MUST remain bounded without unbounded flatten+sort memory growth.
- Hierarchy evaluation SHOULD avoid write amplification and expensive full recomputation.

Non-goals:
- Implementing external identity provider management inside DataFn.
- Designing end-user UI/UX patterns.
- Replacing namespace model with a universal graph store.

Hard constraints:
- Sharing system MUST be capability-native (not plugin-only).
- Offline sync invariants MUST be preserved (cursor monotonicity, idempotency, deterministic application order).
- No scope deferral: full intent coverage is in scope.

## Glossary
- Namespace (`__ns`): Server-derived data partition key for baseline isolation.
- Actor: Authenticated caller identity from `namespaceProvider.getActorId`.
- Principal: Opaque identity string used in ACL grants (`user:alice`, `team:eng`, `role:editor`, etc.).
- Direct membership: Mapping from actor to principals directly assigned.
- Hierarchy: Parent chain among principals for inherited access.
- Resource-level grant: ACL grant for one record (`resourceId` set).
- Scope-level grant: ACL grant for all records of resource type in namespace (`resourceId = null`).
- Visibility: System column on share-enabled resources with values `null`, `private`, `shared`.
- Shared-with-me query mode: Query mode that returns records across namespaces where actor has grant.
- Relation inheritance: Access to child/linked records mediated by granted parent record.
- Tombstone revoke event: Pull/clone-visible delete change emitted when access is revoked.

## Goals / Non-goals
### Goals
1. DataFn MUST support all listed sharing scenarios with one canonical capability architecture.
2. DataFn MUST enforce consistent authorization across query, mutation, transact, clone, pull, push, reconcile, and relation expansion.
3. DataFn MUST support principal-based grants beyond user-only sharing.
4. DataFn MUST support cross-namespace sharing without weakening namespace baseline isolation.
5. DataFn MUST preserve offline sync guarantees while preventing stale access after revoke/delete.

### Non-goals
1. DataFn will not implement external IAM provisioning lifecycle (create org/team/project entities) beyond storing and resolving opaque principal IDs.
2. DataFn will not define product-specific UI workflows for share dialogs or consent prompts.
3. DataFn will not infer principal semantics from ID format beyond equality and resolver lookups.

## Public API
### Capability configuration (TypeScript schema)
DataFn MUST extend `shareable` capability config to support v2 semantics while preserving v1 compatibility.

Canonical capability shape:
```ts
type ShareableV2Config = {
  levels: Array<"viewer" | "editor" | "owner">;
  default?: "private" | "shared"; // legacy compatibility
  visibilityDefault?: "ns" | "private" | "shared"; // v2 canonical
  crossNsShareable?: boolean; // default true
  supportsScopeGrants?: boolean; // default true
  principalMode?: "opaque-id"; // default opaque-id
  relationInheritance?: {
    enabled: boolean;
    relations?: string[]; // relation names or from->to signatures
    requireRelateConsent?: boolean; // default true
  };
};
```

### DFQL mutation API
#### Share mutation
```json
{
  "resource": "notes",
  "version": 1,
  "operation": "share",
  "id": "note_1",
  "shareWith": {
    "principalId": "user:bob",
    "level": "editor"
  },
  "scope": "record"
}
```

Canonical rules:
- `scope` MAY be omitted and defaults to `record`.
- For scope grants, `scope = "resource"` and `id` MUST be absent.
- Legacy shape `{ "shareWith": { "userId": "bob" } }` MUST remain accepted and canonicalized to `principalId = "user:bob"`.

#### Unshare mutation
```json
{
  "resource": "notes",
  "version": 1,
  "operation": "unshare",
  "id": "note_1",
  "shareWith": {
    "principalId": "user:bob"
  },
  "scope": "record"
}
```

### DFQL query API
#### Shared-with-me query mode
```json
{
  "resource": "notes",
  "version": 1,
  "operation": "find",
  "metadata": {
    "accessMode": "sharedWithMe",
    "includeOwn": true,
    "namespaceFilter": ["org:acme", "user:alice"]
  },
  "limit": 50
}
```

Canonical rules:
- `accessMode` values: `"namespace"` (default), `"sharedWithMe"`.
- `sharedWithMe` mode MUST join against global permissions with actor principals.
- `namespaceFilter` MAY narrow result namespaces but MUST NOT broaden beyond authorized grants.

#### Permissions inspection query
```json
{
  "resource": "notes",
  "version": 1,
  "operation": "getPermissions",
  "id": "note_1"
}
```

Response includes direct grants and scope grants relevant to resource namespace.

### Provider interfaces (capability internal extension points)
These are capability extension points, not standalone plugin authority:
```ts
type PrincipalResolver = {
  getDirectMemberships(actorId: string, namespace: string): Promise<string[]>;
  getHierarchyParents(principalIds: string[], namespace: string): Promise<Array<{ principalId: string; parentPrincipalId: string }>>;
};

type SharePolicyProvider = {
  canShareAcrossNamespace(input: { resource: string; fromNs: string; toPrincipalId: string }): Promise<boolean>;
  canRelateIntoSharedParent(input: { actorId: string; parentResource: string; parentId: string; childResource: string; childId: string }): Promise<boolean>;
};
```

## Data formats / protocol
### Canonical server envelopes
Success:
```json
{ "ok": true, "result": { "data": [] } }
```

Error:
```json
{
  "ok": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Authorization denied",
    "details": { "path": "operation" }
  }
}
```

### New/extended error codes
- `DFQL_SHARE_SCOPE_INVALID`: invalid `scope`/`id` combination.
- `DFQL_PRINCIPAL_INVALID`: invalid principal input.
- `DFQL_CROSS_NS_SHARE_FORBIDDEN`: resource policy blocks cross-namespace share.
- `DFQL_VISIBILITY_INVALID`: invalid visibility assignment attempt.
- `DFQL_RELATION_INHERITANCE_FORBIDDEN`: relation inheritance disallowed by policy.
- `DFQL_REVOKE_TOMBSTONE_REQUIRED`: internal consistency check failure when revoke lacks tombstone emission.
- Existing codes (`FORBIDDEN`, `DFQL_INVALID`, `NOT_FOUND`, `CONFLICT`, `DFQL_UNSUPPORTED`) remain valid.

### Global permissions table (canonical)
```sql
__datafn_permissions_global (
  id text primary key,
  resourceType text not null,
  resourceNs text not null,
  resourceId text null,
  principalId text not null,
  level text not null,
  grantKind text not null, -- record | scope | relation_inherited
  sourceRef text null, -- parent ref for inherited grants
  grantedBy text not null,
  grantedAt bigint not null,
  revokedAt bigint null
)
```

Normative constraints:
- `(resourceType, resourceNs, resourceId, principalId)` MUST be unique for active grants when `resourceId` non-null.
- `(resourceType, resourceNs, principalId)` MUST be unique for active scope grants when `resourceId` is null.

### Membership and hierarchy tables (canonical)
```sql
__datafn_principal_memberships (
  id text primary key,
  namespace text not null,
  actorId text not null,
  principalId text not null,
  grantedAt bigint not null,
  revokedAt bigint null
)

__datafn_principal_hierarchy (
  id text primary key,
  namespace text not null,
  principalId text not null,
  parentPrincipalId text not null,
  createdAt bigint not null,
  revokedAt bigint null
)
```

### Resource visibility column
Every share-enabled resource MUST have system-managed column:
```sql
visibility text null check (visibility in ('private', 'shared') or visibility is null)
```
Semantics:
- `null` => namespace-wide visibility semantics (`ns`).
- `private` => non-owner access requires explicit grant.
- `shared` => explicit sharing exists or existed; auth remains source-of-truth in permissions tables.

## Semantics
### Capability and plugin boundary
1. Sharing authorization, grant persistence, sync filtering, and relation inheritance MUST be implemented in capability core paths.
2. Plugins MAY observe/transform payloads but MUST NOT be relied upon as sole enforcement for ACL correctness.
3. Provider interfaces MAY be plugged into capability internals for principal resolution/policy checks.

### Access resolution algorithm (canonical)
For a given `(actorId, resourceType, resourceNs, resourceId, operation)`:
1. Resolve actor effective principals:
   - direct memberships from `__datafn_principal_memberships`.
   - recursive parents from `__datafn_principal_hierarchy` using cached hierarchy.
   - include synthetic `user:{actorId}` principal.
2. Collect grants in precedence order:
   - owner grant (record creator or explicit owner grant).
   - record grants (`resourceId = target`).
   - relation-inherited grants (if relation inheritance enabled and relation chain proves entitlement).
   - scope grants (`resourceId is null`).
3. Determine effective level = max(`viewer` < `editor` < `owner`).
4. Evaluate operation matrix:
   - read/query/select: viewer+.
   - merge/replace/relate/modifyRelation: editor+.
   - share/unshare/delete/hard-security operations: owner only.
5. Apply resource field permissions policy.

### Query semantics
1. Namespace mode (`accessMode` absent or `namespace`) MUST keep `__ns = namespace` baseline.
2. Shared-with-me mode MUST support cross-namespace result retrieval using global permissions joins.
3. Visibility is a query optimization hint only; permissions and owner resolution remain authoritative.
4. DataFn MUST NOT add a `cross-shared` visibility value.

### Mutation semantics
1. `share` and `unshare` MUST support record and scope grants.
2. Share-time policy MUST reject cross-namespace sharing when `crossNsShareable = false`.
3. Legacy `userId` mutation shape MUST canonicalize to opaque principal IDs.
4. Scope grant (`resourceId = null`) MUST apply to all current and future records in that `(resourceType, resourceNs)` until revoked.

### Relation inheritance semantics
1. If configured, sharing parent record MUST grant access to linked children without per-child grant rows.
2. Relation inheritance MUST be revocable and MUST produce deterministic tombstones/revokes on access loss.
3. Relate/unrelate operations involving shared parents MUST enforce permission and consent rules.

### Sync semantics
1. Actor propagation MUST be present in clone/pull/push/reconcile/transact execution paths.
2. Clone and pull MUST return only actor-visible rows for private/shared selective resources.
3. Revokes and delete loss of visibility MUST emit tombstones so offline clients delete inaccessible rows.
4. Grant gain MAY emit backfill events; ordering MUST remain deterministic by `serverSeq`.
5. Permission/membership/hierarchy changes MUST participate in actor-based sync feed.

## Invariants
1. Cursor monotonicity MUST hold per sync stream.
2. Applying same change batch twice MUST be idempotent.
3. Deterministic ordering MUST be `serverSeq asc, resource asc, id asc` for ties.
4. Revoke/delete non-resurrection: once inaccessible and tombstoned, row MUST NOT reappear unless a newer explicit grant/backfill arrives.
5. Authorization parity invariant: same mutation under same actor/context MUST produce same allow/deny across `/mutation`, `/push`, and `/transact`.

## Security
1. Deny-by-default MUST apply when actor/principal context is missing for share-restricted operations.
2. Relation expansion MUST enforce target resource auth before materialization.
3. Cross-namespace access MUST only occur in explicit shared-with-me mode or explicit `id` lookups authorized by grant.
4. Logs MUST avoid sensitive record payload fields while preserving audit metadata.
5. Principal IDs are opaque strings; DataFn MUST NOT interpret semantics beyond exact matching.

## Limits/caps
Default caps (configurable):
- Max principals resolved per actor per request: `10,000`.
- Max hierarchy depth resolved: `32`.
- Max shareWith entries per batch mutation: `500`.
- Max related inheritance expansion depth: `5`.
- Max shared-with-me query limit: `1000`.

Behavior at limits:
- Exceeding caps MUST return deterministic `LIMIT_EXCEEDED` with path details.

## Observability
1. DataFn MUST emit structured events for `grant_created`, `grant_revoked`, `scope_grant_created`, `scope_grant_revoked`, `inheritance_grant_effective`, `inheritance_grant_revoked`, `sync_revoke_tombstone_emitted`.
2. Logs MUST include `actorId`, `namespace`, `resourceType`, `resourceId`, `principalId`, `grantKind`, `serverSeq` where applicable.
3. Logs MUST NOT include encrypted fields, raw note body/markdown/bookmark content, menstrual/health details, or finance transaction descriptions by default.
4. Metrics MUST include p50/p95/p99 for access resolution, pull build time, and permission join latency.

## Compatibility / versioning strategy
1. This spec defines Sharing Protocol Version 2 (`SPV2`).
2. Migration MUST support dual-read for existing per-resource `__datafn_permissions_{resource}` and new global permissions table until cutover completes.
3. Write path during migration SHOULD dual-write for a bounded migration window.
4. Client APIs MUST preserve `table.share(id, userId, level)` while adding principal-aware overloads.
5. Python and TypeScript behavior MUST converge for allow/deny outcomes and sync visibility.

## Undefined / Explicitly user-deferred only
Undefined (not required by this spec):
1. Visual UX flow for consent prompts.
2. External billing implications of sharing features.
3. Automated principal lifecycle provisioning (create/delete org/team/project entities).
4. Multi-region replication strategy.

No user-deferred items were provided.

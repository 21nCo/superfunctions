# SPV2 Architecture Decision

Date: 2026-03-13
Status: Accepted (Phase 00)
Scope: DataFn sharing/permissions architecture foundation for SPV2

## Decision Summary
DataFn will implement SPV2 sharing as a **capability-first** architecture in core runtime paths, not as plugin-only enforcement.

Core decisions:
1. Sharing and ACL enforcement live in DataFn capability execution paths across query/mutation/transact/clone/pull/push/reconcile.
2. Cross-namespace sharing uses a global permissions model (resource namespace as data), with explicit query mode selection.
3. Query modes are explicit:
- `namespace` (default): namespace-scoped access.
- `sharedWithMe`: cross-namespace access for actor-authorized resources.
4. Visibility remains tri-state-compatible with no fourth state; specifically, `cross-shared` is rejected.
5. Namespace remains a colocation/isolation primitive; it is not the membership graph.
6. Principal identities are opaque strings with membership/hierarchy resolution handled by capability-integrated resolver services.

## Why This Decision
This decision is required to satisfy:
- `ARCH-001`: capability-native enforcement with plugin independence.
- `ARCH-004`: explicit query-mode split and no `cross-shared` state.
- `USE-001`: one coherent model covering all listed consumer + enterprise use cases.

Plugin-only enforcement is insufficient for production because ACL safety must hold identically on sync and transaction paths where plugin behavior may be optional or non-authoritative.

## Considered Options
### Option A: Permissions-first dual query path with namespace-scoped permissions storage
Pros:
- Minimal conceptual change from current model.
- Keeps most default namespace queries unchanged.

Cons:
- Splits logic into multiple special-case pathways.
- Cross-namespace behavior remains awkward and less index-friendly.
- Harder to maintain deterministic, single-source ACL semantics across endpoints.

Decision: Rejected.

### Option B: Global permissions table with `resourceNs` data column
Pros:
- One coherent model for both intra-namespace and cross-namespace sharing.
- Clean shared query planning, especially for `sharedWithMe`.
- Better extensibility for principal-based and scope-level grants.

Cons:
- Requires migration and stricter sync/authz discipline.

Decision: Accepted.

### Option C: Shadow references in recipient namespace
Pros:
- Keeps recipient query shape simple.

Cons:
- Write amplification on share/revoke.
- Risk of shadow/reference drift.
- Adds lifecycle complexity without improving ACL model quality.

Decision: Rejected.

## Query Model (Normative)
1. `namespace` mode MUST preserve namespace-scoped baseline behavior.
2. `sharedWithMe` mode MUST use permissions-derived candidate sets across namespaces.
3. Records MUST NOT use a fourth visibility state named `cross-shared`.
4. Any config/payload attempting `cross-shared` MUST fail validation.

## Capability vs Plugin Boundary
1. Core authorization, visibility filtering, grant persistence, and sync revoke/backfill semantics MUST be capability-resident.
2. Plugins MAY augment telemetry, payload transforms, or optional policy checks.
3. Plugins MUST NOT be required for baseline ACL correctness.
4. Provider interfaces (principal resolver/share policy) MAY be used internally by capability code.

## Security and Sync Implications
1. Actor propagation is mandatory across all endpoints.
2. Clone/pull/reconcile must be actor-visible filtered for selective/private resources.
3. Push/transact ACL behavior must match mutation behavior.
4. Revokes must emit deterministic tombstones for offline deletion.

## Use-Case Fit Statement
This architecture is selected because it can model:
- Partner sharing and selective private items.
- Shared collections with relation inheritance.
- Long-running scope-sharing (e.g., cycle data).
- Household and team collaboration.
- Org/project/team/individual hierarchies.

## Non-Decisions
1. UI/UX flows for share dialogs and consent messaging.
2. External IAM lifecycle/provisioning ownership.
3. Multi-region replication strategy.

## Acceptance Evidence (Phase 00)
- `capability-first` appears in this decision (for verification automation).
- `sharedWithMe` appears in this decision (query mode lock).
- `cross-shared` appears in this decision as disallowed state.

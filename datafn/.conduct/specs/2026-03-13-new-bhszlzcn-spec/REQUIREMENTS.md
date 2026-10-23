# Requirements

## Table of Contents
- ARCH-001
- ARCH-002
- ARCH-003
- ARCH-004
- ARCH-005
- ARCH-006
- API-001
- API-002
- API-003
- API-004
- AUTH-001
- AUTH-002
- AUTH-003
- AUTH-004
- AUTH-005
- AUTH-006
- REL-001
- REL-002
- SYNC-001
- SYNC-002
- SYNC-003
- SYNC-004
- PERF-001
- PERF-002
- PERF-003
- COMP-001
- COMP-002
- PY-001
- SEC-001
- USE-001
- DOC-001
- TEST-001

## ARCH-001
- ID: ARCH-001
- Priority: P0
- Statement: Sharing and permissions enforcement MUST be implemented as a first-class DataFn capability rather than plugin-only logic.
- Rationale: ACL correctness must be deterministic and endpoint-parity-safe across sync and mutation surfaces.
- Acceptance criteria:
  - Capability configuration enables all share authorization behavior without requiring a plugin.
  - Disabling plugins does not disable core ACL enforcement.
  - Provider interfaces are optional extensions, not mandatory guards.
- Test vectors: TV-ARCH-001-P, TV-ARCH-001-N
- Notes: Plugins may add policy checks, analytics, or transforms, but cannot be sole security boundary.

## ARCH-002
- ID: ARCH-002
- Priority: P0
- Statement: DataFn MUST store grants in a global permissions table that includes `resourceNs` as data, not as row partition key.
- Rationale: Cross-namespace access and shared-with-me queries require one consistent permission model.
- Acceptance criteria:
  - One global permissions table exists for all resources.
  - Table supports both record grants and scope grants (`resourceId = null`).
  - Cross-namespace query path uses joins against this table.
- Test vectors: TV-ARCH-002-P, TV-ARCH-002-N
- Notes: Per-resource permission tables may exist during migration only.

## ARCH-003
- ID: ARCH-003
- Priority: P0
- Statement: Every share-enabled resource MUST have system-managed `visibility` with values `null`, `private`, or `shared`.
- Rationale: Tri-state visibility enables performant query pruning while preserving ACL source-of-truth in grants.
- Acceptance criteria:
  - Column exists and is not user-writable.
  - Invalid visibility writes are rejected.
  - Query planning uses visibility for optimization only.
- Test vectors: TV-ARCH-003-P, TV-ARCH-003-N
- Notes: `null` represents namespace-wide (`ns`) behavior.

## ARCH-004
- ID: ARCH-004
- Priority: P1
- Statement: DataFn MUST differentiate intra-namespace and cross-namespace access by query mode and MUST NOT introduce a fourth `cross-shared` visibility state.
- Rationale: Access location is a query concern, not a record-state dimension.
- Acceptance criteria:
  - `accessMode=namespace` and `accessMode=sharedWithMe` both work with the same visibility values.
  - Any payload or schema attempt to set `cross-shared` fails validation.
- Test vectors: TV-ARCH-004-P, TV-ARCH-004-N
- Notes: Prevents visibility churn on grant topology changes.

## ARCH-005
- ID: ARCH-005
- Priority: P0
- Statement: Principal identifiers MUST be treated as opaque strings and MUST be the canonical grant subject model.
- Rationale: User/team/role/org/project patterns require extensible identity expression without schema churn.
- Acceptance criteria:
  - Grant APIs accept `principalId` and do not require fixed principal enums.
  - Legacy `userId` inputs canonicalize to a principal form.
  - ACL checks operate on string equality and membership expansion.
- Test vectors: TV-ARCH-005-P, TV-ARCH-005-N
- Notes: `principalType` is optional metadata and not required for core matching.

## ARCH-006
- ID: ARCH-006
- Priority: P1
- Statement: Effective principal expansion MUST use direct memberships plus cached hierarchy traversal rather than flattened membership fan-out writes.
- Rationale: Hierarchy re-parenting must remain cheap and consistent.
- Acceptance criteria:
  - Direct memberships table stores only direct assignments.
  - Hierarchy cache invalidates on hierarchy mutation.
  - Effective principal set is deterministic for identical input snapshot.
- Test vectors: TV-ARCH-006-P, TV-ARCH-006-N
- Notes: Maximum depth checks prevent cyclic traversal blowups.

## API-001
- ID: API-001
- Priority: P0
- Statement: Share/unshare mutation payloads MUST support principal-based shapes and MUST preserve backward-compatible `userId` shape.
- Rationale: Compatibility is required while enabling principal model expansion.
- Acceptance criteria:
  - `shareWith.principalId` is accepted.
  - `shareWith.userId` is accepted and canonicalized.
  - Invalid mixed/empty shapes fail with deterministic errors.
- Test vectors: TV-API-001-P, TV-API-001-N
- Notes: Canonicalized payloads should be observable in debug/test hooks.

## API-002
- ID: API-002
- Priority: P0
- Statement: Scope-level sharing MUST be supported via grants where `scope=resource` and `resourceId=null`.
- Rationale: Indefinite and bulk sharing use cases need type-wide grant semantics.
- Acceptance criteria:
  - Scope grants can be created and revoked.
  - Scope grants affect current and future records in the resource namespace.
  - Invalid record/scope combinations fail.
- Test vectors: TV-API-002-P, TV-API-002-N
- Notes: Example: long-term cycle sharing and household/account sharing.

## API-003
- ID: API-003
- Priority: P0
- Statement: Query API MUST support explicit `accessMode=sharedWithMe` for cross-namespace retrieval of authorized records.
- Rationale: Cross-namespace sharing should be explicit and discoverable.
- Acceptance criteria:
  - Shared-with-me mode returns authorized records across namespaces.
  - Namespace mode remains namespace-scoped.
  - Unauthorized cross-namespace records are excluded.
- Test vectors: TV-API-003-P, TV-API-003-N
- Notes: Optional `namespaceFilter` narrows, never broadens, access.

## API-004
- ID: API-004
- Priority: P1
- Statement: DataFn MUST expose permission inspection that returns direct, scope, and inherited grants relevant to a target resource.
- Rationale: Debugging and admin workflows require explainable access.
- Acceptance criteria:
  - Owners can request full grant breakdown.
  - Non-owners are denied full permission inspection.
  - Response includes grant kind and source reference when inherited.
- Test vectors: TV-API-004-P, TV-API-004-N
- Notes: Response shape must be deterministic and documented.

## AUTH-001
- ID: AUTH-001
- Priority: P0
- Statement: Actor context MUST propagate to query, mutation, transact, clone, pull, push, and reconcile execution layers.
- Rationale: Missing actor context causes authorization drift and audit mis-attribution.
- Acceptance criteria:
  - All endpoint executors receive actor context when available.
  - Missing actor context follows explicit deny/fallback rules.
  - Audit fields stay consistent across endpoints.
- Test vectors: TV-AUTH-001-P, TV-AUTH-001-N
- Notes: Must close transact and sync actor propagation gaps.

## AUTH-002
- ID: AUTH-002
- Priority: P0
- Statement: Push execution MUST enforce the same shareable operation matrix as mutation execution.
- Rationale: Offline push must not bypass record-level ACL checks.
- Acceptance criteria:
  - Viewer/editor/owner operation allow/deny is identical for `/mutation` and `/push`.
  - Unauthorized push operations return `FORBIDDEN`.
- Test vectors: TV-AUTH-002-P, TV-AUTH-002-N
- Notes: Includes share/unshare/delete/relate and capability operations.

## AUTH-003
- ID: AUTH-003
- Priority: P0
- Statement: Transact execution MUST produce the same ACL outcomes as equivalent non-transactional mutation sequences.
- Rationale: Endpoint semantics must be consistent under transaction wrapping.
- Acceptance criteria:
  - Same actor + same operations => same allow/deny and side effects.
  - Transaction abort behavior is deterministic on first forbidden step.
- Test vectors: TV-AUTH-003-P, TV-AUTH-003-N
- Notes: Also requires consistent audit attribution.

## AUTH-004
- ID: AUTH-004
- Priority: P0
- Statement: Clone, pull, and reconcile MUST be actor-visible filtered for selective/private shareable resources.
- Rationale: Offline snapshots/feeds must not leak records unavailable to caller.
- Acceptance criteria:
  - Clone excludes inaccessible private rows.
  - Pull excludes inaccessible changes and emits revoke tombstones.
  - Reconcile counts are actor-visible counts.
- Test vectors: TV-AUTH-004-P, TV-AUTH-004-N
- Notes: Applies regardless of whether actor shares namespace with owner.

## AUTH-005
- ID: AUTH-005
- Priority: P0
- Statement: Relation expansion MUST enforce target-resource authorization and field policy before materialization.
- Rationale: Authorized root queries must not leak related restricted data.
- Acceptance criteria:
  - Unauthorized related records are omitted or redacted deterministically.
  - Unauthorized related field access fails with deterministic error where policy requires hard fail.
- Test vectors: TV-AUTH-005-P, TV-AUTH-005-N
- Notes: Must apply in nested traversal chains.

## AUTH-006
- ID: AUTH-006
- Priority: P1
- Statement: DataFn MUST either enforce `ownerField` at runtime or remove it from public schema surface, and this spec chooses enforcement.
- Rationale: Declared authorization fields must have runtime effect.
- Acceptance criteria:
  - `ownerField` checks are applied in write/read authorization where configured.
  - Misconfigured `ownerField` produces clear validation error.
- Test vectors: TV-AUTH-006-P, TV-AUTH-006-N
- Notes: If enforcement is impossible in a backend, that backend is non-conformant.

## REL-001
- ID: REL-001
- Priority: P0
- Statement: Configured relation inheritance MUST grant linked-child visibility from shared parent without requiring per-child direct grants.
- Rationale: Collection/focus/account/habit patterns depend on parent-proxy sharing.
- Acceptance criteria:
  - Parent share immediately affects linked children visibility.
  - Parent unshare/revoke removes inherited child visibility.
  - Effective access explanation includes inheritance source.
- Test vectors: TV-REL-001-P, TV-REL-001-N
- Notes: Applies across same-namespace and cross-namespace link scenarios when policy permits.

## REL-002
- ID: REL-002
- Priority: P1
- Statement: Relate/unrelate into shared parents MUST enforce actor permission and explicit consent semantics when auto-sharing implications exist.
- Rationale: Members must not silently broaden sharing scope without authorization and awareness.
- Acceptance criteria:
  - Relate by unauthorized actor fails.
  - Required consent flag absent => deterministic rejection.
  - Authorized + consented relate succeeds and updates inheritance graph.
- Test vectors: TV-REL-002-P, TV-REL-002-N
- Notes: Consent requirement may be resource-configurable but default must be true for relation inheritance.

## SYNC-001
- ID: SYNC-001
- Priority: P0
- Statement: Access revoke, unshare, and share-induced visibility loss MUST emit deterministic tombstones so offline stores remove inaccessible rows.
- Rationale: Prevent stale sensitive data retention after revoke.
- Acceptance criteria:
  - Pull stream contains tombstone for previously visible row now inaccessible.
  - Offline apply removes row and keeps cursor progression.
  - Missing tombstone in required scenario fails invariants test.
- Test vectors: TV-SYNC-001-P, TV-SYNC-001-N
- Notes: Covers direct, scope, and inherited grants.

## SYNC-002
- ID: SYNC-002
- Priority: P1
- Statement: New grants that reveal previously unseen rows MUST produce deterministic backfill behavior compatible with existing cursor model.
- Rationale: Offline clients need authoritative mechanism to obtain newly authorized historical data.
- Acceptance criteria:
  - Grant event causes eligible row appearance via pull/cloneUp mechanism.
  - Backfill ordering is deterministic and idempotent.
  - Duplicate backfill does not duplicate local rows.
- Test vectors: TV-SYNC-002-P, TV-SYNC-002-N
- Notes: Implementation may use synthetic change rows or targeted clone-up, but behavior must match vectors.

## SYNC-003
- ID: SYNC-003
- Priority: P0
- Statement: Existing sync invariants (cursor monotonicity, deterministic apply order, idempotency) MUST remain preserved under sharing changes.
- Rationale: Sharing extensions must not destabilize offline engine correctness.
- Acceptance criteria:
  - Monotonic cursor progression remains true under grant/revoke churn.
  - Same batch applied twice produces same terminal state.
  - Ordering tie-breakers are deterministic.
- Test vectors: TV-SYNC-003-P, TV-SYNC-003-N
- Notes: Non-deterministic ordering is non-conformant.

## SYNC-004
- ID: SYNC-004
- Priority: P1
- Statement: Permissions, memberships, and hierarchy changes relevant to actor visibility MUST be represented in an actor-based sync feed.
- Rationale: Namespace-only feeds are insufficient for cross-namespace selective sharing.
- Acceptance criteria:
  - Actor pull can detect grant/revoke/membership changes affecting visibility.
  - Feed data does not leak unrelated principals.
  - Cursor semantics for actor feed align with core sync semantics.
- Test vectors: TV-SYNC-004-P, TV-SYNC-004-N
- Notes: Feed may be separate logical stream but must be integrated with visibility application.

## PERF-001
- ID: PERF-001
- Priority: P1
- Statement: DataFn MUST create indexes required for ACL-heavy workloads and hierarchy lookups to avoid scan-bound hot paths.
- Rationale: Selective sharing at scale otherwise degrades latency and throughput.
- Acceptance criteria:
  - Required permission and membership indexes exist after codegen/migration.
  - Query plans for common ACL checks avoid full table scans.
  - Index creation is deterministic across supported SQL dialects.
- Test vectors: TV-PERF-001-P, TV-PERF-001-N
- Notes: Include creator/owner filter indexing for private views.

## PERF-002
- ID: PERF-002
- Priority: P2
- Statement: Pull result assembly MUST avoid unbounded in-memory flatten+sort by using bounded merge strategy.
- Rationale: High-change workloads require memory-safe pull construction.
- Acceptance criteria:
  - Pull algorithm uses bounded k-way merge or equivalent streaming strategy.
  - Peak memory is bounded by configured window, not total change cardinality.
  - Output ordering remains deterministic.
- Test vectors: TV-PERF-002-P, TV-PERF-002-N
- Notes: Must preserve exact envelope compatibility.

## PERF-003
- ID: PERF-003
- Priority: P2
- Statement: WebSocket invalidation SHOULD support actor/principal-aware targeting to reduce redundant pull amplification.
- Rationale: Namespace-only fanout causes unnecessary wakeups.
- Acceptance criteria:
  - Cursor/invalidation channel includes actor/principal scoping hint where supported.
  - Clients unaffected by change are not awakened in targeted mode.
- Test vectors: TV-PERF-003-P, TV-PERF-003-N
- Notes: This is SHOULD to permit transport fallback while preserving correctness.

## COMP-001
- ID: COMP-001
- Priority: P0
- Statement: Migration from v1 per-resource user-permission tables to SPV2 global principal permissions MUST be lossless and reversible during cutover window.
- Rationale: Existing deployments require safe no-downtime transition.
- Acceptance criteria:
  - Backfill migrates all active grants with canonical principal IDs.
  - Dual-read resolves equivalent access decisions pre/post migration.
  - Rollback path restores v1 reads if v2 cutover halted.
- Test vectors: TV-COMP-001-P, TV-COMP-001-N
- Notes: Migration scripts must be idempotent.

## COMP-002
- ID: COMP-002
- Priority: P0
- Statement: Client/server SDKs MUST remain backward compatible for existing share APIs while exposing SPV2 APIs.
- Rationale: Adoption requires non-breaking upgrades.
- Acceptance criteria:
  - Existing `table.share(id,userId,level)` continues to work.
  - New principal/scope APIs are available and documented.
  - Deprecated shapes emit deterministic warnings (not hard failures) during compatibility period.
- Test vectors: TV-COMP-002-P, TV-COMP-002-N
- Notes: Compatibility period end must be versioned.

## PY-001
- ID: PY-001
- Priority: P1
- Statement: Python implementation MUST match TypeScript authorization and sync visibility semantics for SPV2.
- Rationale: Cross-language parity is required for production equivalence.
- Acceptance criteria:
  - Python deny/allow outcomes match TS for canonical vectors.
  - Python sync clone/pull/push enforce actor-visible filtering.
  - Python share APIs support principal and scope semantics.
- Test vectors: TV-PY-001-P, TV-PY-001-N
- Notes: Any divergence must be explicitly version-gated and documented.

## SEC-001
- ID: SEC-001
- Priority: P0
- Statement: Security-sensitive payload content MUST NOT be logged in plain text, while audit-critical metadata MUST be logged.
- Rationale: PII protection is required for health, finance, and intimate collaboration data.
- Acceptance criteria:
  - Structured logs contain identifiers/operation metadata without sensitive body fields.
  - Security events for unauthorized share access are logged with actor/resource context.
  - Redaction behavior is test-covered.
- Test vectors: TV-SEC-001-P, TV-SEC-001-N
- Notes: Redaction policy applies to both server and Python implementations.

## USE-001
- ID: USE-001
- Priority: P0
- Statement: The architecture MUST support all listed use cases via documented canonical patterns without requiring per-product bespoke ACL engines.
- Rationale: User intent explicitly spans consumer, partner, household, and enterprise collaboration.
- Acceptance criteria:
  - Canonical mapping exists for each listed scenario.
  - Each mapping identifies namespace, visibility, grant type, and sync behavior.
  - At least one positive and one negative scenario per major domain is tested.
- Test vectors: TV-USE-001-P, TV-USE-001-N
- Notes: Covered domains include Collections, Memotron, Selftron, Pointron, Finatron, Feedtron, Compoundum.

## DOC-001
- ID: DOC-001
- Priority: P1
- Statement: DataFn documentation MUST explain SPV2 in beginner-friendly language with concrete examples for each use-case family and offline revoke/grant behavior.
- Rationale: Correct usage depends on clear mental models beyond internal abbreviations.
- Acceptance criteria:
  - Docs define namespace, principal, visibility, scope grant, relation inheritance, pull/push/revoke.
  - Example snippets include both happy-path and forbidden cases.
  - Migration and compatibility docs are included.
- Test vectors: TV-DOC-001-P, TV-DOC-001-N
- Notes: Avoid unexplained abbreviations in user-facing docs.

## TEST-001
- ID: TEST-001
- Priority: P0
- Statement: SPV2 implementation MUST ship with conformance tests that gate release on security, sync, compatibility, performance smoke, and parity vectors.
- Rationale: Large-surface authz changes require executable confidence gates.
- Acceptance criteria:
  - CI/local suite includes all vectors in `TEST_VECTORS.md` or traceable equivalents.
  - Release checklist fails if any P0 vector fails.
  - Conformance report generated with pass/fail matrix.
- Test vectors: TV-TEST-001-P, TV-TEST-001-N
- Notes: Performance vectors are smoke-level in CI and full-load in dedicated bench jobs.

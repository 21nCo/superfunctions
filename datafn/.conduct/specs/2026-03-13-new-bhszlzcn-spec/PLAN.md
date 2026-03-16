# Implementation Plan

## Architecture Sketch
Modules and responsibilities:
1. `datafn/core`
- Extend shareable capability schema and validation for SPV2 fields.
- Define SPV2 public types for principal/scope sharing.

2. `datafn/cli`
- Generate global permission/membership/hierarchy tables and indexes.
- Generate resource `visibility` system column for share-enabled resources.
- Emit migration helpers for v1 -> v2 compatibility.

3. `datafn/server`
- Add principal resolution service with hierarchy cache.
- Implement access resolver for record/scope/inheritance grants.
- Enforce parity across mutation/push/transact.
- Add shared-with-me query mode and actor feed integration.
- Apply actor-filtered clone/pull/reconcile and revoke/backfill semantics.
- Harden relation expansion authz.

4. `datafn/client`
- Extend table API and mutation builders for principal and scope payloads.
- Apply revoke tombstones and grant backfill deterministically.
- Maintain idempotent offline apply semantics.

5. `datafn/python`
- Port SPV2 authz/sync semantics to parity with TypeScript.

6. `datafn/docs`
- Add beginner-friendly SPV2 docs, use-case mappings, and offline flow guides.

## Dependency Graph
1. SPV2 types and schema validation in `core` must exist before CLI/server/client updates.
2. Global table codegen and migration scripts must exist before server runtime cutover.
3. Access resolver must exist before endpoint parity fixes can be completed.
4. Endpoint parity fixes must exist before sync filtering and revoke/backfill.
5. Sync semantics must exist before performance and websocket targeting tuning.
6. Migration tooling must exist before compatibility release.
7. Python parity and docs finalize after TS reference behavior is stable.
8. Conformance suite gates all phases before release.

## Phases Overview
- Phase 00: Finalize SPV2 contract and inventory lock.
Delivered capability: frozen protocol/requirement baseline.
Verification: spec lint + coverage check against INTENT_AUDIT.

- Phase 01: Core capability and schema extensions.
Delivered capability: SPV2 capability config and validation.
Verification: core unit tests for schema parsing and error codes.

- Phase 02: Data model/codegen/migration scaffolding.
Delivered capability: global ACL tables, visibility column, indexes, migration scaffolding.
Verification: generated schema snapshots and migration dry-run.

- Phase 03: Principal resolution and access engine.
Delivered capability: deterministic effective principal and level resolution.
Verification: resolver tests (including cycle/depth limits).

- Phase 04: Query surface (namespace/shared-with-me/getPermissions).
Delivered capability: explicit access modes and permission inspection.
Verification: query integration tests and explainability outputs.

- Phase 05: Mutation APIs (principal+scope+compat).
Delivered capability: share/unshare principal and scope semantics with legacy compatibility.
Verification: mutation vector suite and compatibility tests.

- Phase 06: Endpoint parity fixes (actor propagation, push, transact, relation authz).
Delivered capability: consistent ACL behavior across mutation/push/transact/relation expansion.
Verification: parity test matrix.

- Phase 07: Sync visibility correctness (clone/pull/reconcile + revoke/backfill + actor feed).
Delivered capability: offline-safe selective sharing semantics.
Verification: sync integration vectors and idempotency invariants.

- Phase 08: Relation inheritance lifecycle and consent checks.
Delivered capability: parent-proxy sharing with deterministic revoke behavior.
Verification: relation integration tests.

- Phase 09: Performance hardening.
Delivered capability: index guarantees, bounded pull merge, optional actor-targeted WS invalidation.
Verification: benchmark smoke and query-plan assertions.

- Phase 10: Migration execution and compatibility release controls.
Delivered capability: dual-read/dual-write rollout and rollback safety.
Verification: staged migration rehearsal with rollback test.

- Phase 11: Python parity implementation.
Delivered capability: TypeScript/Python behavior equivalence for SPV2 vectors.
Verification: shared parity matrix runner.

- Phase 12: Docs, examples, and conformance gate.
Delivered capability: beginner-friendly docs + full use-case recipes + release gate.
Verification: docs checks and P0 conformance report.

## Definition of Done
No phase is complete unless:
1. Its listed requirements are implemented.
2. Its listed verification steps pass locally.
3. Regressions are absent in previously completed phase vectors.
4. Artifacts and phase report are updated with objective evidence.

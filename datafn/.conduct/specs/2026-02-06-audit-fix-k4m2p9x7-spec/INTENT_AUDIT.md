## Intent Inventory (exhaustive for this spec’s scope)

This inventory is derived from:

- User request: “create a detailed and thorough specification for fixing all Flux→datafn gaps; Nucleus refactors fully to datafn right away; do not omit any identified gap”
- Clarifications:
  - `sync.remoteAdapter?: DatafnRemoteAdapter` is required (extension support)
  - Avoid Flux-like wrapper stores; preserve datafn signals; use Nucleus utilities / small Svelte helpers instead
  - Provide first-class KV support (special KV table + ergonomic API)
  - Decide whether per-table pull/partial hydration/selective pulls remain relevant (this spec keeps per-table cursors canonical, matching intent docs)
  - Implement offline apply for relation mutations
- Authoritative intent docs (relevant excerpts):
  - fine-grained subscriptions with context + fields
  - per-table cursors + hydration state machine + remote fallback during hydration
  - server-side authz enforcement
  - extension delegation model (background authoritative, thin clients)

### Inventory items

1. `sync.remoteAdapter` injection for remote transport (extension support).
2. Local-only mode (no remote) that still supports local-first query/mutate and durable changelog.
3. Resource-aware ID generation and prefix enforcement.
4. Mutation `context` support and propagation (events + hooks + logging metadata).
5. Event payload completeness (ids, action, fields, mutationId/clientId, deterministic derivation).
6. Context-aware subscriptions with value matching (not just presence-of-keys).
7. Selective and debounced signal invalidation based on query footprint (resource + relations).
8. Nucleus adoption without Flux-style wrapper stores; preserve signals and separate UI-only state.
9. First-class KV support (built-in KV table + ergonomic API) replacing Flux KeyValueStore.
10. Scalable clone: pagination + optional join inclusion.
11. Hydration plan: boot vs background resources and deterministic query routing during hydration.
12. Pull protocol: per-table cursors canonical; legacy global-cursor pull compatibility maintained.
13. Offline apply for relation mutations (`relate/modifyRelation/unrelate`) deterministically.
14. Server push supports relation ops and records join deltas in change tracking for propagation.
15. Clone/pull propagate join rows/deltas into client join stores for offline relation expansion.
16. Reconcile/repair mechanism (counts-based) to detect drift and re-clone mismatches.
17. Local query performance + operator coverage (index-aware and required operators).
18. Date codec parity (serialize outbound Dates; parse inbound date fields).
19. Client sync lifecycle hooks + sync events.
20. Server authz/permissions enforcement (table + field) with deterministic FORBIDDEN behavior.
21. Server namespace isolation correctness (no hard-coded namespace).
22. Extension remote event propagation so `client.subscribe()` works across contexts.
23. Nucleus refactor: remove Flux from runtime, replace GlobalEvent.MUTATION patterns, replace KV usage, configure extension remote adapter.

## Coverage audit (Inventory → Spec)

For each intent item: coverage location in SPEC.md, implementing requirements, and verifying vectors.

1) **remoteAdapter injection**
- **SPEC.md**: Public API → Client configuration; Semantics → 2) Remote adapter injection
- **Requirements**: CFG-001
- **Test vectors**: TV-CFG-001, TV-CFG-001N

2) **local-only mode**
- **SPEC.md**: Semantics → 1) Local-only mode
- **Requirements**: CFG-002
- **Test vectors**: TV-CFG-002, TV-CFG-002N

3) **resource-aware IDs**
- **SPEC.md**: Semantics → 11) ID conventions + date mapping; Public API → `generateId({resource,idPrefix})`
- **Requirements**: API-001
- **Test vectors**: TV-ID-001, TV-ID-001N

4) **mutation context**
- **SPEC.md**: Public API → Mutation context; Semantics → 3) Context propagation
- **Requirements**: API-002
- **Test vectors**: TV-CTX-001, TV-CTX-001N

5) **event payload completeness**
- **SPEC.md**: Public API → Events + filters; Invariants → Determinism
- **Requirements**: EVT-001
- **Test vectors**: TV-EVT-001, TV-EVT-001N

6) **context value filtering**
- **SPEC.md**: Public API → `DatafnEventFilter.context`; Semantics → 3) Context filtering
- **Requirements**: EVT-002, NUC-002
- **Test vectors**: TV-EVT-002, TV-EVT-002N, TV-NUC-002, TV-NUC-002N

7) **selective + debounced signal invalidation**
- **SPEC.md**: Semantics → 4) Reactive invalidation (signals)
- **Requirements**: SIG-001, SIG-002
- **Test vectors**: TV-SIG-001, TV-SIG-001N, TV-SIG-002, TV-SIG-002N

8) **no Flux-like wrapper stores**
- **SPEC.md**: Semantics → 5) Nucleus data ergonomics without losing signals
- **Requirements**: DX-001
- **Test vectors**: TV-NUC-005, TV-NUC-005N

9) **first-class KV**
- **SPEC.md**: Public API → KV API; Semantics → KV section
- **Requirements**: KV-001, KV-002, NUC-003
- **Test vectors**: TV-KV-001, TV-KV-001N, TV-KV-002, TV-KV-002N, TV-NUC-003, TV-NUC-003N

10) **clone scalability**
- **SPEC.md**: Data formats → Sync: clone; Semantics → 6) Clone scalability
- **Requirements**: SYNC-001
- **Test vectors**: TV-SYNC-001, TV-SYNC-001N

11) **hydration plan**
- **SPEC.md**: Public API → `sync.hydration`; Semantics → 6) Hydration plan
- **Requirements**: SYNC-002
- **Test vectors**: TV-SYNC-002, TV-SYNC-002N

12) **pull cursors + legacy compatibility**
- **SPEC.md**: Data formats → Sync: pull; Semantics → 7) Pull cursor model
- **Requirements**: SYNC-003, SYNC-004
- **Test vectors**: TV-SYNC-003, TV-SYNC-003N, TV-SYNC-004, TV-SYNC-004N

13) **offline relation apply**
- **SPEC.md**: Semantics → 10) Offline apply for relation mutations
- **Requirements**: OFFM-001
- **Test vectors**: TV-OFFM-001, TV-OFFM-001N

14) **push relation ops + join change tracking**
- **SPEC.md**: Data formats → Sync: push; Semantics → 10) Offline relation (end-to-end)
- **Requirements**: SYNC-005
- **Test vectors**: TV-REL-001, TV-REL-001N

15) **join hydration via clone/pull/apply**
- **SPEC.md**: Data formats → clone/pull joins; Semantics → 10) Relation end-to-end
- **Requirements**: SYNC-006
- **Test vectors**: TV-REL-002, TV-REL-002N

16) **reconcile/repair**
- **SPEC.md**: Data formats → reconcile; Semantics → 8) Reconcile/repair
- **Requirements**: SYNC-007
- **Test vectors**: TV-RECON-001, TV-RECON-001N

17) **local query perf + operators**
- **SPEC.md**: Semantics → 9) Local query performance
- **Requirements**: OFFQ-001, OFFQ-002
- **Test vectors**: TV-OFFQ-001, TV-OFFQ-001N, TV-OFFQ-002, TV-OFFQ-002N

18) **date codec parity**
- **SPEC.md**: Semantics → 11) ID conventions + date mapping
- **Requirements**: CODEC-001
- **Test vectors**: TV-CODEC-001, TV-CODEC-001N

19) **sync hooks + sync events**
- **SPEC.md**: Semantics → 12) Sync lifecycle hooks and events
- **Requirements**: HOOK-001, EVT-003
- **Test vectors**: TV-HOOK-001, TV-HOOK-001N, TV-EVT-003, TV-EVT-003N

20) **server authz/permissions**
- **SPEC.md**: Security → Authz boundaries; Semantics → 13) Server authz
- **Requirements**: AUTH-001
- **Test vectors**: TV-AUTH-001, TV-AUTH-001N

21) **namespace isolation correctness**
- **SPEC.md**: Semantics → 13) Server authz/permissions + namespace; Security
- **Requirements**: AUTH-002
- **Test vectors**: TV-AUTH-002, TV-AUTH-002N

22) **extension remote event propagation**
- **SPEC.md**: Public API → Events/filters; Semantics → Remote adapter + extension support
- **Requirements**: EXT-001
- **Test vectors**: TV-EXT-001, TV-EXT-001N

23) **Nucleus refactor (no Flux)**
- **SPEC.md**: Goals/Non-goals; Semantics → 5) Nucleus ergonomics; Plan → Phase 13
- **Requirements**: NUC-001, NUC-002, NUC-003, NUC-004
- **Test vectors**: TV-NUC-001, TV-NUC-001N, TV-NUC-002, TV-NUC-002N, TV-NUC-003, TV-NUC-003N, TV-NUC-004, TV-NUC-004N

## Coverage result

**No missing intent items.**


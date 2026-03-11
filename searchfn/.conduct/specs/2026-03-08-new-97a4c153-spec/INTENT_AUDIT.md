# INTENT_AUDIT

## Intent Inventory
1. Rewrite and clean up `searchfn/client` as a thin layer for direct client-app usage.
2. Update internal superfunctions consumers to use rewritten SearchFn APIs.
3. Rewrite and clean up `searchfn/server` as a thin layer over server adapters.
4. `searchfn/server` should expose search endpoints automatically from a constructor that accepts an adapter.
5. Remove old/legacy code beyond client/server rewrite scope.
6. Fully implement server-grade adapters: Meilisearch, Elasticsearch, OpenSearch (single adapter allowed if similar), and Postgres.
7. Keep OpenSearch implementation strategy efficient (single elastic-compatible adapter if feasible).
8. Deliver comprehensive SearchFn docs site using Fumadocs.
9. Reuse visual/theme primitives across docs sites (DataFn, SearchFn, future docs).
10. Include broader production-readiness improvements (not just feature parity).
11. Do not spend effort on backward compatibility.
12. Do not include legacy docs or migration-focused legacy artifacts.
13. Preserve/enable DataFn integration via provider bridge over adapters.
14. Ensure deterministic and testable behavior suitable for multi-agent execution.
15. Provide phased execution plan with concrete, verifiable work packages.
16. Provide canonical error behavior and validation semantics for server/client wrappers.

## Coverage Mapping
### 1) Rewrite and clean up `searchfn/client` as a thin layer
- SPEC coverage: `Overview`, `Public API -> 3) @searchfn/client thin layer`, `Semantics`
- Requirements: ARCH-001, ARCH-002, CLI-001, CLI-002, CLI-003, LEG-001
- Test vectors: TV-CLI-001, TV-CLI-002, TV-CLI-003, TV-NEG-001, TV-LEG-001

### 2) Update internal superfunctions consumers
- SPEC coverage: `Overview`, `Goals / Non-goals`, `Semantics`
- Requirements: MIG-001
- Test vectors: TV-MIG-001, TV-NEG-009

### 3) Rewrite and clean up `searchfn/server`
- SPEC coverage: `Overview`, `Public API -> 2) @searchfn/server thin layer`, `Data formats / protocol`
- Requirements: SRV-001, SRV-002, SRV-003, SRV-004, API-002
- Test vectors: TV-SRV-001, TV-SRV-002, TV-SRV-003, TV-SRV-004, TV-NEG-002

### 4) Constructor accepts adapter and exposes endpoints automatically
- SPEC coverage: `Public API -> 2) @searchfn/server thin layer`, `Data formats / protocol`
- Requirements: SRV-001
- Test vectors: TV-SRV-001

### 5) Remove old/legacy code
- SPEC coverage: `Overview`, `Compatibility / versioning strategy`
- Requirements: ARCH-002, LEG-001
- Test vectors: TV-ARCH-002, TV-LEG-001, TV-NEG-001

### 6) Fully implement Meili/Elastic/OpenSearch/Postgres adapters
- SPEC coverage: `Overview`, `Public API -> 1) @searchfn/adapters contract`, `Semantics`
- Requirements: ADP-PG-001, ADP-ES-001, ADP-MEI-001, ADP-CONF-001
- Test vectors: TV-ADP-PG-001, TV-ADP-ES-001, TV-ADP-MEI-001, TV-ADP-CONF-001

### 7) OpenSearch can share implementation with Elasticsearch
- SPEC coverage: `Assumptions`, `Public API`, `Semantics`
- Requirements: ADP-ES-001
- Test vectors: TV-ADP-ES-001, TV-NEG-006

### 8) Comprehensive SearchFn docs using Fumadocs
- SPEC coverage: `Overview`, `Goals / Non-goals`, `Observability`
- Requirements: DOC-001, DOC-003
- Test vectors: TV-DOC-001, TV-DOC-003, TV-NEG-012

### 9) Reuse theme/colors across docs sites
- SPEC coverage: `Overview`, `Glossary (Docs Theme Package)`
- Requirements: DOC-002
- Test vectors: TV-DOC-002, TV-NEG-013

### 10) Production readiness improvements
- SPEC coverage: `Security`, `Limits/caps`, `Observability`, `Invariants`
- Requirements: PRD-001, PRD-002, PRD-003, QA-001
- Test vectors: TV-PRD-001, TV-PRD-002, TV-PRD-003, TV-QA-001

### 11) No backward compatibility
- SPEC coverage: `Goals / Non-goals`, `Compatibility / versioning strategy`
- Requirements: ARCH-002, LEG-001
- Test vectors: TV-ARCH-002, TV-NEG-001

### 12) No legacy docs/migration docs
- SPEC coverage: `Goals / Non-goals`, `Compatibility / versioning strategy`
- Requirements: ARCH-002, DOC-001
- Test vectors: TV-DOC-001, TV-NEG-012

### 13) DataFn integration via provider bridge
- SPEC coverage: `Public API -> 4) @searchfn/datafn-provider`, `Semantics`
- Requirements: DFP-001
- Test vectors: TV-DFP-001, TV-NEG-003

### 14) Deterministic and testable behavior
- SPEC coverage: `Semantics`, `Invariants`, `Limits/caps`
- Requirements: API-002, ADP-MEM-001, ADP-IDB-001, ADP-CONF-001, CLI-003
- Test vectors: TV-ADP-MEM-001, TV-ADP-IDB-001, TV-ADP-CONF-001, TV-CLI-003

### 15) Phased execution plan with verifiable work packages
- SPEC coverage: `PLAN.md`, all `phases/PHASE_XX.md`
- Requirements: QA-001 (verification discipline), ARCH-001
- Test vectors: TV-QA-001, TV-NEG-016

### 16) Canonical errors and validation semantics
- SPEC coverage: `Data formats / protocol`, `Security`, `Limits/caps`
- Requirements: API-002, SRV-002, CLI-003
- Test vectors: TV-API-002, TV-SRV-002, TV-NEG-002

## Coverage verdict
No missing intent items.

Corrective edits made during audit:
- Added explicit no-backward-compat/no-legacy-doc requirements.
- Added explicit thin constructor endpoint requirement for server.
- Added explicit docs-theme reuse requirement across DataFn and SearchFn.
- Added explicit OpenSearch-via-elastic-compatible requirement.

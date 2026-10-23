# PLAN

## Architecture Sketch

- **`packages/db` adapter layer**:
  - Enforce strict update-not-found contract in drizzle adapter.
  - Keep row-level namespace wrapper behavior unchanged except contract propagation.
- **`datafn/server` merge execution layer**:
  - Centralize merge decision helper used by both mutation and push paths.
  - Ensure applied/change-tracking only after persisted write.
- **`datafn/client` compatibility layer**:
  - No API shape changes; kv API remains compatible.
- **Testing layer**:
  - Add SQL-backed regression tests to prevent memory-only false positives.

## Dependency Graph

1. ADP-001 (adapter contract) must land before server merge logic can rely on not-found signaling.
2. MRG-001/MRG-002 depend on ADP-001 for correct control flow.
3. OBS-001 depends on MRG-001 decision outcomes.
4. KV-001 depends on MRG-001/MRG-002 behavior.
5. TST-001 spans all prior work and is the release gate.

## Phases Overview

| Phase | Goal | Delivered Capability | Verification Method |
|---|---|---|---|
| PHASE_00 | Harden adapter contract | Drizzle update throws not-found on zero rows | DB adapter tests pass |
| PHASE_01 | Implement shared merge decision logic | Push/mutation merge become schema-aware update-then-conditional-create | Server mutation/sync tests pass |
| PHASE_02 | Enforce persistence-backed accounting + KV regression protection | No false applied/change records; KV first-write persists | SQL-backed server regression tests pass |
| PHASE_03 | End-to-end stabilization | Example app timeline regression tests + docs updates | End-to-end script + targeted suites pass |

## Definition of Done

No phase is complete unless all listed verification steps pass and expected outcomes match exactly.

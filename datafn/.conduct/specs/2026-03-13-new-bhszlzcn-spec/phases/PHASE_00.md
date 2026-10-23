# PHASE_00

## Phase goal
Freeze SPV2 architecture contract and lock intent coverage before implementation.

## In scope / Out of scope
In scope:
- Resolve SPV2 API/type naming and final field semantics.
- Lock requirement-to-intent mapping baseline.
- Create implementation ADR note for capability vs plugin boundary.

Out of scope:
- Runtime code changes.
- Database migrations.

## Deliverables
- `datafn/.conduct/intent/2026-03-sharability/spv2-architecture-decision.md`
- `datafn/.conduct/intent/2026-03-sharability/spv2-intent-inventory.md`

## Requirements covered
- ARCH-001
- ARCH-004
- USE-001

## Implementation tasks
1. Create SPV2 architecture decision note selecting capability-first approach.
2. Record explicit query mode model (`namespace` vs `sharedWithMe`) and no `cross-shared` rule.
3. Compile complete intent inventory from all provided source docs and this spec.
4. Cross-check inventory against requirements list and add any missing requirement references before coding starts.

## Verification steps
1. `rg -n "capability-first|sharedWithMe|cross-shared" datafn/.conduct/intent/2026-03-sharability/spv2-architecture-decision.md`
Expected outcome: all three concepts are present.
2. Manual review: inventory count in `spv2-intent-inventory.md` matches `INTENT_AUDIT.md` item count.
Expected outcome: one-to-one mapping prepared.

## Stop condition
Architecture decision and intent inventory are committed and reviewed; no unresolved architecture ambiguity remains.

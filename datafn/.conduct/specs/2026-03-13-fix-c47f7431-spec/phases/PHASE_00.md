# PHASE_00

## Phase goal
Freeze the canonical search option envelopes, routing semantics, and boundary checklist before code edits begin.

## In scope / Out of scope
In scope:
- Lock exact request/response shapes and validation rules for `prefix`, `fuzzy`, `fieldBoosts`, and `source`.
- Lock file-level boundary matrix for all issue-reported drop points.
- Confirm requirement-to-vector mapping completeness.

Out of scope:
- Runtime code changes.
- Test implementation.

## Deliverables
- `datafn/.conduct/specs/2026-03-13-fix-c47f7431-spec/SPEC.md`
- `datafn/.conduct/specs/2026-03-13-fix-c47f7431-spec/REQUIREMENTS.md`
- `datafn/.conduct/specs/2026-03-13-fix-c47f7431-spec/TEST_VECTORS.md`
- `datafn/.conduct/specs/2026-03-13-fix-c47f7431-spec/INTENT_AUDIT.md`

## Requirements covered
- CON-001
- CON-002
- CON-003
- TST-001

## Implementation tasks
1. Compile exhaustive issue intent inventory (RC-1 to RC-8 + user directives).
2. Define canonical contracts and failure codes in SPEC.
3. Bind each MUST requirement to at least one positive and one negative vector.
4. Validate no missing intent before code phases start.

## Verification steps
1. `rg -n "RC-1|RC-8|local-first|fieldBoosts|source" datafn/.conduct/specs/2026-03-13-fix-c47f7431-spec/SPEC.md`
Expected outcome: all critical issue terms and local-first semantics are present.
2. `rg -n "TV-.*-P|TV-.*-N" datafn/.conduct/specs/2026-03-13-fix-c47f7431-spec/REQUIREMENTS.md`
Expected outcome: every requirement references both positive and negative vectors.

## Stop condition
Intent audit confirms full coverage and no unresolved scope ambiguities remain.

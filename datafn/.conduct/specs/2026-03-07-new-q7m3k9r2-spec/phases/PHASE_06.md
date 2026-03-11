# PHASE 06

## Phase goal
Run full verification, confirm compatibility guarantees, and produce final execution readiness report.

## In scope
- Cross-package targeted test runs.
- Deterministic output verification for codegen.
- Final requirement-to-test evidence capture.

## Out of scope
- New features beyond approved requirements.

## Deliverables
- `datafn/.conduct/specs/2026-03-07-new-q7m3k9r2-spec/phase-reports/PHASE_06-<timestamp>-report.md` (created during execution phase)
- Evidence snippets referencing passing commands and key assertions.

## Requirements covered
- RCAP-001
- RCAP-002
- RCAP-003
- RCAP-004
- JCG-001
- JCG-002
- JRT-001
- JRT-002
- JRT-003
- JRT-004
- JSY-001
- JSY-002
- SEC-001
- COMP-001
- OBS-001

## Implementation tasks
1. Run targeted `core`, `cli`, and `server` suites introduced by this spec.
2. Re-run existing relation and capability suites for regression confidence.
3. Run codegen twice for same schema and confirm byte-identical output.
4. Produce requirement coverage matrix with explicit pass evidence.

## Verification steps
1. `cd datafn/core && npx vitest run`
   - Expected: no regression in core schema/capability behavior.
2. `cd datafn/cli && npx vitest run`
   - Expected: codegen/typegen relation capability tests pass.
3. `cd datafn/server && npx vitest run src/execution/mutation/__tests__/relations*.test.ts src/execution/sync/__tests__/*.test.ts`
   - Expected: runtime and sync relation parity tests pass.
4. Determinism check: run codegen twice, compare checksums.
   - Expected: identical output for identical input.

## Stop condition
Phase is complete when all mapped requirements have passing evidence and deterministic output verification is explicitly documented.

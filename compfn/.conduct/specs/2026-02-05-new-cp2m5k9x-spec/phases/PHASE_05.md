# PHASE_05: Readiness

## Phase goal

Implement readiness.forControl(controlId, frameworkId?) and readiness.forFramework(frameworkId). Compute status (compliant | not_compliant | not_applicable) deterministically from evidence and policy. Return CONTROL_NOT_FOUND or FRAMEWORK_NOT_FOUND when id does not exist.

## In scope

- forControl: aggregate evidence for control; apply policy (e.g. at least one pass evidence in last 90 days → compliant) using evidence.timestamp; apply scoping decisions (latest scoping_decision with status not_applicable → not_applicable); return ControlReadiness with lastEvidenceAt, lastEvidenceId, requirementIds when frameworkId provided
- forFramework: load framework and its requirement→control mapping; for each control compute ControlReadiness; compute overall framework status; return FrameworkReadiness
- Policy (e.g. “pass in last 90 days”) MUST be documented; implementation MUST be deterministic for same evidence set

## Out of scope

- Export; dashboard; per-framework scoping rules; per-control policy windows beyond the global readinessWindowDays.

## Deliverables

- `src/readiness/service.ts` – forControl, forFramework
- Policy: document in code or config (e.g. compliant if at least one evidence with outcome "pass" and timestamp within window (config.readinessWindowDays ?? 90); not_compliant otherwise when applicable; not_applicable when latest scoping_decision marks it not applicable)
- Tests: TV-READY-CONTROL-001, TV-READY-CONTROL-002, TV-READY-CONTROL-003, TV-READY-FRAMEWORK-001, TV-READY-FRAMEWORK-002

## Requirements covered

- READY-001

## Implementation tasks

1. Implement readiness.forControl(controlId, frameworkId?): get control; if not found return CONTROL_NOT_FOUND. Query evidence for this controlId. If latest scoping_decision evidence has payload.status === "not_applicable", return status "not_applicable". Otherwise compute status: if at least one evidence with outcome "pass" (excluding scoping_decision) and evidence.timestamp within policy window (config.readinessWindowDays ?? 90) then "compliant", else "not_compliant". lastEvidenceAt = max(evidence.timestamp); lastEvidenceId = that evidence id. If frameworkId provided, get requirement IDs that map to this control from framework. Return { ok: true, result: ControlReadiness }.
2. Implement readiness.forFramework(frameworkId): get framework; if not found return FRAMEWORK_NOT_FOUND. For each unique controlId in framework.requirements, compute ControlReadiness (reuse forControl logic or inline). Aggregate: framework status = not_compliant if any control is not_compliant; else compliant if all controls are compliant or not_applicable. lastUpdated = now. Return { ok: true, result: FrameworkReadiness }.
3. Ensure determinism: same evidence set and policy → same status (no randomness).
4. Write tests TV-READY-*.

## Verification steps

- Run readiness tests; TV-READY-* pass.
- Control with pass evidence → compliant (or per policy).
- forControl("nonexistent") → CONTROL_NOT_FOUND; forFramework("nonexistent") → FRAMEWORK_NOT_FOUND.

## Stop condition

- Readiness forControl and forFramework complete; deterministic; all test vectors pass.

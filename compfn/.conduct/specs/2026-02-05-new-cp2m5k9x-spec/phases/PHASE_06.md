# PHASE_06: Export auditor pack

## Phase goal

Implement export.auditorPack({ frameworkId?, since? }). Return AuditorPack (exportedAt, frameworkId?, controls, frameworks, evidence, mapping). When frameworkId provided, scope controls and evidence to that framework. When since provided, filter evidence by evidence.timestamp >= since. Enforce exportMaxBytes; return EXPORT_FAILED when result size would exceed limit.

## In scope

- auditorPack() – load all controls, frameworks, evidence (with optional filters); build mapping (requirementId → controlIds from framework.requirements); set exportedAt; return object
- Size check: JSON.stringify(result).length or equivalent; if > exportMaxBytes return { ok: false, error: { code: "EXPORT_FAILED" } }

## Out of scope

- PDF/HTML summary; streaming export

## Deliverables

- `src/export/service.ts` – auditorPack(options)
- Tests: TV-EXPORT-001, TV-EXPORT-002, TV-EXPORT-003

## Requirements covered

- EXPORT-001, LIMIT-001 (export cap)

## Implementation tasks

1. Implement export.auditorPack({ frameworkId?, since? }): Load frameworks (all or by frameworkId). Resolve controlIds from framework(s). Load controls for those ids (or all if no frameworkId). Load evidence: if frameworkId filter by controlIds in framework; if since filter evidence by timestamp >= since. Build mapping array from framework.requirements. Build result: { exportedAt: Date.now(), frameworkId, controls, frameworks, evidence, mapping }. Check size (e.g. JSON.stringify(result).length); if > config.exportMaxBytes return { ok: false, error: { code: "EXPORT_FAILED", message, details } }. Return { ok: true, result }.
2. Write tests: full export; scoped to frameworkId; export that would exceed limit (small exportMaxBytes) → EXPORT_FAILED.

## Verification steps

- Run export tests; TV-EXPORT-001, TV-EXPORT-002, TV-EXPORT-003 pass.
- When result size > exportMaxBytes, EXPORT_FAILED returned.

## Stop condition

- Export auditor pack complete; size cap enforced; all test vectors pass.

# Intent Audit (Coverage Mapping)

This document enumerates the intent items extracted from the authoritative audit section (2.1) and maps each item to spec coverage (SPEC.md sections, REQUIREMENTS.md IDs, and TEST_VECTORS.md vectors).

## Intent inventory (numbered)

1. Add a Clone Up / local-to-cloud upload capability to prevent data loss on local→cloud transition.
2. Support the offline-first signup flow (local data exists before cloud identity).
3. Upload ALL local persisted data by default; support an explicit subset of resources when requested.
4. Upload resource-by-resource (select all local records per resource; upload if non-empty).
5. Do not require a changelog→mutations conversion for clone up.
6. Ensure `clientId` is included and resource selection defaults to all when unspecified.
7. Provide a dedicated server endpoint `/datafn/cloneup` (rather than overloading `push`).
8. Ensure clone up is idempotent and safe to retry.

## Coverage mapping

| Intent ID | Source | Intent statement | Covered by |
|---|---|---|---|
| INT-CLONEUP-001 | gap analysis 2.1 | Datafn must support Clone Up / local-to-cloud upload to prevent data loss when switching from local mode to cloud on signup. | SPEC.md (Overview, Goals), CLONEUP-001..005, CLONEUP-011, TV-CLONEUP-001/010 |
| INT-CLONEUP-002 | gap analysis 2.1 | Support offline-first signup flow: user creates data locally, then after signup uploads it to cloud. | SPEC.md (Overview, Context), CLONEUP-011, PHASE_03, TV-CLONEUP-010 |
| INT-CLONEUP-003 | gap analysis 2.1 | Upload ALL local persisted data by default; allow uploading a subset of resources when specified. | SPEC.md (Client → Resource selection), CLONEUP-011, CLONEUP-012, TV-CLONEUP-010/013 |
| INT-CLONEUP-004 | gap analysis 2.1 | Upload should be resource-by-resource: for each resource, select all local records and upload if any. | SPEC.md (Client semantics), CLONEUP-011/013, TV-CLONEUP-010 |
| INT-CLONEUP-005 | gap analysis 2.1 | Clone up must not require changelog → mutations conversion (push-only is insufficient). | SPEC.md (Non-goals + Client semantics), CLONEUP-011 |
| INT-CLONEUP-006 | gap analysis 2.1 | ClientId must be included; resources should be optional and default to all. | SPEC.md (CloneUpRequest + Client resource selection), CLONEUP-002/011/012, TV-CLONEUP-005/013 |
| INT-CLONEUP-007 | gap analysis 2.1 | Provide server endpoint `/datafn/cloneup` (or extend push); endpoint should exist and be callable by the client remote. | SPEC.md (Server HTTP API), CLONEUP-001/009/010, TV-CLONEUP-001/009 |
| INT-CLONEUP-008 | gap analysis 2.1 | Clone up must be idempotent and safe to retry in signup scenarios. | SPEC.md (Invariants → Idempotency), CLONEUP-004/005, TV-CLONEUP-003 |

## Non-goals audit

| Non-goal | Where stated | Rationale |
|---|---|---|
| No change to `push()` semantics | SPEC.md → Non-goals | Keeps the incremental sync pipeline stable; clone up is additive. |
| No reconciliation/transactions across multiple resources | SPEC.md → Non-goals | Keeps implementation scoped to the audit gap; avoids cross-resource atomicity requirements. |

## Coverage status

No missing intent items.

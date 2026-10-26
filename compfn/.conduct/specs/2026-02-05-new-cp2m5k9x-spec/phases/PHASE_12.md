# PHASE_12: Provider usage and INTENT_AUDIT

## Phase goal

Document how productFn, userfn, or flowfn consume compfn (readiness, evidence-due). Verify API surface is sufficient: readiness.forFramework(frameworkId), evidence.list({ controlId, since }). Optionally add helper or document “evidence due” derivation. Finalize INTENT_AUDIT.md: intent inventory → spec/requirements/vectors; state “No missing intent items” or list corrections made.

## In scope

- Documentation: “Consuming compfn from productFn/flowfn” – get framework readiness; list evidence by control and since; compute “evidence due” (controls with no evidence or last evidence older than threshold)
- TV-PROVIDER-001: readiness.forFramework and evidence.list are sufficient; document usage
- INTENT_AUDIT.md: full intent inventory from compfn.intent.md and COMPFN_APPROACH.md; map each intent to SPEC section, requirement IDs, test vectors; confirm no missing items or add missing requirements/vectors and update SPEC/REQUIREMENTS/TEST_VECTORS

## Out of scope

- Implementing productFn or flowfn; optional dedicated “evidenceDue” API (document existing list/readiness as sufficient)

## Deliverables

- README or docs: “Provider API” / “Consuming compfn” – example: get readiness for framework; list evidence for controls with since = 90 days ago; controls with no evidence or lastEvidenceAt < threshold = “evidence due”
- INTENT_AUDIT.md in spec folder: intent inventory table; coverage table (intent → SPEC, requirements, vectors); “No missing intent items” or list of corrective edits
- If any intent was missing: update SPEC.md, REQUIREMENTS.md, TEST_VECTORS.md and re-run audit until complete

## Requirements covered

- PROVIDER-001, full scope verification via INTENT_AUDIT

## Implementation tasks

1. Write “Consuming compfn” doc: call readiness.forFramework(frameworkId) for status; call evidence.list({ controlId, since: Date.now() - 90*24*60*60*1000 }) to get recent evidence per control; to get “evidence due”, list controls in framework and filter those where lastEvidenceAt is missing or < threshold. Example code snippet.
2. Verify TV-PROVIDER-001: readiness.forFramework and evidence.list with filters are sufficient; add test or manual verification and document.
3. Build intent inventory: re-read compfn.intent.md and COMPFN_APPROACH.md; list every feature, constraint, invariant, API expectation, must-not (numbered I01, I02, …).
4. For each intent item, fill INTENT_AUDIT.md: SPEC.md section(s), REQUIREMENTS.md IDs, TEST_VECTORS.md IDs. If any intent has no requirement or no test vector, add requirement and/or vector and update REQUIREMENTS.md and TEST_VECTORS.md; then update SPEC if needed.
5. Final sentence in INTENT_AUDIT: “No missing intent items.” (or “Missing items (resolved): …” with list of added requirement/vector IDs).

## Verification steps

- INTENT_AUDIT.md complete; every intent has at least one requirement and (where applicable) one test vector.
- Provider doc allows a consumer to implement “evidence due” and “compliance status” using existing API.

## Stop condition

- INTENT_AUDIT complete; no missing intent items; provider usage documented.

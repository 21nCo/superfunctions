# Panel report schema version 1

A panel report records one ReviewFn panel run: several slots review the same frozen change, and their findings are combined by union. The panel contract lives in `@superfunctions/reviewfn-core` under `panel/`. Each document below has a JSON Schema (`panelPolicySchema`, `slotIdentitySchema`, `slotRunSchema`, `panelFindingSchema`, `panelReportSchema`, `lensOutputSchema`), TypeScript types, and a deterministic validator. The 0.1 `ReviewReport` v1 ([report schema](report-schema.md)) is unchanged. It is embedded as the panel's requirements report, and a 0.1 single-harness report validates exactly as before.

## Severity

Panel findings use the 0.1 `FindingSeverity`. Lens priorities map as P0 = `critical`, P1 = `high`, P2 = `medium`, P3 = `low`. A panel lens never emits `info`: the lens output schema excludes it, and the validator rejects it in panel findings with `REVIEWFN_PANEL_FINDING_INVALID`.

## Panel policy

`{ version: 1, slots, quorum: { stage1, stage2 }, requirementsSlot, maxConcurrentSlots?, incremental: "full" | "delta" }`. `requirementsSlot` names a stage-1 or stage-2 slot, or is `null` to skip requirement extraction. `maxConcurrentSlots` is 1–8, and 2 when absent. `panelPolicyDigest(policy)` is the canonical SHA-256 of the validated policy with that default applied; the report records it as `panelPolicyDigest`. Loading the policy and repository tightening belong to the panel orchestrator.

A slot is `{ id, stage: 1 | 2 | "verifier", harness: { adapter, version }, inference: { provider, model, auth, credentialEnv? }, lens, budget: { timeoutMs, maxOutputBytes } }`. Slot IDs match `^[a-z0-9][a-z0-9-]{0,62}$` and are unique. As in 0.1, the model `configured` defers to the harness default.

## Slot identity and runs

A slot's identity is the tuple (harness adapter, harness-reported version, provider, resolved model, auth mode, credential fingerprint). The fingerprint is the first 16 hex characters of the SHA-256 of the credential value, or of the harness-reported account identity (`credentialFingerprint(value)`). The value itself is never recorded. The fingerprint is absent when neither was observed. `slotIdentityKey(identity)` compares identities.

Within one stage, slots with the same identity count once toward quorum. The first such slot in policy order is counted, and every later one is recorded with terminal `collapsed`. A stage-2 slot may share a stage-1 identity: stages have separate quorums.

A slot run is `{ slotId, identity, terminal, voidReasons, startedAt, finishedAt, outputArtifact?, outputDigest?, usage? }`. `terminal` is `completed`, `failed`, `canceled`, `quota_exhausted`, `timed_out`, `malformed`, `void` or `collapsed`. A `void` run lists at least one reason, and no other terminal lists any:

- `model_mismatch`: the resolved model differs from a configured model other than `configured`. Such a run must be void.
- `workspace_mutated`: the slot changed its checkout.
- `disallowed_tool_use`: the harness reported a forbidden tool.

Usage values (`inputTokens`, `outputTokens`, `costUsd`) appear only when the harness observed them. Timestamps are RFC 3339 UTC.

## Lens output

Lens slots return `{ findings, evidence, inspectedPaths, uninspected }`, which is the 0.1 harness output without requirements or assessments. The requirements slot keeps the full 0.1 harness schema. `HarnessInput.outputSchema` selects the structured-output schema for a run. The Codex adapter passes it to `--output-schema` (in provider-strict form) and validates the result against it. The result is then normalized with empty requirements and assessments, and must still be a valid 0.1 harness payload. A schema that does not compile fails the run before inference. Without `outputSchema`, Codex behaves as in 0.1.

## Panel findings

A panel finding is a 0.1 `Finding` plus the following fields:

- `origins: [{ slotId, lens }]`: at least one, and each a completed stage-1 or stage-2 slot with that lens.
- `confidence`: 0–1. It is informational and never used for gating.
- `ruleIds`.
- `verification?: { verdict: "confirmed" | "refuted" | "inconclusive", slotId, evidenceIds, onBase: "present" | "absent" | "not_checked", reason }`.
- `disposition: "reported" | "dropped" | "suppressed"`, with `dispositionReason` and, for suppression, `suppressionReference`.

Verification comes from a completed `verifier` slot whose identity differs from every origin slot's identity. A confirmed or refuted verdict cites evidence. A dropped finding requires a refuted verification. A suppressed finding requires a `suppressionReference` (a source reference). Both require a `dispositionReason`. Dropped and suppressed findings stay in the report, so nothing disappears silently. Panel findings are lifecycle `new` until prior-finding provenance exists. Fingerprints are unique; agreement between slots is recorded in `origins`.

## Panel report

The report is `{ schemaVersion: 1, kind: "reviewfn-panel", runId, createdAt, change, changeDetail?, panelPolicyDigest, slots, slotRuns, requirementsReport?, gateReceipts, evidence, findings, clusters, coverage, coverageReasons, verdict? }`.

- `gateReceipts` are 0.1 test receipts from the trusted gates.
- `evidence` holds the 0.1 evidence items that panel findings and verifications cite. Code anchors cite the reviewed head, or the merge base for on-base code, and are verified when source control is supplied. Test evidence names exactly one gate receipt. A reproduced finding cites a completed gate receipt at the reviewed head.
- `clusters` are `{ id, findingFingerprints }`. A finding belongs to at most one cluster.
- `requirementsReport` must review the same change and change detail as the panel. Without it, the panel's own `changeDetail` is verified against its artifacts as in 0.1.
- Incomplete coverage states at least one reason.

`verdict` uses 0.1's derivation (`derivePanelVerdict`). It runs over the requirements report plus the reported panel findings; dropped and suppressed findings are excluded. Coverage is complete only if both the panel and the requirements report are complete. Without a requirements report no requirement was assessed, so the verdict is at most `needs_verification`. A requirements report whose run did not complete leaves the verdict absent, as in 0.1. Panel output stays advisory.

## Validation codes

`validatePanelReport(report, policy, { sourceControl?, root?, context?, artifacts? })` returns `{ valid, issues: [{ code, path, message }], verdict }`. `path` is a JSON Pointer. Structural problems are reported alone. The codes form a closed set:

| Code | Meaning |
| --- | --- |
| `REVIEWFN_PANEL_SCHEMA` | The document does not match its JSON Schema, or a run contradicts its slot (identity, model mismatch, finish before start). |
| `REVIEWFN_PANEL_SLOT_DUPLICATE` | A slot ID is declared twice, a slot has two runs, or a duplicate identity is not collapsed (or a collapsed run has no earlier duplicate). |
| `REVIEWFN_PANEL_SLOT_UNKNOWN` | A run, verification or `requirementsSlot` names no such slot. |
| `REVIEWFN_PANEL_FINDING_INVALID` | `info` severity, a lifecycle other than `new`, a duplicate fingerprint or origin, missing or unknown evidence or requirements, a reproduced finding without a gate receipt, an invalid anchor, or an invalid cluster. |
| `REVIEWFN_PANEL_ORIGIN_UNKNOWN` | An origin is not a completed stage-1 or stage-2 slot with that lens. |
| `REVIEWFN_PANEL_VERIFICATION_INVALID` | The verifier is not a completed verifier slot, shares an origin slot's identity, or cites missing or unknown evidence. |
| `REVIEWFN_PANEL_DISPOSITION_INVALID` | Dropped without a refuted verification, suppressed without a suppression reference, or not reported without a reason. |
| `REVIEWFN_PANEL_VERDICT_MISMATCH` | `verdict` differs from the derived verdict. |

Errors from validating the embedded requirements report keep their 0.1 meaning: `REVIEWFN_CHANGE_DETAIL_MISMATCH` and `REVIEWFN_SINCE_NOT_ANCESTOR` keep their codes, and every other 0.1 error is `REVIEWFN_REPORT_INVALID`. `panelStructureIssues(kind, value)` is the structural TypeScript mirror of each JSON Schema. The tests check that it agrees with Ajv on every fixture and on systematic structural variants of each fixture.

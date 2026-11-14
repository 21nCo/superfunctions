---
title: Panel report schema
description: Panel policy, slot identity, slot runs, panel findings, and the panel report.
---

A panel report records one ReviewFn panel run: several slots review the same frozen change, and their findings are combined by union. The panel contract lives in `@superfunctions/reviewfn-core` under `panel/`. Each document below has a JSON Schema (`panelPolicySchema`, `slotIdentitySchema`, `slotRunSchema`, `panelFindingSchema`, `panelReportSchema`, `lensOutputSchema`), TypeScript types, and a deterministic validator. The 0.1 `ReviewReport` v1 ([report schema](report-schema.md)) is unchanged. It is embedded as the panel's requirements report, and a 0.1 single-harness report validates exactly as before.

## Severity

Panel findings use the 0.1 `FindingSeverity`. Lens priorities map as P0 = `critical`, P1 = `high`, P2 = `medium`, P3 = `low`. A panel lens never emits `info`: the lens output schema excludes it, and the validator rejects it in panel findings with `REVIEWFN_PANEL_FINDING_INVALID`.

## Panel policy

`{ version: 1, slots, quorum: { stage1, stage2 }, requirementsSlot, maxConcurrentSlots?, incremental: "full" | "delta" }`. `requirementsSlot` names a stage-1 or stage-2 slot, or is `null` to skip requirement extraction. `maxConcurrentSlots` is 1–8, and 2 when absent. `panelPolicyDigest(policy)` is the canonical SHA-256 of the validated policy with that default applied; the report records it as `panelPolicyDigest`. Loading the policy and repository tightening belong to the panel orchestrator.

A slot is `{ id, stage: 1 | 2 | "verifier", harness: { adapter, version }, inference: { provider, model, auth, credentialEnv? }, lens, budget: { timeoutMs, maxOutputBytes } }`. Slot IDs match `^[a-z0-9][a-z0-9-]{0,62}$` and are unique. As in 0.1, the model `configured` defers to the harness default.

## Slot identity and runs

A slot's identity is the tuple (harness adapter, harness-reported version, provider, resolved model, auth mode, credential fingerprint). The fingerprint is the first 16 hex characters of the SHA-256 of the credential value, or of the harness-reported account identity (`credentialFingerprint(value)`). The value itself is never recorded. The fingerprint is absent when neither was observed. `slotIdentityKey(identity)` compares identities. A run's harness adapter, provider and auth mode must equal its slot's. `harness.version` is the exact version the harness must report. A run that reports another version records that version truthfully, but it can never be `completed` or `collapsed`: the orchestrator records it as `failed` (or another terminal that does not count), so a version drift cannot form a separate identity that escapes collapse.

Within one stage, slots with the same identity count once toward quorum. The run that counts is the first `completed` run of that identity in policy order. A later run of the same identity that would also complete is recorded as `collapsed`, so a `collapsed` run always follows a counted run of its identity in its stage. Runs that end any other way (`failed`, `canceled`, `quota_exhausted`, `timed_out`, `malformed` or `void`) neither count nor collapse: if the first slot of an identity fails, a later slot of that identity can still complete and count. A stage-2 slot may share a stage-1 identity, because stages have separate quorums. Collapse affects quorum only: a `collapsed` run succeeded with its own lens, its findings name it as their origin, and a collapsed verifier's verifications stand. Verifier slots collapse by identity in the same way, although they have no quorum.

A slot run is `{ slotId, identity, terminal, voidReasons, startedAt, finishedAt, outputArtifact?, outputDigest?, usage? }`. `terminal` is `completed`, `failed`, `canceled`, `quota_exhausted`, `timed_out`, `malformed`, `void` or `collapsed`. A `void` run lists at least one reason, and no other terminal lists any:

- `model_mismatch`: the resolved model differs from a configured model other than `configured`. This takes precedence over every other outcome: whenever the harness reports a resolved model that differs, the run is `void` and its reasons include `model_mismatch`, even if it also failed or timed out. When the harness reports no resolved model, `identity.model` records the configured model.
- `workspace_mutated`: the slot changed its checkout.
- `disallowed_tool_use`: the harness reported a forbidden tool.

Usage values (`inputTokens`, `outputTokens`, `costUsd`) appear only when the harness observed them. Timestamps are RFC 3339 UTC with in-range fields. The validator also rejects dates that do not exist, such as February 30, and a run that finishes before it starts.

## Lens output

Lens slots return `{ findings, evidence, inspectedPaths, uninspected }`, which is the 0.1 harness output without requirements or assessments. The requirements slot keeps the full 0.1 harness schema. `HarnessInput.outputSchema` selects the structured-output schema for a run. The Codex adapter passes it to `--output-schema` (in provider-strict form), omits the nulls that form adds for optional properties (`omitOptionalNullsFor`: only nulls the compiled caller schema rejects are omitted, in linear rounds, so a required nullable property is kept; a null that the applicable `anyOf`/`oneOf` branch requires but a branch or conditional that does not apply rejects is omitted too, and such output is reported malformed), and validates the result against it. The result is then normalized with empty requirements and assessments and without nulls, and must still be a valid 0.1 harness payload. A schema that does not compile fails the run before inference. Without `outputSchema`, Codex behaves as in 0.1.

## Panel findings

A panel finding is a 0.1 `Finding` plus the following fields:

- `origins: [{ slotId, lens }]`: at least one, and each a stage-1 or stage-2 slot with that lens whose run is `completed` or `collapsed`.
- `confidence`: 0–1. It is informational and never used for gating.
- `ruleIds`.
- `verification?: { verdict: "confirmed" | "refuted" | "inconclusive", slotId, evidenceIds, onBase: "present" | "absent" | "not_checked", reason }`.
- `disposition: "reported" | "dropped" | "suppressed"`, with `dispositionReason` and, for suppression, `suppressionReference`.

Verification comes from a `verifier` slot with a `completed` or `collapsed` run whose identity differs from every origin slot's identity. A confirmed or refuted verdict cites evidence. A dropped finding requires a refuted verification. A suppressed finding requires a `suppressionReference`, which is checked like a 0.1 waiver: it must be a verifiable reference (a literal excerpt or a valid line range) to an available, accepted source in the frozen context, and that source must be one of the policy's `sourceAuthority.waiverAuthorities`. Dropped and suppressed findings both require a `dispositionReason`. Dropped and suppressed findings stay in the report, so nothing disappears silently. Panel findings are lifecycle `new` until prior-finding provenance exists. Fingerprints are unique; agreement between slots is recorded in `origins`. The report records at most `policy.limits.maxFindings` panel findings, counting reported, dropped and suppressed findings alike; the panel orchestrator may add a separate bound for the slot union.

## Panel report

The report is `{ schemaVersion: 1, kind: "reviewfn-panel", runId, createdAt, change, changeDetail?, contextManifestDigest?, panelPolicyDigest, slots, slotRuns, requirementsReport?, gateReceipts, evidence, findings, clusters, coverage, coverageReasons, verdict? }`.

- `contextManifestDigest` is the digest of the frozen context the run used. When a requirements report is present it must be equal to that report's digest, and it may be omitted. Source references are verified only against a supplied context with this digest (or the requirements report's). Without such a context they fail closed.
- `gateReceipts` are 0.1 test receipts from the trusted gates.
- `evidence` holds the 0.1 evidence items that panel findings and verifications cite. Each item is verified as in 0.1, and every check fails closed when the source control, context or artifact store it needs is not supplied:
  - Code anchors on findings and evidence follow the 0.1 commit rule (`anchorCommitChecker`). An anchor cites the reviewed head. It may cite the merge base only for a changed path that source control reports absent at head, and `changeDetail.since` only for a path the verified delta removed that is absent at head. One narrow allowance exists for on-base evidence: evidence cited by at least one verification whose `onBase` is `present` or `absent`, and by no finding and no verification whose `onBase` is `not_checked`, may anchor at the merge base on any path. Every anchor must then be confirmed by `sourceControl.verifyAnchor`. Without source control or with an empty `root`, source control is never called: only head anchors and on-base evidence pass the commit rule, and they still fail as unverifiable.
  - Diff evidence lies in the changed paths or the verified delta paths.
  - Source evidence cites a verifiable source in the frozen context.
  - Test evidence names exactly one gate receipt at the reviewed head.
  - Artifact evidence names the digest of a slot run's retained `outputArtifact`.
  - A reproduced finding needs a completed gate receipt at the reviewed head whose stdout and stderr artifacts match their digests in the artifact store.
- `clusters` are `{ id, findingFingerprints }`. A finding belongs to at most one cluster.
- `requirementsReport` must review the same change and change detail as the panel, and is validated with the 0.1 validator. Without it, the panel's own `changeDetail` is verified against its artifacts, and `changeDetail.since` is checked against head and merge base ancestry when source control can answer it, as in 0.1.
- Incomplete coverage states at least one reason.

`verdict` uses 0.1's derivation (`derivePanelVerdict`). It runs over the requirements report plus the reported panel findings; dropped and suppressed findings are excluded. Coverage is complete only if both the panel and the requirements report are complete. Without a requirements report no requirement was assessed, so the verdict is at most `needs_verification`. A requirements report whose run did not complete leaves the verdict absent, as in 0.1. Panel output stays advisory.

## Validation codes

`validatePanelReport(report, policy, { sourceControl?, root?, context?, artifacts? })` returns `{ valid, issues: [{ code, path, message }], verdict }`. `policy` is the 0.1 `ReviewPolicy` (blocking severities, source authority and limits), not the panel policy. `path` is an RFC 6901 JSON Pointer, and the empty string `""` is the document root. Structural problems are reported alone. `validatePanelPolicy(policy)` checks a panel policy, including that `requirementsSlot` names a stage-1 or stage-2 slot. The codes form a closed set:

| Code | Meaning |
| --- | --- |
| `REVIEWFN_PANEL_SCHEMA` | The document does not match its JSON Schema, a timestamp is not a real time, or a run contradicts its slot (harness adapter, provider or auth mode, a `completed` or `collapsed` run reporting another harness version, model mismatch not voided with `model_mismatch`, `model_mismatch` without a mismatch, finish before start). |
| `REVIEWFN_PANEL_SLOT_DUPLICATE` | A slot ID is declared twice, a slot has two runs, a second completed run of an identity in a stage is not collapsed, or a collapsed run has no earlier completed run of its identity in its stage. |
| `REVIEWFN_PANEL_SLOT_UNKNOWN` | A run or verification names no such slot (`validatePanelPolicy` also reports an unknown `requirementsSlot`). |
| `REVIEWFN_PANEL_FINDING_INVALID` | `info` severity, more findings than `maxFindings`, a lifecycle other than `new`, a duplicate fingerprint or origin, missing, unknown or unverifiable evidence, unknown requirements, an unverified reproduction, an anchor whose commit the anchor rule above does not allow or that source control cannot confirm, or an invalid cluster. |
| `REVIEWFN_PANEL_ORIGIN_UNKNOWN` | An origin is not a stage-1 or stage-2 slot with that lens whose run is `completed` or `collapsed`. |
| `REVIEWFN_PANEL_VERIFICATION_INVALID` | The verifier is not a verifier slot with a `completed` or `collapsed` run, shares an origin slot's identity, or cites missing or unknown evidence. |
| `REVIEWFN_PANEL_DISPOSITION_INVALID` | Dropped without a refuted verification, suppressed without a verifiable waiver-authority reference, a `suppressionReference` on a finding that is not suppressed, or dropped or suppressed without a reason. |
| `REVIEWFN_PANEL_VERDICT_MISMATCH` | `verdict` differs from the derived verdict. |

Errors from the 0.1 checks keep their 0.1 meaning: `REVIEWFN_CHANGE_DETAIL_MISMATCH` and `REVIEWFN_SINCE_NOT_ANCESTOR` keep their codes, and every other 0.1 error, including a requirements report for a different change, change detail or context, is `REVIEWFN_REPORT_INVALID`. Calendar validity of timestamps is a validator check beyond the JSON Schema pattern. `panelStructureIssues(kind, value)` is the structural TypeScript mirror of each JSON Schema. The tests check that it agrees with Ajv on every fixture and on systematic structural variants of each fixture.

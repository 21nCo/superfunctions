# PHASE_00 — Baseline, governance, and evidence contracts

## Objective

Freeze the program’s decisions and create the governance/evidence foundation that makes later readiness claims auditable.

## Entry

- Source audit `ee1f9d6c` and this full spec bundle are present.
- Existing dirty worktree is inventoried; no unrelated change is discarded.

## Requirements

- Owns `OPS-001`.
- Scaffolds, but does not complete, `TEST-001` and `REL-001`.

## Work

1. Add machine-readable stable/private/experimental product decisions, supported matrix, evidence schema, defect severities/SLAs, expiry policy, and ownership schema under `uifn/.conduct/contracts/` or an equivalently documented non-package workspace.
2. Assign owners for every current stable package, future DOM service, catalog family, release verifier, accessibility ledger/matrix, and security/performance gate; update `CODEOWNERS` without claiming ownership that has not been accepted.
3. Capture a baseline manifest of current packages/exports/tests/tarball sizes, known audit findings, open issues, and current verification outcomes, including current dirty-state and hashes.
4. Implement schema validation and fixtures for complete, missing, stale, blocked, malformed, unsigned, and dirty evidence.
5. Define append-only evidence/report naming, retention, redaction, and immutable-artifact rules.

## Required evidence

- `TV-OPS-001-P` and `TV-OPS-001-N` pass.
- Evidence-schema negative fixtures fail for the intended error codes.
- Baseline explicitly says overall readiness is `FAIL`; it MUST NOT convert current synthetic checks into 10/10 claims.

## Exit gate

100% ownership coverage, enforceable defect/evidence contracts, and a signed program decision record exist. Open real product findings remain open for their owning phases.

## Do not

- Do not implement the new runtime or primitives.
- Do not mark `TEST-001` or `REL-001` complete.
- Do not fabricate human or independent-review evidence.

## Handoff

Phase report identifies exact schemas/commands and the package-graph inputs Phase 01 must consume.

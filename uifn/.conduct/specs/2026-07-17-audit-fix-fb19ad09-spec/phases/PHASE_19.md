# PHASE_19 — Manual assistive technology and independent review

## Objective

Produce authentic signed VoiceOver/NVDA/TalkBack evidence and obtain an independent unqualified accessibility assessment before 1.0.

## Entry

- Phase 18 automation/ledgers pass on one frozen release-candidate tarball/source-output hash set.
- Phase 14 compatibility certification passes for that exact release-candidate artifact set; missing, stale, unsigned, or differently hashed cells block entry.
- Qualified human testers and an independent reviewer are identified; independence/qualification is documented.

## Requirements

- `A11Y-003`, `A11Y-004`.

## Work

1. Execute reviewed scripts on VoiceOver macOS and iOS, NVDA Windows, and TalkBack current Android for every representative behavior family/high-risk primitive/state, forms/errors/dynamic updates/destructive/modal paths, package/source modes, and required browsers/devices.
2. Record exact tester/date/commit/tarballs/source hashes/OS/device/browser/AT versions, steps, expected and observed announcements/navigation, result, defects, retest, and signature.
3. Triage every finding under the defect policy; fix through the owning prior phase, rerun affected automation/parity/compatibility, rebuild RC hashes if code changes, and retest affected manual rows.
4. Independent reviewer audits ledgers, representative implementation, automation/mutations, manual scripts/evidence, matrix completeness, defect disposition, support claims, and JAWS deferment; remediate and retest findings.
5. Publish the independent scope/method/independence statement/findings/retests/signature and 10/10 assessment only when unqualified.

## Required evidence

- `TV-A11Y-003-P/N`, `TV-A11Y-004-P/N`.
- Signed complete rows; automation-created or unsigned “manual” files are rejected.
- No open P0/P1 accessibility defect or unaccepted P2 affecting a required row; JAWS is explicitly disclosed as untested/deferred.

## Exit gate

All required human matrix rows pass on current artifacts and an independent qualified reviewer signs an unqualified 10/10 accessibility assessment.

## Do not

- Do not impersonate a human tester/reviewer or infer results.
- Do not waive required rows because hardware or staffing is unavailable; report blocked and keep phase open.
- Do not broaden the sole explicit JAWS deferment.

## Handoff

Phase report links immutable signed evidence, independent review, exact final RC candidate hashes, retests, and remaining non-accessibility release work.

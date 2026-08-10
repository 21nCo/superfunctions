# PHASE_18 — Normative and automated accessibility proof

## Objective

Complete reviewed normative accessibility ledgers and high-fidelity automated browser evidence for every required primitive behavior.

## Entry

- Phase 17 public stories/docs/scenarios, the Phase 14 semantic-parity gate, and the fail-closed compatibility harness are complete. Signed compatibility certification may remain open; automated evidence is provisional until rerun or proven identical on the certified artifact set.
- Accessibility owners are assigned and ledger/version/evidence schemas from Phase 00/02 validate.

## Requirements

- `A11Y-001`, `A11Y-002`.
- Exercises most of `TEST-001` but does not close it.

## Work

1. Complete per-primitive/per-mode WCAG 2.2 AA, APG/native, name/description, role/state, keyboard/focus, pointer/touch, form, announcement, forced-colors, reduced-motion, RTL, and zoom/reflow ledgers with reviewed applicability/deviations.
2. Replace generic smoke/event-count checks with canonical primitive-specific observed-result assertions; remove irrelevant zero-duration auto-passes and sidecar probes.
3. Run axe and explicit assertions against actual package/source public trees across applicable supported desktop/mobile browsers, 200% and 400% zoom/reflow, direction/themes/preferences, dynamic/error/disabled/nested states.
4. Add sanitized failure artifacts containing semantic/event/focus traces, DOM/ARIA, screenshot, exact versions/hash, and stable code; enforce evidence completeness/expiry.
5. Add semantic mutations for ARIA, event order, focus, announcements, cleanup, package/source drift, and framework divergence; record killed/surviving mutations.

## Required evidence

- `TV-A11Y-001-P/N`, `TV-A11Y-002-P/N`, plus current relevant primitive/parity/browser vectors.
- Zero serious/critical axe violations and zero unresolved explicit required assertions.
- Complete reviewed ledger-to-vector-to-evidence mapping; unjustified non-applicability fails.

## Exit gate

Automated accessibility confidence is maximized and mutation-proven, but overall accessibility remains below 10/10 until Phase 19 human and independent evidence passes.

## Do not

- Do not infer screen-reader speech from ARIA/axe alone.
- Do not generate or sign manual evidence.
- Do not weaken assertions to make a matrix green.

## Handoff

Phase report lists exact RC hashes, automated residual risks, manual scripts/expected outcomes, representative matrix selection rationale, and every issue Phase 19 must retest.

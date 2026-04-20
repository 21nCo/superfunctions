# Phase goal

Implement semantic navigation and vision-assisted candidate ranking with mandatory DOM confirmation.

# In scope / Out of scope

- In scope: semantic query resolution, candidate ranking, DOM confirmation guardrails, ambiguity handling.
- Out of scope: design analyzers, baseline persistence, auth profiles.

# Deliverables

- `packages/browser-runner/src/semantic-find.ts`
- `packages/browser-runner/src/vision-ranker.ts`
- `packages/browser-runner/src/confirmation.ts`
- `packages/browser-runner/test/semantic-find.test.ts`
- `packages/browser-runner/test/vision-ranker.test.ts`
- `test/fixtures/vite-ambiguous/`
- `test/fixtures/vite-overlay/`

# Requirements covered

- `NAV-002`
- `NAV-003`

# Implementation tasks

1. Implement semantic query resolution over role, accessible name, label, text, and locator hints.
2. Implement ambiguity detection and the `E_ACTION_AMBIGUOUS` failure path.
3. Implement optional vision ranking using screenshot coordinates and element bounds.
4. Enforce DOM or accessibility confirmation before action dispatch in all vision-assisted cases.
5. Add fixtures for ambiguous buttons and covered overlays.

# Verification steps

1. Run `pnpm --filter @probefn/browser-runner test`.
   Expected outcome: semantic and vision-assist tests pass.
2. Run `pnpm probefn page find --session sess_ambiguous --query "Primary CTA" --json`.
   Expected outcome: canonical ambiguity error is returned.
3. Run `pnpm probefn page act --session sess_overlay --action click --query "Checkout button" --json`.
   Expected outcome: a structured non-interactable error is returned with `usedVisionAssist=true`.

# Stop condition

Report one semantic resolution result, one ambiguity error, and one DOM-confirmation rejection before starting Phase 06.

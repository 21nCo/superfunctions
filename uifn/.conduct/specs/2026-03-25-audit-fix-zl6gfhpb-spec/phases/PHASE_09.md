# Phase goal

Close the automated QA matrix, produce real manual accessibility evidence, and validate consumer installs from packed artifacts.

# In scope / Out of scope

In scope:

- Coverage closure for the audit-found gaps
- Real browser and assistive-technology accessibility verification
- Fresh consumer-smoke validation using packed `@uifn/core`, `@uifn/react`, and `@uifn/svelte` artifacts
- Release-gate extension to enforce the new evidence requirements

Out of scope:

- New API design work unless evidence exposes a release-blocking defect
- Broad documentation rewrites beyond evidence references

# Deliverables

- `scripts/verify-uifn-release.mjs`
- `uifn/react/src/accordion.a11y.test.tsx`
- `uifn/react/src/ga-family-integration.test.tsx`
- `uifn/svelte/src/accessibility.a11y.test.ts`
- `uifn/svelte/src/ga-coverage.test.ts`
- `uifn/.conduct/specs/2026-03-25-audit-fix-zl6gfhpb-spec/release-evidence/PHASE_09-coverage-matrix.md`
- `uifn/.conduct/specs/2026-03-25-audit-fix-zl6gfhpb-spec/release-evidence/PHASE_09-manual-accessibility.md`
- `uifn/.conduct/specs/2026-03-25-audit-fix-zl6gfhpb-spec/release-evidence/PHASE_09-consumer-smoke.md`

# Requirements covered

- `REL-003`
- `QA-001`
- `QA-002`
- `COMPAT-001`

# Implementation tasks

- [ ] Add explicit regression tests for the exact audit failures and partials that were still uncovered after Phases 01 through 08.
- [ ] Extend `verify:uifn-release` to create a temporary consumer workspace, install packed tarballs, import the documented entry points, and run minimal type/build smoke.
- [ ] Execute manual keyboard-only verification plus real screen-reader checks in supported environments and record browser, OS, and AT versions in a release-evidence artifact.
- [ ] Replace any remaining jsdom-only “manual” evidence with real execution evidence and fail the release gate if the evidence is absent or stale.
- [ ] Update the coverage matrix artifact so every P0/P1 requirement points to an automated or manual verification record.
- [ ] Re-run the full release gate after the new evidence checks are enforced.

# Verification steps

- `cd /Users/serro/Documents/dev/n/superfunctions && npm run verify:uifn-release -- --dry-run`
- `cd /Users/serro/Documents/dev/n/superfunctions && npm run verify:uifn-release`
- Manual step: verify the generated `PHASE_09-manual-accessibility.md` records actual browser + assistive-tech runs rather than test-run commentary.
- Manual step: inspect the generated consumer-smoke artifact and confirm it installs tarballs, not workspace aliases.

Expected outcomes:

- The release gate fails if required evidence is missing, stale, or based on invalid methodology.
- Consumer smoke proves the documented package contract from a fresh install context.
- Manual accessibility evidence becomes release-quality instead of advisory.

# Stop condition

Report the evidence file paths, the browser/AT matrix used, and the consumer-smoke result before entering final RC closure.

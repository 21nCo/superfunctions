# Phase goal

Run the final clean release-candidate closure and prove that `uifn` is genuinely ready for GA React and Svelte publication.

# In scope / Out of scope

In scope:

- Clean-install release verification
- Final pack/install smoke, evidence review, and contract confirmation
- Release-candidate report or manifest generation

Out of scope:

- Net-new feature work unless the final gate exposes a release blocker

# Deliverables

- `scripts/verify-uifn-release.mjs`
- `uifn/.conduct/specs/2026-03-25-audit-fix-zl6gfhpb-spec/release-evidence/PHASE_10-release-manifest.json`
- `uifn/.conduct/specs/2026-03-25-audit-fix-zl6gfhpb-spec/release-evidence/PHASE_10-rc-report.md`
- updated package changelog entries if the release contract changed during implementation

# Requirements covered

- `REL-002`
- `REL-003`
- `QA-001`
- `QA-002`
- `DOCS-001`
- `COMPAT-001`

# Implementation tasks

- [ ] Run the full release gate from a clean install state and capture the exact output in the RC report.
- [ ] Confirm that packed `@uifn/core`, `@uifn/react`, and `@uifn/svelte` artifacts install and smoke successfully in a fresh consumer workspace.
- [ ] Verify that the root/package docs, exported API, evidence artifacts, and support matrix still match after all fixes.
- [ ] Produce a release manifest or RC report that names the verified package versions, environment matrix, and evidence artifacts.
- [ ] Resolve any final gate regression before signing off the bundle as implementation-complete.

# Verification steps

- `cd /Users/serro/Documents/dev/n/superfunctions && npm ci`
- `cd /Users/serro/Documents/dev/n/superfunctions && npm run verify:uifn-release`
- Manual step: review `uifn/.conduct/specs/2026-03-25-audit-fix-zl6gfhpb-spec/release-evidence/` and confirm the RC report references the final coverage, manual accessibility, and consumer-smoke artifacts.
- Manual step: compare the final published export surfaces against the root/package docs one last time.

Expected outcomes:

- The release gate exits `0` without suppressed warning paths or missing evidence.
- Consumer smoke passes using packed artifacts from a clean install.
- The RC report can be used as the production-readiness signoff artifact for React and Svelte.

# Stop condition

Report the final `verify:uifn-release` result, the RC evidence paths, and any remaining non-GA packages before the bundle is marked complete.

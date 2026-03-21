# Phase goal

Produce and run the final release-candidate verification gate for the `uifn` package family.

# In scope / Out of scope

In scope:

- Final clean-install verification
- Build/test/lint/type/pack smoke for public packages
- Support-matrix enforcement
- Final release manifest/report generation if implemented

Out of scope:

- New runtime behavior work unless a release-blocking regression is found

# Deliverables

- final `verify:uifn-release` command implementation and documentation
- any helper scripts such as `scripts/verify-uifn-release.mjs`
- final machine-readable or parseable verification output
- release notes/changelog entries updated with the final contract decisions

# Requirements covered

- `REL-003`
- `QA-001`
- `QA-002`
- `COMPAT-001`
- `REL-002`

# Implementation tasks

- [ ] Run the full release-gate suite from a clean install state.
- [ ] Verify pack/install smoke for all public packages in the final GA/experimental matrix.
- [ ] Verify that support matrix, peer ranges, and docs still match after the final implementation changes.
- [ ] Capture the final verification output in release notes or phase report form.
- [ ] Fix any release-blocking regressions found by the gate before signoff.

# Verification steps

- `npm ci`
- `npm run verify:uifn-release`
- Create a fresh consumer smoke workspace and install the final tarballs for `@uifn/core`, `@uifn/react`, and `@uifn/svelte`
- Run SSR/hydration smoke for React and mount smoke for Svelte in the consumer workspace

Expected outcomes:

- The release-gate suite exits `0`.
- Consumer smoke installs succeed without workspace aliases.
- Final docs and tarballs match the verified public contract.

# Stop condition

Report the exact release-gate command output, the pack/install smoke results, and any remaining experimental packages before declaring the bundle implementation-complete.

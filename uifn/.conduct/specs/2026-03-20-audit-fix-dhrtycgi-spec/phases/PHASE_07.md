# Phase goal

Close automated QA and accessibility gaps across core, React, and Svelte.

# In scope / Out of scope

In scope:

- Core unit coverage gaps
- React and Svelte integration coverage gaps
- Automated a11y smoke coverage
- Manual accessibility checklist templates and evidence capture

Out of scope:

- Package naming or toolchain changes already completed in earlier phases

# Deliverables

- `uifn/core/src/**/*.test.ts`
- `uifn/react/src/**/*.test.tsx`
- `uifn/svelte/src/**/*.test.ts`
- accessibility smoke fixtures or helpers used by those tests
- checklist/report template files if the implementation chooses to store manual verification evidence in-repo

# Requirements covered

- `QA-001`
- `QA-002`
- `CORE-004`
- `REACT-002`
- `SVELTE-002`

# Implementation tasks

- [ ] Add missing core unit tests for every GA family.
- [ ] Add or repair React integration tests for every GA family and remove skipped release-blocking tests.
- [ ] Add or repair Svelte integration tests for every GA family.
- [ ] Add automated accessibility smoke checks for representative popup, form, collection, and menu families.
- [ ] Create a repeatable manual keyboard/screen-reader checklist template and capture evidence for the release candidate.

# Verification steps

- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/core && npm test -- --run`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/react && npm test -- --run`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/svelte && npm test -- --run`
- Run the automated a11y smoke suite and archive the results in the chosen release evidence location
- Execute the manual keyboard and screen-reader checklist and record pass/fail notes

Expected outcomes:

- No GA family lacks layer-appropriate automated coverage.
- Automated a11y smoke is green.
- Manual accessibility evidence exists for the representative GA families required by the spec.

# Stop condition

Report coverage by family plus links/paths to manual accessibility evidence before final release-gate verification.

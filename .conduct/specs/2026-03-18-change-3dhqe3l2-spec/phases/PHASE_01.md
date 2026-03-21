# Phase goal

Implement the reusable `clifn` package with stable subpath exports and tests.

# In scope / Out of scope

- **In scope**: credentials, config, client, UI, stdio, and prompt modules plus package metadata/tests.
- **Out of scope**: PlugFn provider changes.

# Deliverables

- `/Users/serro/Documents/dev/n/superfunctions/clifn/core/package.json`
- `/Users/serro/Documents/dev/n/superfunctions/clifn/core/src/index.ts`
- `/Users/serro/Documents/dev/n/superfunctions/clifn/core/src/credentials.ts`
- `/Users/serro/Documents/dev/n/superfunctions/clifn/core/src/config.ts`
- `/Users/serro/Documents/dev/n/superfunctions/clifn/core/src/client.ts`
- `/Users/serro/Documents/dev/n/superfunctions/clifn/core/src/ui.ts`
- `/Users/serro/Documents/dev/n/superfunctions/clifn/core/src/stdio.ts`
- `/Users/serro/Documents/dev/n/superfunctions/clifn/core/src/prompt.ts`
- `/Users/serro/Documents/dev/n/superfunctions/clifn/core/tests/*`
- `/Users/serro/Documents/dev/n/superfunctions/clifn/core/README.md`

# Requirements covered

- CLIFN-001
- DOCS-001

# Implementation tasks

- [ ] Build the six public modules and stable subpath exports.
- [ ] Add typed error surfaces for missing profiles, invalid config, and HTTP failures.
- [ ] Add deterministic stdio parsing/serialization tests.
- [ ] Write a README showing Conduct CLI integration and generic reuse.

# Verification steps

1. Run `npm test -- --filter=clifn`.
   Expected: module tests pass.
2. Import each public subpath from a throwaway fixture.
   Expected: resolution succeeds with no private imports.

# Stop condition

Report the exported subpaths, test status, and any unresolved API naming concerns before Phase 02 begins.

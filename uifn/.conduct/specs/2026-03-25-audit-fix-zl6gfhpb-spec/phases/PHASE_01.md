# Phase goal

Establish deterministic shared ID generation and canonical `UIFnError` behavior in `@uifn/core`.

# In scope / Out of scope

In scope:

- Shared deterministic/public ID helpers
- Canonical error codes, payload shape, and assertion helpers
- Exporting the core utilities that adapters must consume

Out of scope:

- Adapter-specific UI rewrites
- Family-level keyboard and modal behavior changes outside the core primitives

# Deliverables

- `uifn/core/src/utils/id.ts`
- `uifn/core/src/utils/id.test.ts`
- `uifn/core/src/utils/index.ts`
- `uifn/core/src/errors.ts`
- `uifn/core/src/errors.test.ts`
- `uifn/core/src/index.ts`

# Requirements covered

- `CORE-002`
- `CORE-003`

# Implementation tasks

- [ ] Define a deterministic, collision-safe public-ID API that supports per-instance prefixes, slot suffixes, and SSR/hydration-safe reuse.
- [ ] Remove any allowance for random or fixed shared IDs in the core contract.
- [ ] Normalize `UIFnErrorCode`, `UIFnErrorPayload`, and construction helpers so adapters can throw typed errors instead of ad hoc `Error` values.
- [ ] Add assertion helpers for missing context, invalid value, range violations, and duplicate public-ID detection.
- [ ] Export the finalized ID and error helpers through stable `@uifn/core` entry points.
- [ ] Add unit coverage for deterministic generation, duplicate detection, and canonical error serialization.

# Verification steps

- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/core && npm run lint`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/core && npm run test -- --run src/utils/id.test.ts src/errors.test.ts`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/core && npm run typecheck`

Expected outcomes:

- The ID helper never depends on `Math.random()` or fixed shared DOM IDs.
- Canonical errors expose stable codes and payloads.
- Core tests fail if duplicate IDs or non-canonical failures are introduced.

# Stop condition

Report the final public ID API, the canonical error-code set in use, and the adapter migration rules before touching React or Svelte call sites.

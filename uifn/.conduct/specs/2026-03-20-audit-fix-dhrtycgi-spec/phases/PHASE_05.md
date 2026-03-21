# Phase goal

Make `@uifn/svelte` a GA adapter with correct reactivity, types, and toolchain compatibility.

# In scope / Out of scope

In scope:

- Svelte public API typing
- Controlled/uncontrolled reactivity correctness
- Supported Vite/Svelte/Vitest matrix
- Package-local build/test/lint/pack verification

Out of scope:

- React implementation work
- New adapter creation beyond Svelte

# Deliverables

- `uifn/svelte/package.json`
- `uifn/svelte/tsup.config.ts`
- `uifn/svelte/vitest.config.mts`
- `uifn/svelte/tsconfig.json`
- `uifn/svelte/src/index.ts`
- `uifn/svelte/src/**/*.svelte`
- `uifn/svelte/src/internal/*.ts`
- `uifn/svelte/src/test/setup.ts`
- `uifn/svelte/src/**/*.test.ts`
- any new generated declaration config or adapter-specific type helpers

# Requirements covered

- `SVELTE-001`
- `SVELTE-002`
- `QA-001`
- `QA-002`
- `COMPAT-001`

# Implementation tasks

- [ ] Align the Svelte/Vite/Vitest dependency graph with a supported matrix.
- [ ] Enable declaration output for the documented public entry points.
- [ ] Replace prop-snapshot patterns with truly reactive controlled/uncontrolled wiring.
- [ ] Resolve `state_referenced_locally` warnings across GA components.
- [ ] Remove leaked tests/internal files from pack output or document them as intentional public artifacts.
- [ ] Add integration and a11y smoke tests for representative Svelte families.

# Verification steps

- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/svelte && npm test -- --run`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/svelte && npm run build`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/svelte && npm run lint`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/svelte && npm pack --dry-run`
- Inspect build output for declarations and confirm zero `state_referenced_locally` warnings

Expected outcomes:

- Svelte package-local verification is green.
- Controlled prop changes after mount are reflected in rendered output and tests.
- Declared public types exist and pack output is clean.

# Stop condition

Report the verified toolchain versions, declaration output status, and remaining warning count before moving to docs and boundary cleanup.

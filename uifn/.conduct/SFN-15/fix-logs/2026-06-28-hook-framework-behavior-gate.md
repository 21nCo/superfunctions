# Hook Framework Behavior Gate

- timestamp: 2026-06-28T06:10:48Z
- requirements: HOOK-001, TEST-001
- status: complete for HOOK-001

## Previous State

Media-query and clipboard equivalents existed across React, Svelte, Vue, Solid, and Angular, but the release verifier only proved the shared adapter-kit behavior plus file/token/manifest presence. Framework wrappers could regress lifecycle behavior, clipboard error reporting, or reset/result semantics without failing `verify-uifn-hooks`.

## Final State

Added focused framework behavior suites:

- `uifn/react/src/hooks/hooks.behavior.test.tsx`
- `uifn/svelte/src/hooks.behavior.test.ts`
- `uifn/vue/src/__tests__/hooks.behavior.test.ts`
- `uifn/solid/src/__tests__/hooks.behavior.test.tsx`
- `uifn/angular/src/__tests__/hooks.behavior.test.ts`

The suites cover no-matchMedia fallback, media-query subscription, listener cleanup, clipboard-unavailable results, clipboard-write-failed results, successful writes, and each framework's public reset/result emission shape where applicable.

Solid keeps its normal SSR-oriented package test config and adds `uifn/solid/vitest.hooks.config.ts` for browser lifecycle proof with browser Solid resolution, so `onMount` and `onCleanup` are actually exercised.

`scripts/verify-uifn-hooks.mjs` now runs adapter-kit plus all five framework suites and fails if hook manifests omit the framework behavior test files. Hook manifests now reference those tests with SHA-256 checksums and clean-room provenance.

## Verification

- `PATH=<node22-bin>:$PATH npm --workspace @uifn/react run test -- src/hooks/hooks.behavior.test.tsx`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/svelte run test -- src/hooks.behavior.test.ts`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/vue run test -- src/__tests__/hooks.behavior.test.ts`
- `PATH=<node22-bin>:$PATH npx vitest run --config uifn/solid/vitest.hooks.config.ts uifn/solid/src/__tests__/hooks.behavior.test.tsx`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/solid run test`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/angular run test -- src/__tests__/hooks.behavior.test.ts`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-hooks.mjs`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/react run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/svelte run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/vue run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/solid run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/angular run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/react run build`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/svelte run build`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/vue run build`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/solid run build`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/angular run build`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-catalog.mjs`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-registry.mjs`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-release.mjs`

## Residual Risk

HOOK-001 is complete. The broader framework adapter rows remain open for full primitive SSR/hydration/component ergonomics audits. Live Storybook story-runner verification, styling closure, docs, security/privacy coverage, and source-install parity remain separate pending requirements.

# Phase goal

Implement the Vite build and dev pipeline for Chromium MV3 and Firefox MV3, including deterministic manifest generation and dev reload strategy.

# In scope / Out of scope

- In scope:
  - Vite plugin integration
  - target-specific manifest generation
  - dev output directories
  - unpacked build outputs
  - dev reload policy
- Out of scope:
  - Svelte adapter specifics
  - DataFn integration

# Deliverables

- Create `extfn/vite/src/index.ts`
- Create `extfn/vite/src/plugin.ts`
- Create `extfn/vite/src/manifest/buildManifest.ts`
- Create `extfn/vite/src/manifest/mergeManifest.ts`
- Create `extfn/vite/src/targets/chromium.ts`
- Create `extfn/vite/src/targets/firefox.ts`
- Create `extfn/vite/src/dev/reloadPolicy.ts`
- Create `extfn/vite/src/dev/devOutputs.ts`
- Create `extfn/vite/__tests__/manifest-build.test.ts`
- Create `extfn/vite/__tests__/reloadPolicy.test.ts`

# Requirements covered

- `BLD-001`
- `BLD-002`
- `BLD-003`
- `SURF-001`
- `CFG-002`

# Implementation tasks

- Implement `extfnVite()` and config integration.
- Build target-aware manifest generation for Chromium and Firefox.
- Emit unpacked build outputs under deterministic target directories.
- Implement target-specific sidepanel omission or failure behavior.
- Implement dev reload strategy selection:
  - page HMR
  - content reinjection
  - background full reload
- Emit structured dev logs describing applied strategy.

# Verification steps

- Run `npm run build -- --filter=@superfunctions/extfn-vite`
- Run `npm run test -- --filter=@superfunctions/extfn-vite`
- Build an example extension for both targets after `PHASE_06` exists.
- Expected outcomes:
  - manifest snapshots pass
  - reload policy fixtures pass
  - both target directories are emitted deterministically

# Stop condition

Stop after manifest and reload fixtures pass and dual-target builds emit valid unpacked outputs.

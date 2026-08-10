# PHASE_01: Package Scaffold Reset

## Phase Goal

Create or reset the SFN-15 package scaffolds and public package metadata.

## In Scope

- Target package folders.
- Package manifests.
- Workspace registration.
- Export maps.
- Status metadata.
- Placeholder READMEs.

## Out of Scope

- Full implementation of package internals.
- Component catalog implementation.

## Deliverables

- `uifn/core/package.json`
- `uifn/adapter-kit/package.json`
- `uifn/react/package.json`
- `uifn/svelte/package.json`
- `uifn/vue/package.json`
- `uifn/solid/package.json`
- `uifn/angular/package.json`
- `uifn/tokens/package.json`
- `uifn/theme/package.json`
- `uifn/theme-tailwind/package.json`
- `uifn/recipes/package.json`
- `uifn/components/package.json`
- `uifn/patterns/package.json`
- `uifn/sf/package.json`
- `uifn/registry/package.json`
- `uifn/storybook/package.json`
- updated root `package.json` workspaces if needed

## Requirements Covered

ARCH-001, VER-001

## Implementation Tasks

1. Create missing package folders.
2. Normalize package names to the target architecture.
3. Add `uifn.status`, `uifn.layer`, `uifn.schemaVersion`, and `uifn.sourcePolicy` metadata.
4. Add `build`, `test`, `typecheck`, and `lint` scripts to every public package.
5. Add explicit export maps.
6. Remove pre-SFN-15 compatibility scaffolding that conflicts with the target package contract.

## Verification Steps

```bash
npm run verify:uifn-release -- --dry-run
node scripts/verify-uifn-package-graph.mjs
```

Expected outcome: package graph and dry-run manifest name every target package without missing metadata.

## Stop Condition

Report packages created, packages rewritten, and legacy surfaces removed.


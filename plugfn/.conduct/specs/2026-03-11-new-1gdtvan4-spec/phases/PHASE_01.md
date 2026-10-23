# Phase goal

Create shared OAuth package scaffolds with stable interfaces and workspace integration.

## In scope / Out of scope

- **In scope**:
  - New package directories and `package.json` setup.
  - Public API type definitions and exports.
  - Build/typecheck plumbing for each package.
- **Out of scope**:
  - Full OAuth runtime logic.
  - `plugfn` integration migration.

## Deliverables

- `packages/oauth-core/package.json`
- `packages/oauth-core/src/index.ts`
- `packages/oauth-http/package.json`
- `packages/oauth-http/src/index.ts`
- `packages/oauth-storage/package.json`
- `packages/oauth-storage/src/index.ts`
- `packages/oauth-providers/package.json`
- `packages/oauth-providers/src/index.ts`
- `packages/oauth-testing/package.json`
- `packages/oauth-testing/src/index.ts`
- Root workspace update in `/Users/serro/Documents/dev/n/superfunctions/package.json` if required.

## Requirements covered

- ARCH-001

## Implementation tasks

1. Create five package directories under `packages/` with TypeScript build configs.
2. Define initial interfaces exactly as specified in `SPEC.md` Public API section.
3. Export stable entrypoints and versioned types.
4. Add workspace dependency wiring and lockfile updates.
5. Add minimal package-level smoke tests for exports.

## Verification steps

1. `cd /Users/serro/Documents/dev/n/superfunctions && npm run build --workspace @superfunctions/oauth-core`
2. `cd /Users/serro/Documents/dev/n/superfunctions && npm run build --workspace @superfunctions/oauth-http`
3. `cd /Users/serro/Documents/dev/n/superfunctions && npm run build --workspace @superfunctions/oauth-storage`
4. `cd /Users/serro/Documents/dev/n/superfunctions && npm run build --workspace @superfunctions/oauth-providers`
5. `cd /Users/serro/Documents/dev/n/superfunctions && npm run build --workspace @superfunctions/oauth-testing`
Expected outcome: all commands exit 0.

## Stop condition

All shared OAuth packages build successfully and expose the required public interfaces.

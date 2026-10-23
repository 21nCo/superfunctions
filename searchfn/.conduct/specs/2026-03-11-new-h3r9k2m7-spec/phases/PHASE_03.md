# Phase 03

## Phase goal

Migrate `searchfn` internal consumers (`client`, `server`, `datafn-provider`) to new imports and dependencies.

## In scope / Out of scope

- **In scope**: source imports, package dependencies, build configs/tests for three consumers.
- **Out of scope**: external monorepo consumers and docs.

## Deliverables

- Updated consumer source imports and package.json dependencies.
- Passing builds/tests for `searchfn` internal packages.

## Requirements covered

- MIG-001
- MIG-002
- PKG-003
- TEST-002

## Implementation tasks

1. Replace type imports with `@searchfn/adapter-contracts`.
2. Replace concrete imports with appropriate leaf adapter packages.
3. Update package dependencies to remove legacy aggregate package.
4. Run package-local build/test/typecheck.

## Verification steps

```bash
npm run build --workspace @searchfn/client
npm run build --workspace @searchfn/server
npm run build --workspace @searchfn/datafn-provider
npm test --workspace @searchfn/client
npm test --workspace @searchfn/server
npm test --workspace @searchfn/datafn-provider
```

Expected outcomes:

- All three packages pass with no reference to `@searchfn/adapters`.

## Stop condition

`searchfn` internal packages are fully migrated and stable.

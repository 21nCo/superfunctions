# Phase 04

## Phase goal

Migrate monorepo consumers outside `searchfn` (`datafn` todo example and `recfn/server`).

## In scope / Out of scope

- **In scope**: import rewrites, dependency rewiring, consumer build validation.
- **Out of scope**: removal of legacy package itself.

## Deliverables

- Updated consumer imports/dependencies in:
  - `datafn/examples/todo-app/client`
  - `datafn/examples/todo-app/server`
  - `recfn/server`

## Requirements covered

- MIG-001
- MIG-002
- PKG-003
- TEST-002

## Implementation tasks

1. Rewrite imports to leaf adapter packages.
2. Update `package.json` dependencies for exact adapter usage.
3. Build each migrated consumer.
4. Validate browser output contains no node-only adapter dependencies.

## Verification steps

```bash
npm run build --workspace todo-app-client
npm run build --workspace todo-app-server
npm run build --workspace recfn-server
rg -n 'postgres-bytea|node_modules/pg|\bpg\b' datafn/examples/todo-app/client/dist/assets/*.js
```

Expected outcomes:

- All builds pass.
- Browser asset grep returns no matches.

## Stop condition

All known external monorepo consumers are migrated and verified.

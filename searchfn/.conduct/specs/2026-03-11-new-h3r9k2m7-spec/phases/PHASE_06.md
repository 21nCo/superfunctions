# Phase 06

## Phase goal

Delete legacy package and enforce no-compat gates with final matrix verification.

## In scope / Out of scope

- **In scope**: remove `searchfn/adapters` package, enforce grep/build gates, final matrix run.
- **Out of scope**: downstream external repository migration.

## Deliverables

- Legacy package removed.
- Final verification report with matrix command outputs.

## Requirements covered

- MIG-003
- TEST-002
- ERR-001

## Implementation tasks

1. Delete legacy adapter package or remove package identity completely.
2. Ensure no references remain in source/docs/package manifests.
3. Run full impacted workspace build matrix.
4. Intentionally check legacy import fails as expected diagnostic.

## Verification steps

```bash
rg -n '@searchfn/adapters' --glob '**/*.ts' --glob '**/*.md' --glob '**/package.json'
turbo run build --filter=@searchfn/adapter-contracts --filter=@searchfn/adapter-memory --filter=@searchfn/adapter-indexeddb --filter=@searchfn/adapter-postgres --filter=@searchfn/adapter-elasticsearch --filter=@searchfn/adapter-opensearch --filter=@searchfn/adapter-meilisearch --filter=@searchfn/client --filter=@searchfn/server --filter=@searchfn/datafn-provider --filter=todo-app-client --filter=todo-app-server --filter=recfn-server
```

Expected outcomes:

- No legacy references.
- Matrix passes.
- Manually reintroduced legacy import fails with deterministic module resolution error.

## Stop condition

All requirements are met and migration is complete with no backward compatibility artifacts.

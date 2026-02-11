# Phase 13

## Phase goal
Implement tenant-scoped deduplication for identical content.

## In scope
- SHA-256 hashing of completed versions.
- Tenant-scoped lookup and reuse of existing storage objects.

## Out of scope
- Cross-tenant dedup.

## Deliverables
- `filefn/server/src/dedup/service.ts`
- `filefn/server/src/upload-sessions/service.ts` (updates to compute hash and dedupe)
- `filefn/server/tests/dedup.test.ts`

## Requirements covered
- DEDUPE-001

## Implementation tasks
1. Define where hashing occurs:
   - at upload completion on the final stored bytes.
2. Store hash on `fileVersions`.
3. When a new version completes:
   - check for existing version with same hash in same tenant
   - if found, reuse bytes (implementation may point to existing key or copy metadata)
4. Add tests:
   - TV-DEDUP-001
   - TV-DEDUP-NEG-001

## Verification steps
1. `npm run build -- --filter=@filefn/server`
2. `npm test -- --filter=@filefn/server`
Expected: exit code 0.

## Stop condition
Report:
- How storage keys are reused (reference vs copy).
- Proof that cross-tenant reuse does not happen.

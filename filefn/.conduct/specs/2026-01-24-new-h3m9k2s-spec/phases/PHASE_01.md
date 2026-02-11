# Phase 01

## Phase goal
Implement shared contracts + primitives (`@superfunctions/storage`, `@superfunctions/files`, `@superfunctions/db` additive KV, `@superfunctions/middleware`).

## In scope
- Finalize `StorageAdapter` + `StorageAdapterCapabilities` interfaces (`@superfunctions/storage`).
- Finalize `FileProvider` interface (`@superfunctions/files`).
- Add `KVStoreAdapter` interface to `@superfunctions/db` (additive).
- Implement `@superfunctions/middleware` rate limiting primitives using persistence via `Adapter` or `KVStoreAdapter`.
- Add conformance test helpers that validate storage adapter capability correctness.

## Out of scope
- Implementing concrete provider adapters.
- Implementing FileFn server/client.

## Deliverables
- `packages/storage/src/types.ts` (interfaces)
- `packages/storage/src/index.ts` (exports)
- `packages/storage/src/conformance.ts` (conformance runner)
- `packages/storage/src/conformance.test.ts`
- `packages/files/src/types.ts` (FileProvider interface)
- `packages/files/src/index.ts` (exports)
- `packages/db/src/adapter/types.ts` (add `KVStoreAdapter`)
- `packages/db/src/index.ts` (export `KVStoreAdapter`)
- `packages/middleware/src/rate-limit.ts` (rate limiting primitives)
- `packages/middleware/src/index.ts` (exports)
- `packages/middleware/src/rate-limit.test.ts`

## Requirements covered
- PKG-001
- PKG-005
- PKG-006
- PKG-007
- STORAGE-001
- STORAGE-002
- STORAGE-003
- STORAGE-004
- STORAGE-005

## Implementation tasks
1. Define `StorageAdapterCapabilities` and make all storage flows capability-gated.
2. Define `StorageAdapter` methods and optional methods tied to capabilities.
3. Define `FileProvider` interface in `@superfunctions/files` used by other functions.
4. Add `KVStoreAdapter` interface to `@superfunctions/db` (additive) and export it.
5. Implement `@superfunctions/middleware` rate limiting primitives:
   - `RateLimiter` interface + `createRateLimiter({ persistence, algorithm })`
   - minimal tests using an in-memory `KVStoreAdapter`
6. Implement a storage adapter conformance runner that:
   - asserts required methods exist when capabilities are true
   - calls a minimal happy-path for stat/delete and (optionally) multipart
7. Add tests that run the conformance runner against a small fake storage adapter.

## Verification steps
1. `npm run build -- --filter=@superfunctions/storage --filter=@superfunctions/files --filter=@superfunctions/middleware --filter=@superfunctions/db`
   - Expected: exit code 0.
2. `npm test -- --filter=@superfunctions/storage --filter=@superfunctions/middleware`
   - Expected: exit code 0.

## Stop condition
Report:
- The finalized interfaces (public surface) and any breaking decisions compared to SPEC.md.
- Confirmation that conformance tests fail on intentional mismatches.

# PHASE 12: Client — Share/Unshare/GetPermissions Methods

## Phase goal
Add `.share()`, `.unshare()`, and `.getPermissions()` convenience methods to the client table API.

## In scope
- Client `.share(id, userId, level)` method
- Client `.unshare(id, userId)` method
- Client `.getPermissions(id)` method
- Type definitions for PermissionEntry

## Out of scope
- Server execution (already done in Phases 10-11)

## Deliverables
- `datafn/client/src/mutate.ts` (updated — share/unshare methods)
- `datafn/client/src/query.ts` (updated — getPermissions)
- `datafn/client/src/__tests__/share-methods.test.ts` (new)

## Requirements covered
- CL-005, CL-006, CL-007

## Implementation tasks
1. Add `.share(id, userId, level)` method:
   - Constructs `{ resource, operation: "share", id, shareWith: { userId, level } }`
   - Sends via mutation path
2. Add `.unshare(id, userId)` method:
   - Constructs `{ resource, operation: "unshare", id, shareWith: { userId } }`
3. Add `.getPermissions(id)` method:
   - Sends a query/request to the getPermissions endpoint
   - Returns `PermissionEntry[]`
4. Define `PermissionEntry` type: `{ userId: string; level: string; grantedBy: string; grantedAt: number }`
5. Export new types from client index
6. Write tests:
   - `.share()` sends correct mutation
   - `.unshare()` sends correct mutation
   - `.getPermissions()` returns entries

## Verification steps
1. `cd datafn/client && npx vitest run` — all tests pass
2. `npx tsc --noEmit` — no type errors

## Stop condition
All three sharing methods work from the client.

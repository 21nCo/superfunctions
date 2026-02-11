# Phase 14

## Phase goal
Add `@filefn/client` offline staging and sync using OPFS.

## In scope
- OPFS-backed pending upload store.
- Sync runner that resumes pending uploads when online.

## Out of scope
- UI.

## Deliverables
- `filefn/client/src/offline/opfs-store.ts`
- `filefn/client/src/offline/sync.ts`
- `filefn/client/tests/offline.test.ts`

## Requirements covered
- CLIENT-002

## Implementation tasks
1. Implement OPFS directory structure:
   - per-uploadSession staging directory
2. Implement staging flow:
   - if offline at upload start, persist file bytes and metadata
3. Implement sync flow:
   - when connectivity returns, create session and upload parts
   - delete staged bytes on success
4. Add tests:
   - TV-CLIENT-OFFLINE-001
   - TV-CLIENT-OFFLINE-NEG-001

## Verification steps
1. `npm run build -- --filter=@filefn/client`
2. `npm test -- --filter=@filefn/client`
Expected: exit code 0.

## Stop condition
Report:
- How offline detection is performed.
- OPFS fallback behavior when unsupported.

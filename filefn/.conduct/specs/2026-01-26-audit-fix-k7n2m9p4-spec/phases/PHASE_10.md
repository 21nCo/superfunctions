# PHASE_10

## Phase goal
Integrate the existing offline modules into the main client SDK behind `config.offline.enabled` and satisfy the offline test vectors.

## In scope
- `FileFnClientConfig.offline` support.
- OPFS staging of uploads when offline.
- Sync/resume behavior when online.

## Out of scope
- Extending offline support beyond the audited spec (e.g., cross-device sync).

## Deliverables
- Modify:
  - `/Users/ar/dev/superfunctions/filefn/client/src/index.ts`
  - `/Users/ar/dev/superfunctions/filefn/client/src/types.ts`
  - `/Users/ar/dev/superfunctions/filefn/client/src/upload-manager.ts`
  - `/Users/ar/dev/superfunctions/filefn/client/src/offline/*` (wire through config)
- Tests:
  - add/extend client offline tests covering TV-CLIENT-OFFLINE-001 and TV-CLIENT-OFFLINE-NEG-001.

## Requirements covered
- CLIENT-002

## Implementation tasks
1. Add `offline?: { enabled: boolean; opfsDir?: string }` to the public client config.
2. If `offline.enabled` is true:
   - detect OPFS availability
   - on offline network, persist pending upload state + bytes to OPFS
   - when online, resume and complete using the standard upload session flow
3. If OPFS is unavailable, fail with a structured error code `FILEFN_OFFLINE_UNSUPPORTED`.

## Verification steps
1. Run client tests:
   - `npm test -- --filter=@filefn/client`
2. Confirm vectors pass:
   - TV-CLIENT-OFFLINE-001
   - TV-CLIENT-OFFLINE-NEG-001

## Stop condition
Report:
- the exact persisted offline state format (keys/records),
- the behavior when the browser does not support OPFS.

# PHASE_07

## Phase goal
Bring events and logging into spec compliance: canonical event names, LogFn integration, correct redaction (no secrets; keep correlation IDs).

## In scope
- Rename emitted events from `file.uploaded`/`file.deleted` to `file:uploaded`/`file:deleted`.
- Ensure event payloads include `requestId`.
- Add LogFn logger support in FileFn config.
- Update redaction to preserve correlation IDs like `req_001` while redacting secrets.

## Out of scope
- Processing enqueue logic (Phase 08).

## Deliverables
- Modify:
  - `/Users/ar/dev/superfunctions/filefn/server/src/events.ts`
  - `/Users/ar/dev/superfunctions/filefn/server/src/index.ts` (accept `logger` in config)
  - `/Users/ar/dev/superfunctions/filefn/server/src/observability/logger.ts`
  - `/Users/ar/dev/superfunctions/filefn/server/src/upload-sessions/service.ts` (emit canonical event names)
  - `/Users/ar/dev/superfunctions/filefn/server/src/files/service.ts` (emit canonical delete event name)
- Tests:
  - Extend `/Users/ar/dev/superfunctions/filefn/server/src/__tests__/observability.test.ts`
  - Add/extend `/Users/ar/dev/superfunctions/filefn/server/src/__tests__/observability-redaction.test.ts`

## Requirements covered
- PROCESS-001
- OBS-001

## Implementation tasks
1. Update event emitter contract:
   - emit `file:uploaded` and `file:deleted` events at minimum.
2. Ensure all events include `requestId` when provided.
3. Integrate logger:
   - accept `logger` in FileFn config
   - log structured lifecycle entries for init/sign/complete/delete
4. Update redaction:
   - do not redact correlation IDs (`req_001`, `upl_0001`, etc.)
   - redact signed URLs and share tokens
5. Add tests to assert:
   - TV-OBS-001 (event name + payload)
   - TV-OBS-NEG-001 (no signed URL in events)
   - TV-OBS-LOG-001 / TV-OBS-LOG-NEG-001 / TV-OBS-REDACTION-001

## Verification steps
1. Run server tests:
   - `npm test -- --filter=@filefn/server`

## Stop condition
Report:
- the final event names emitted,
- the final redaction rules (what is redacted vs preserved).

# Phase 11

## Phase goal
Implement Release 2 processing: OCR and image transforms (resize/crop/rotate).

## In scope
- Add processors:
  - `ocr`
  - `image-transform`
- Server integration: artifact persistence and retrieval.

## Out of scope
- Video/audio.

## Deliverables
- `filefn/processing/src/processors/ocr.ts`
- `filefn/processing/src/processors/image-transform.ts`
- `filefn/processing/tests/ocr.test.ts`
- `filefn/server/src/processing/service.ts` (updates)
- `filefn/server/tests/processing.ocr.integration.test.ts`

## Requirements covered
- PROCESS-002 (OCR + image transforms)

## Implementation tasks
1. Implement OCR processor contract:
   - output artifact: extracted text (and optional hOCR/JSON)
2. Implement image transform processor:
   - operations: resize/crop/rotate
   - deterministic output for test fixtures
3. Integrate with server configuration:
   - enable/disable processors
4. Add integration tests with fixed fixtures.

## Verification steps
1. `npm run build -- --filter=@filefn/processing --filter=@filefn/server`
2. `npm test -- --filter=@filefn/processing --filter=@filefn/server`
Expected: exit code 0.

## Stop condition
Report:
- Supported transforms and their option schema.
- Any non-determinism sources and how they are controlled in tests.

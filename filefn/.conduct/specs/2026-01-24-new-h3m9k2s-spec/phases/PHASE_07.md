# Phase 07

## Phase goal
Implement `@filefn/processing` contracts and Release 1 processors (thumbnail + compression) and integrate into server.

## In scope
- Processor interfaces in `@filefn/processing`.
- Built-in image thumbnail generation.
- Built-in compression processor (generic content).
- Server integration:
  - trigger processing after upload complete
  - persist artifacts metadata
  - expose artifact list/download endpoints
- Optional FlowFn enqueue path.

## Out of scope
- OCR, image transforms beyond thumbnails, video/audio processing.
- Client offline.
- UI.

## Deliverables
- `filefn/processing/src/index.ts`
- `filefn/processing/src/types.ts`
- `filefn/processing/src/processors/thumbnail.ts`
- `filefn/processing/src/processors/compression.ts`
- `filefn/processing/tests/processing.test.ts`
- `filefn/server/src/processing/service.ts`
- `filefn/server/src/processing/routes.ts`
- `filefn/server/tests/processing.integration.test.ts`

## Requirements covered
- PROCESS-002 (partial: thumbnail + compression)
- PROCESS-003

## Implementation tasks
1. Define processor contracts (`Processor`, `ProcessorInput`, `ProcessorOutputArtifact`).
2. Implement thumbnail processor:
   - inputs: image/png, image/jpeg
   - outputs: multiple sizes per config
3. Implement compression processor:
   - inputs: any
   - outputs: compressed variant with metadata
4. Integrate into server:
   - on `upload/complete`, enqueue or run processors
   - store artifacts in DB (`fileArtifacts`)
   - add routes: `GET /:fileId/artifacts` and artifact download
5. Add tests for:
   - TV-PROCESS-001
   - TV-PROCESS-NEG-001
   - TV-PROCESS-FLOW-001

## Verification steps
1. `npm run build -- --filter=@filefn/processing --filter=@filefn/server`
2. `npm test -- --filter=@filefn/processing --filter=@filefn/server`
Expected: exit code 0.

## Stop condition
Report:
- Which processors are shipped and their supported MIME types.
- The artifact schema fields and download behavior.

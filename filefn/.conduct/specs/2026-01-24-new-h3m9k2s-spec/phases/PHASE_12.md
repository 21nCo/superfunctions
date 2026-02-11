# Phase 12

## Phase goal
Implement Release 3 processing: video and audio processing.

## In scope
- Add processors:
  - `video`
  - `audio`
- Server integration: artifact persistence and retrieval.

## Out of scope
- UI.

## Deliverables
- `filefn/processing/src/processors/video.ts`
- `filefn/processing/src/processors/audio.ts`
- `filefn/processing/tests/video-audio.test.ts`
- `filefn/server/src/processing/service.ts` (updates)

## Requirements covered
- PROCESS-002 (video + audio)

## Implementation tasks
1. Define baseline video outputs:
   - poster thumbnail (at configurable timestamp)
   - at least one transcoded variant (format and settings configurable)
2. Define baseline audio outputs:
   - at least one transcoded variant
   - optional metadata artifact (duration, codec)
3. Ensure processors can run in a worker environment with external tooling if required.
4. Add deterministic tests (fixed fixtures).

## Verification steps
1. `npm run build -- --filter=@filefn/processing --filter=@filefn/server`
2. `npm test -- --filter=@filefn/processing --filter=@filefn/server`
Expected: exit code 0.

## Stop condition
Report:
- The exact baseline output artifacts produced for video and audio.
- Tooling/runtime requirements (if any) and how tests run locally.

# Phase 04: Recording capture and storage (filefn)

## Phase goal
Implement recording capture from platform audio/video streams and storage via filefn, so that after a bot leaves, a recording is stored and downloadable.

## In scope
- Audio/video stream → file encoding (ffmpeg or MediaRecorder equivalent for Node.js).
- Recording upload to filefn/storage on bot leave.
- Signed download URL generation.
- Recording API routes: GET /bots/:botId/recordings, GET /recordings/:recordingId, GET /recordings/:recordingId/download.
- Recording entity creation in store.
- Upload timeout enforcement (<60s for 1h recordings).

## Out of scope
- ASR. Transcription. WebSocket. Webhooks. Desktop capture.

## Deliverables
- `recfn/server/src/recording/capture.ts` — stream → file encoder
- `recfn/server/src/recording/storage.ts` — filefn upload/download wrapper
- `recfn/server/src/recording/signed-url.ts` — signed URL generation
- `recfn/server/src/routes/recordings.ts` — full recording routes (replace stubs)
- `recfn/server/src/integrations/filefn.ts` — filefn client wrapper
- `recfn/server/__tests__/recording-capture.test.ts`
- `recfn/server/__tests__/recording-storage.test.ts`
- `recfn/server/__tests__/api-recordings.test.ts`

## Requirements covered
- REC-001, REC-003, REC-004, REC-005, REC-006, INT-002, SEC-003

## Implementation tasks
1. Create filefn client wrapper: upload(bytes, key), download(key), signedUrl(key, expiresIn).
2. Implement capture.ts: consume audio/video ReadableStream, pipe to ffmpeg (or fluent-ffmpeg) for MP4/WAV encoding, write to temp file.
3. Implement storage.ts: on bot leave, upload temp file to filefn with namespace-scoped key, create Recording entity in store.
4. Implement signed-url.ts: generate time-limited signed URLs via filefn.
5. Update bot worker: after bot transitions to "left", enqueue recording-upload job to flowfn.
6. Implement recording-upload job handler: capture → encode → upload → create Recording → transition bot to "done" (or enqueue transcription).
7. Implement GET /bots/:botId/recordings: query store by botId.
8. Implement GET /recordings/:recordingId: return recording with downloadUrl.
9. Implement GET /recordings/:recordingId/download: 302 redirect to signed URL.
10. Write tests: capture from mock stream, upload to mock filefn, API routes return correct data.

## Verification steps
- `cd recfn/server && npx vitest run` — all recording tests pass.
- Tests cover: TV-REC-001, TV-REC-003, TV-REC-004, TV-REC-005, TV-INT-002, TV-SEC-003.

## Stop condition
- Recording captured from audio stream, stored in filefn, downloadable via signed URL. All tests pass. Report: "Phase 04 complete; recording capture and storage ready for Phase 05."

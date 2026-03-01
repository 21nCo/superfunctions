# Phase 05: Whisper ASR adapter and batch transcription

## Phase goal
Implement the Whisper ASR adapter for local transcription and the batch transcription pipeline so recordings can be transcribed after meetings.

## In scope
- Whisper ASR adapter implementing AsrAdapter interface (batch mode).
- POST /recordings/:recordingId/transcribe endpoint.
- Transcription job processing via flowfn.
- Transcript entity creation and storage.
- GET /recordings/:recordingId/transcript endpoint (JSON format).
- Speaker diarization via Whisper.
- Idempotency: 409 if transcription already in progress.

## Out of scope
- Real-time transcription. WebSocket. Cloud ASR adapters. Export formats (SRT/VTT/text). Search indexing.

## Deliverables
- `recfn/adapters/whisper/package.json`
- `recfn/adapters/whisper/src/index.ts` — WhisperAdapter class
- `recfn/adapters/whisper/src/runner.ts` — whisper.cpp / openai-whisper child process runner
- `recfn/adapters/whisper/__tests__/whisper-adapter.test.ts`
- `recfn/server/src/transcription/pipeline.ts` — batch transcription job handler
- `recfn/server/src/transcription/registry.ts` — ASR adapter registry
- `recfn/server/src/routes/transcripts.ts` — full transcript routes (replace stubs)
- `recfn/server/__tests__/transcription-pipeline.test.ts`
- `recfn/server/__tests__/api-transcripts.test.ts`

## Requirements covered
- ASR-002, TRX-002, TRX-003, TRX-004, TRX-005 (json only), TRX-006, TRX-007

## Implementation tasks
1. Create `recfn/adapters/whisper/` with package.json.
2. Implement WhisperAdapter: transcribeBatch(audioRef, opts) — download audio from filefn, invoke whisper.cpp via child_process.spawn (or openai-whisper via Python subprocess), parse output to Segment[].
3. Implement speaker diarization: use Whisper's built-in diarization or pyannote.audio as post-process.
4. Implement supportedLanguages(): return list from Whisper model.
5. Implement transcribeStream() stub: throw "not supported in CPU mode" or implement with streaming chunked approach.
6. Create ASR adapter registry in server: register adapters by name, lookup by name, validate name.
7. Implement POST /recordings/:recordingId/transcribe: validate recording exists, check no transcription in progress (409), enqueue transcription job.
8. Implement transcription pipeline job handler: load ASR adapter from registry, invoke transcribeBatch, sort segments by startTime, create Transcript entity in store.
9. Implement GET /recordings/:recordingId/transcript: return Transcript JSON (segments sorted by startTime, speakerId tiebreaker).
10. Write tests: Whisper adapter with mock child process, transcription pipeline with mock ASR, API routes (create, get, idempotency).

## Verification steps
- `cd recfn/adapters/whisper && npm install && npm run build` — builds without errors.
- `cd recfn/server && npx vitest run` — all transcription tests pass.
- Tests cover: TV-ASR-001, TV-TRX-002, TV-TRX-003, TV-TRX-004, TV-TRX-005, TV-TRX-006, TV-TRX-007.

## Stop condition
- Whisper adapter transcribes audio files. Batch transcription pipeline works end-to-end. Transcripts retrievable via API. Idempotency enforced. All tests pass. Report: "Phase 05 complete; batch transcription ready for Phase 06."

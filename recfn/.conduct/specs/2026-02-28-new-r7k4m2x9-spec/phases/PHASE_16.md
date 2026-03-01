# Phase 16: Cloud ASR adapters (Deepgram, AssemblyAI, Google STT)

## Phase goal
Implement three additional ASR adapters for cloud transcription services, providing real-time streaming and batch modes.

## In scope
- Deepgram ASR adapter: streaming + batch, speaker diarization.
- AssemblyAI ASR adapter: real-time + batch, speaker diarization.
- Google Speech-to-Text ASR adapter: streaming + batch.
- Register all adapters in ASR registry.
- API key storage via secfn.

## Out of scope
- Desktop. Calendar. Platform adapters.

## Deliverables
- `recfn/adapters/deepgram/package.json`
- `recfn/adapters/deepgram/src/index.ts` — DeepgramAdapter class
- `recfn/adapters/deepgram/__tests__/deepgram-adapter.test.ts`
- `recfn/adapters/assemblyai/package.json`
- `recfn/adapters/assemblyai/src/index.ts` — AssemblyAIAdapter class
- `recfn/adapters/assemblyai/__tests__/assemblyai-adapter.test.ts`
- `recfn/adapters/google-stt/package.json`
- `recfn/adapters/google-stt/src/index.ts` — GoogleSttAdapter class
- `recfn/adapters/google-stt/__tests__/google-stt-adapter.test.ts`

## Requirements covered
- ASR-003, ASR-004, ASR-005

## Implementation tasks
1. **Deepgram**: Create adapter package. Implement transcribeStream using Deepgram's live API (WebSocket). Implement transcribeBatch using Deepgram's pre-recorded API. Map Deepgram response to Segment[]. Handle diarization.
2. **AssemblyAI**: Create adapter package. Implement transcribeBatch using AssemblyAI's transcription API (upload + poll). Implement transcribeStream using AssemblyAI's real-time API. Map response to Segment[].
3. **Google STT**: Create adapter package. Implement transcribeStream using Google Cloud Speech-to-Text streaming API. Implement transcribeBatch using long-running recognize. Map response to Segment[].
4. Register all three adapters in ASR registry (server).
5. Write unit tests for each adapter with mocked API responses.

## Verification steps
- Each adapter: `npm install && npm run build` — builds.
- Each adapter: `npx vitest run` — tests pass.
- Tests cover: TV-ASR-002, TV-ASR-003, TV-ASR-004.

## Stop condition
- All three cloud ASR adapters implement AsrAdapter interface. Streaming and batch modes work with mocked APIs. Registered in server. All tests pass. Report: "Phase 16 complete; cloud ASR adapters ready for Phase 17."

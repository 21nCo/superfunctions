# Phase goal

Consolidate cloud ASR helpers and restore honest, capability-gated live transcription.

## In scope / Out of scope

- In scope:
  - shared cloud ASR helper layer
  - real-time capability gating
  - deterministic transcript ordering
- Out of scope:
  - SDK parity work

## Deliverables

- `recfn/adapters/shared-cloud/package.json`
- `recfn/adapters/shared-cloud/src/transport.ts`
- `recfn/adapters/shared-cloud/src/polling.ts`
- `recfn/adapters/shared-cloud/src/segments.ts`
- `recfn/adapters/deepgram/src/index.ts`
- `recfn/adapters/assemblyai/src/index.ts`
- `recfn/adapters/google-stt/src/index.ts`
- `recfn/server/src/transcription/realtime.ts`
- `recfn/server/src/transcription/pipeline.ts`
- `recfn/server/src/search/indexer.ts`
- `recfn/server/__tests__/realtime-transcription.test.ts`
- `recfn/server/__tests__/search-indexer.test.ts`

## Requirements covered

- `ARCH-004`
- `TRX-001`
- `TRX-002`

## Implementation tasks

1. Introduce shared cloud ASR helpers for transport, timeout, and polling orchestration.
2. Refactor cloud adapters to consume the helpers.
3. Add capability gating so unsupported live combinations fail before capture starts.
4. Preserve deterministic segment ordering in the batch path and downstream indexing.
5. Add or extend tests for streaming behavior and ordering.

## Verification steps

- `npm test --workspace recfn-deepgram`
- `npm test --workspace recfn-assemblyai`
- `npm test --workspace recfn-google-stt`
- `npm test --workspace recfn-server -- realtime-transcription search-indexer`

Expected outcome:

- Cloud adapters share helper code.
- Real-time transcription is either truly live or deterministically rejected.

## Stop condition

Report back with the supported real-time matrix and passing ASR plus server tests.


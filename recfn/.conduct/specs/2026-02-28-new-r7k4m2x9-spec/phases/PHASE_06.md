# Phase 06: Real-time transcription and WebSocket streaming

## Phase goal
Implement real-time transcription during live meetings via WebSocket, streaming ASR segments to connected clients with <2s latency.

## In scope
- WebSocket server endpoint: WS /ws/transcripts/:botId.
- Real-time ASR pipeline: audio stream → ASR adapter (streaming mode) → segments → WebSocket broadcast.
- WebSocket authentication (token query param or first message).
- WebSocket frame types: segment, participant_joined, participant_left, status, error, ping/pong.
- Connection limit per bot (50).
- Connection lifecycle (close on bot leave/error).

## Out of scope
- New ASR adapters. Export formats. Webhooks. Desktop.

## Deliverables
- `recfn/server/src/ws/server.ts` — WebSocket server setup
- `recfn/server/src/ws/transcript-stream.ts` — per-bot WebSocket broadcast manager
- `recfn/server/src/ws/auth.ts` — WebSocket authentication
- `recfn/server/src/ws/frames.ts` — frame type definitions
- `recfn/server/src/transcription/realtime.ts` — real-time ASR pipeline (audio → adapter → segments)
- `recfn/server/__tests__/ws-transcript.test.ts`
- `recfn/server/__tests__/ws-auth.test.ts`
- `recfn/server/__tests__/realtime-transcription.test.ts`

## Requirements covered
- TRX-001, WS-001, WS-002, WS-003

## Implementation tasks
1. Set up WebSocket server alongside HTTP server (ws library or native).
2. Implement WS auth: extract token from query param or first message, validate via secfn, derive namespace.
3. Implement transcript-stream.ts: per-bot connection manager, track connected clients, broadcast segments to all, enforce 50-connection limit.
4. Implement realtime.ts: pipe bot's audio stream to ASR adapter's transcribeStream(), collect segments, broadcast via transcript-stream.
5. Implement frame types: { type: "segment", data: Segment }, { type: "participant_joined", data: Participant }, etc.
6. Hook into bot worker: when enableRealTimeTranscript is true and bot is recording, start real-time pipeline.
7. Implement ping/pong: client sends { type: "ping" }, server responds { type: "pong" }.
8. Implement connection close: when bot transitions to leaving/left/error, close all WebSocket connections for that bot.
9. Write tests: WS connection with valid auth, segment delivery, participant events, connection limit, close on bot leave, invalid auth rejection.

## Verification steps
- `cd recfn/server && npx vitest run` — all WebSocket tests pass.
- Tests cover: TV-TRX-001, TV-WS-001, TV-WS-002, TV-WS-003.

## Stop condition
- WebSocket endpoint streams real-time segments. Auth enforced. Connection limit enforced. Connections close on bot leave. All tests pass. Report: "Phase 06 complete; real-time transcription and WebSocket ready for Phase 07."

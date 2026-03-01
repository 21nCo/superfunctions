# Phase 03: Zoom platform adapter

## Phase goal
Implement the Zoom platform adapter so bots can join Zoom meetings, capture audio/video, track participants, and capture chat messages.

## In scope
- Zoom Meeting SDK integration for bot join/leave.
- Audio stream capture (mixed + per-participant where available).
- Video stream capture (composite).
- Participant tracking (join/leave events, names, emails, roles).
- Chat message capture (read incoming messages).
- Chat message sending (consent message).
- Meeting metadata extraction (title, etc.).

## Out of scope
- Google Meet adapter. Teams adapter. ASR. Recording storage (file writing). WebSocket.

## Deliverables
- `recfn/platforms/zoom/package.json`
- `recfn/platforms/zoom/tsconfig.json`
- `recfn/platforms/zoom/src/index.ts` — ZoomAdapter class implementing PlatformAdapter
- `recfn/platforms/zoom/src/meeting-sdk.ts` — Zoom Meeting SDK wrapper
- `recfn/platforms/zoom/src/audio-capture.ts` — audio stream capture
- `recfn/platforms/zoom/src/video-capture.ts` — video stream capture
- `recfn/platforms/zoom/src/participants.ts` — participant tracking
- `recfn/platforms/zoom/src/chat.ts` — chat capture and sending
- `recfn/platforms/zoom/__tests__/zoom-adapter.test.ts` — unit tests with mocked SDK

## Requirements covered
- PLAT-002, PAR-001, CHAT-001, CHAT-002, REC-002 (per-participant audio)

## Implementation tasks
1. Create `recfn/platforms/zoom/` with package.json (dep: @zoom/meetingsdk or equivalent, recfn-core).
2. Implement ZoomAdapter class implementing PlatformAdapter interface.
3. Implement join(meetingUrl, config): extract meeting ID/password from URL, initialize Zoom SDK, join meeting with displayName.
4. Implement leave(): gracefully leave meeting.
5. Implement getAudioStream(): return ReadableStream of audio chunks from Zoom SDK raw audio callback.
6. Implement getVideoStream(): return ReadableStream of video frames.
7. Implement participant tracking: listen to Zoom SDK participant events, maintain participant list, fire onParticipantJoin/onParticipantLeave callbacks.
8. Implement chat: listen to Zoom SDK chat events, capture messages, implement sendChatMessage.
9. Implement getMetadata(): return meeting title and other available metadata from Zoom SDK.
10. Write unit tests with mocked Zoom SDK: adapter lifecycle, participant events, chat capture.

## Verification steps
- `cd recfn/platforms/zoom && npm install && npm run build` — builds without errors.
- `cd recfn/platforms/zoom && npx vitest run` — all tests pass.
- Integration test (manual): `node test-zoom-join.js <meeting-url>` — bot joins a Zoom meeting, captures audio for 10s, lists participants, leaves.

## Stop condition
- ZoomAdapter implements full PlatformAdapter interface. Unit tests pass with mocked SDK. Manual integration test succeeds with a real Zoom meeting. Report: "Phase 03 complete; Zoom adapter ready for Phase 04."

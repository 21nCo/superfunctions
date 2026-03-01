# Phase 10: Google Meet platform adapter

## Phase goal
Implement the Google Meet platform adapter using headless browser (Puppeteer/Playwright) for bot join/leave, audio capture, participant tracking, and chat.

## In scope
- Headless browser approach for Google Meet.
- Bot join via URL (automated browser navigation, click "Join" button).
- Audio capture via WebRTC or virtual audio device.
- Participant tracking via DOM observation.
- Chat message capture via DOM observation.
- Chat message sending.
- Meeting metadata extraction.

## Out of scope
- Teams adapter. Desktop. New ASR adapters.

## Deliverables
- `recfn/platforms/meet/package.json`
- `recfn/platforms/meet/tsconfig.json`
- `recfn/platforms/meet/src/index.ts` — MeetAdapter class implementing PlatformAdapter
- `recfn/platforms/meet/src/browser.ts` — headless browser management (Puppeteer/Playwright)
- `recfn/platforms/meet/src/audio-capture.ts` — WebRTC audio stream capture
- `recfn/platforms/meet/src/participants.ts` — DOM-based participant tracking
- `recfn/platforms/meet/src/chat.ts` — DOM-based chat capture/send
- `recfn/platforms/meet/__tests__/meet-adapter.test.ts`

## Requirements covered
- PLAT-003

## Implementation tasks
1. Create `recfn/platforms/meet/` with package.json (deps: puppeteer or playwright, recfn-core).
2. Implement browser.ts: launch headless Chrome, navigate to Meet URL, handle "Join now" / "Ask to join" flows.
3. Implement MeetAdapter.join(): navigate to URL, wait for join completion, handle authentication (Google account may be needed — document as prerequisite).
4. Implement MeetAdapter.leave(): click leave button or close page.
5. Implement audio-capture.ts: intercept WebRTC media streams via browser CDP protocol or inject script to capture getUserMedia audio.
6. Implement participants.ts: observe Meet's participant panel DOM for join/leave events.
7. Implement chat.ts: observe Meet's chat panel DOM, send messages by typing into chat input.
8. Implement getMetadata(): extract meeting title from DOM.
9. Write unit tests with mocked browser page.
10. Document prerequisites: Chrome/Chromium installed, Google account for bot (optional, depends on meeting settings).

## Verification steps
- `cd recfn/platforms/meet && npm install && npm run build` — builds.
- `cd recfn/platforms/meet && npx vitest run` — unit tests pass.
- Manual integration test: bot joins a Google Meet, captures audio snippet, lists participants.

## Stop condition
- MeetAdapter implements PlatformAdapter interface. Unit tests pass. Manual test with real Google Meet succeeds. Report: "Phase 10 complete; Google Meet adapter ready for Phase 11."

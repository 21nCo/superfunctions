# Phase 11: Microsoft Teams platform adapter

## Phase goal
Implement the Microsoft Teams platform adapter for bot join/leave, audio capture, participant tracking, and chat.

## In scope
- Teams bot integration via Microsoft Graph Communications API or headless browser fallback.
- Bot join via Teams meeting URL.
- Audio capture.
- Participant tracking.
- Chat message capture and sending.
- Meeting metadata extraction.

## Out of scope
- Desktop. New ASR adapters. Calendar integration.

## Deliverables
- `recfn/platforms/teams/package.json`
- `recfn/platforms/teams/tsconfig.json`
- `recfn/platforms/teams/src/index.ts` — TeamsAdapter class implementing PlatformAdapter
- `recfn/platforms/teams/src/graph-api.ts` — Microsoft Graph Communications API client (or browser.ts for headless approach)
- `recfn/platforms/teams/src/audio-capture.ts` — audio stream capture
- `recfn/platforms/teams/src/participants.ts` — participant tracking
- `recfn/platforms/teams/src/chat.ts` — chat capture/send
- `recfn/platforms/teams/__tests__/teams-adapter.test.ts`

## Requirements covered
- PLAT-004

## Implementation tasks
1. Create `recfn/platforms/teams/` with package.json.
2. Evaluate approach: Graph Communications API (requires Azure Bot registration, more native) vs headless browser (simpler setup, less reliable). Document decision and prerequisites.
3. Implement TeamsAdapter.join(): join Teams meeting via chosen approach.
4. Implement TeamsAdapter.leave(): leave meeting gracefully.
5. Implement audio capture: extract audio stream from Teams call.
6. Implement participant tracking: track join/leave events.
7. Implement chat: capture and send messages.
8. Implement getMetadata(): extract meeting title and metadata.
9. Write unit tests with mocked API/browser.
10. Document prerequisites: Azure Bot registration (if Graph API) or browser setup.

## Verification steps
- `cd recfn/platforms/teams && npm install && npm run build` — builds.
- `cd recfn/platforms/teams && npx vitest run` — unit tests pass.
- Manual integration test: bot joins a Teams meeting.

## Stop condition
- TeamsAdapter implements PlatformAdapter interface. Unit tests pass. Manual test succeeds. Report: "Phase 11 complete; Teams adapter ready for Phase 12."

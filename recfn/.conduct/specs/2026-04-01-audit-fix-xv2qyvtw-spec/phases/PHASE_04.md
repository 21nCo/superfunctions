# Phase goal

Harden the Zoom path to the full production recording, metadata, chat, and participant lifecycle.

## In scope / Out of scope

- In scope:
  - Zoom recording pipeline
  - Zoom metadata/chat/participant persistence integration
- Out of scope:
  - Meet and Teams fixes

## Deliverables

- `recfn/platforms/zoom/src/index.ts`
- `recfn/platforms/zoom/src/audio-capture.ts`
- `recfn/platforms/zoom/src/video-capture.ts`
- `recfn/platforms/zoom/src/participants.ts`
- `recfn/platforms/zoom/src/chat.ts`
- `recfn/platforms/zoom/__tests__/zoom-adapter.test.ts`
- `recfn/server/__tests__/e2e.test.ts`

## Requirements covered

- `PLAT-001`
- `BOT-002`

## Implementation tasks

1. Ensure Zoom media capture feeds the finalization pipeline.
2. Persist Zoom chat, participant, and metadata events.
3. Validate aggregate bot responses for completed Zoom meetings.
4. Add or expand Zoom end-to-end coverage.

## Verification steps

- `npm test --workspace recfn-zoom`
- `npm test --workspace recfn-server -- e2e`

Expected outcome:

- Zoom meetings complete through the production recording path and populate aggregate bot data.

## Stop condition

Report back with a passing Zoom end-to-end scenario that yields an aggregate bot view with recording, metadata, and chat data.


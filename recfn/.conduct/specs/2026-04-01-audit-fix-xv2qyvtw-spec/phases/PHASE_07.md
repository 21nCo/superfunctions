# Phase goal

Implement real Microsoft Teams capture on top of the shared browser core.

## In scope / Out of scope

- In scope:
  - Teams audio capture implementation
  - deterministic prerequisite failure behavior
  - end-to-end Teams recording pipeline
- Out of scope:
  - new unnamed platform support

## Deliverables

- `recfn/platforms/teams/src/index.ts`
- `recfn/platforms/teams/src/audio-capture.ts`
- `recfn/platforms/teams/src/browser.ts`
- `recfn/platforms/teams/src/chat.ts`
- `recfn/platforms/teams/src/participants.ts`
- `recfn/platforms/teams/__tests__/teams-adapter.test.ts`
- `recfn/server/__tests__/recording-capture.test.ts`

## Requirements covered

- `PLAT-003`
- `BOT-001`

## Implementation tasks

1. Replace the placeholder Teams audio path with a real capture implementation.
2. Define the runtime prerequisite checks and failure codes.
3. Ensure successful capture can drive the standard finalization/upload pipeline.
4. Extend Teams tests to assert non-empty audio behavior and deterministic failure behavior.

## Verification steps

- `npm test --workspace recfn-teams`
- `npm test --workspace recfn-server -- recording-capture`

Expected outcome:

- Teams capture produces real audio when prerequisites are satisfied and deterministic failures otherwise.

## Stop condition

Report back with the capture approach used for Teams and passing adapter + server recording tests.


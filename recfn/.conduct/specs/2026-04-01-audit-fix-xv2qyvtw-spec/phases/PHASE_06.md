# Phase goal

Implement real Google Meet capture on top of the shared browser core.

## In scope / Out of scope

- In scope:
  - Meet audio capture implementation
  - deterministic prerequisite failure behavior
  - end-to-end Meet recording pipeline
- Out of scope:
  - Teams capture work

## Deliverables

- `recfn/platforms/meet/src/index.ts`
- `recfn/platforms/meet/src/audio-capture.ts`
- `recfn/platforms/meet/src/browser.ts`
- `recfn/platforms/meet/src/chat.ts`
- `recfn/platforms/meet/src/participants.ts`
- `recfn/platforms/meet/__tests__/meet-adapter.test.ts`
- `recfn/server/__tests__/recording-capture.test.ts`

## Requirements covered

- `PLAT-002`
- `BOT-001`

## Implementation tasks

1. Replace the placeholder Meet audio path with a real capture implementation.
2. Define the runtime prerequisite checks and failure codes.
3. Ensure successful capture can drive the standard finalization/upload pipeline.
4. Extend Meet tests to assert non-empty audio behavior and deterministic failure behavior.

## Verification steps

- `npm test --workspace recfn-meet`
- `npm test --workspace recfn-server -- recording-capture`

Expected outcome:

- Meet capture produces real audio when prerequisites are satisfied and deterministic failures otherwise.

## Stop condition

Report back with the capture approach used for Meet and passing adapter + server recording tests.


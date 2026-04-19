# Phase goal

Extract a shared browser-core package to remove duplicated Meet/Teams lifecycle logic.

## In scope / Out of scope

- In scope:
  - shared session bootstrap
  - shared observer lifecycle
  - shared capture lifecycle contract
- Out of scope:
  - real Meet/Teams audio implementation details

## Deliverables

- `recfn/platforms/browser-core/package.json`
- `recfn/platforms/browser-core/src/session.ts`
- `recfn/platforms/browser-core/src/chat.ts`
- `recfn/platforms/browser-core/src/participants.ts`
- `recfn/platforms/browser-core/src/audio-capture.ts`
- `recfn/platforms/meet/package.json`
- `recfn/platforms/teams/package.json`
- `recfn/platforms/meet/src/index.ts`
- `recfn/platforms/teams/src/index.ts`
- `recfn/platforms/browser-core/__tests__/browser-core.test.ts`

## Requirements covered

- `ARCH-003`
- `INT-001`

## Implementation tasks

1. Create the new `browser-core` workspace package.
2. Move shared session, participant, chat, and capture lifecycle logic into the package.
3. Refactor Meet and Teams adapters to consume the shared package.
4. Preserve the existing public adapter interfaces.
5. Add package-level tests for the shared core.

## Verification steps

- `npm exec --workspace recfn-browser-core tsc --noEmit`
- `npm test --workspace recfn-browser-core`
- `npm test --workspace recfn-meet`
- `npm test --workspace recfn-teams`

Expected outcome:

- Browser-core tests pass and Meet/Teams tests remain green while sharing the new common package.

## Stop condition

Report back with the list of common behaviors now owned by browser-core and passing package tests.


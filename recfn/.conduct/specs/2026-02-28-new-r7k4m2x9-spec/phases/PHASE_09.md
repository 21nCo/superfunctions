# Phase 09: Consent mechanism and participant tracking enhancements

## Phase goal
Implement the consent mechanism (bot announces recording, tracks consent per participant) and complete participant tracking with join/leave events.

## In scope
- Consent message delivery on bot join (via platform adapter sendChatMessage).
- Consent status tracking per participant (granted, denied, pending, unknown).
- Bot state machine: bot does not transition to "recording" until consent message is sent.
- Participant consent field in API responses.
- Webhook events for participant join/leave (wiring from Phase 08).

## Out of scope
- Consent enforcement (legal policy is consumer's responsibility). New platforms.

## Deliverables
- `recfn/server/src/worker/consent.ts` — consent message delivery and tracking
- `recfn/server/src/routes/participants.ts` — update to include consent field
- `recfn/server/__tests__/consent.test.ts`
- `recfn/server/__tests__/participant-tracking.test.ts`

## Requirements covered
- BOT-008, PAR-002, PAR-003, SEC-006

## Implementation tasks
1. Implement consent.ts: after bot reaches "joined", send consent message via platform adapter sendChatMessage.
2. Update bot worker lifecycle: insert consent delivery step between "joined" and "recording" transitions.
3. Track consent status per participant: default "pending" on bot join, "unknown" for participants who don't interact.
4. Add consent field to Participant entity in store and API responses.
5. Wire participant join/leave events to webhook delivery (from Phase 08 hooks).
6. Handle consent message failure gracefully: log warning, proceed to recording (non-fatal).
7. Write tests: consent message sent before recording, consent status tracked, participant events fire webhooks.

## Verification steps
- `cd recfn/server && npx vitest run` — all consent and participant tests pass.
- Tests cover: TV-BOT-010, TV-PAR-002, TV-PAR-003.

## Stop condition
- Consent message sent before recording starts. Consent status tracked per participant. Participant webhooks working. All tests pass. Report: "Phase 09 complete; consent and participant tracking ready for Phase 10."

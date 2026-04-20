# Phase goal

Restore automatic recording finalization so bot-driven sessions create persisted recordings without manual upload.

## In scope / Out of scope

- In scope:
  - bot finalization state handling
  - recording capture orchestration
  - queue wiring for finalization/upload
- Out of scope:
  - platform-specific media-capture quality fixes
  - SDK parity changes

## Deliverables

- `recfn/server/src/worker/bot-worker.ts`
- `recfn/server/src/worker/lifecycle.ts`
- `recfn/server/src/recording/capture.ts`
- `recfn/server/src/recording/storage.ts`
- `recfn/server/src/integrations/flowfn.ts`
- `recfn/server/src/routes/upload.ts`
- `recfn/server/__tests__/recording-capture.test.ts`
- `recfn/server/__tests__/recording-storage.test.ts`
- `recfn/server/__tests__/bot-lifecycle.test.ts`

## Requirements covered

- `BOT-001`
- `LIMIT-001`
- `OBS-001`

## Implementation tasks

1. Introduce an explicit `finalizing` lifecycle stage or equivalent deterministic finalization workflow.
2. Capture finalized media from platform adapters and persist it through shared storage.
3. Queue or orchestrate upload/finalization from the bot lifecycle instead of relying on manual import.
4. Emit recording lifecycle logs and metrics, including upload latency.
5. Keep the manual upload endpoint as an import/backfill path.

## Verification steps

- `npm test --workspace recfn-server -- bot-lifecycle recording-capture recording-storage`

Expected outcome:

- Bot sessions create recordings automatically after leave/end.
- Upload failures produce deterministic failure behavior.

## Stop condition

Report back with a passing end-to-end lifecycle test that creates a recording without manual upload.


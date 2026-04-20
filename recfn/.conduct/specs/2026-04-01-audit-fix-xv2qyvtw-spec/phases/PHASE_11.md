# Phase goal

Finish the remediation with shared observability wiring, compatibility docs, and repo-root release gates.

## In scope / Out of scope

- In scope:
  - structured logs and metrics
  - compatibility shims and migration notes
  - repo-root build/typecheck/test gates
- Out of scope:
  - new feature work outside the remediation scope

## Deliverables

- `recfn/server/src/observability/metrics.ts`
- `recfn/server/src/observability/latency.ts`
- `recfn/server/src/integrations/logfn.ts`
- `recfn/server/src/index.ts`
- `recfn/server/CHANGELOG.md`
- `recfn/server/src/calendar/MIGRATION.md`
- `recfn/core/tsconfig.json`
- `recfn/server/tsconfig.json`
- `recfn/client/tsconfig.json`
- `recfn/cli/tsconfig.json`
- `recfn/desktop/tsconfig.json`
- `recfn/.conduct/audits/2026-04-01-q4k2n8-full-audit.md` (reference only; do not edit)

## Requirements covered

- `OBS-001`
- `BUILD-001`
- `COMPAT-001`

## Implementation tasks

1. Wire structured metrics and safe structured logs into the corrected production paths.
2. Add migration notes for any compatibility-correcting changes.
3. Fix package tsconfig/runtime build issues so repo-root gates pass.
4. Define a single repo-root verification command set for completion.

## Verification steps

- `npx turbo run build --filter=recfn --filter=recfn-server --filter=recfn-client --filter=recfn-cli --filter=recfn-desktop --filter=recfn-zoom --filter=recfn-meet --filter=recfn-teams --filter=recfn-whisper --filter=recfn-deepgram --filter=recfn-assemblyai --filter=recfn-google-stt`
- `npx turbo run test --filter=recfn --filter=recfn-server --filter=recfn-client --filter=recfn-cli --filter=recfn-desktop --filter=recfn-zoom --filter=recfn-meet --filter=recfn-teams --filter=recfn-whisper --filter=recfn-deepgram --filter=recfn-assemblyai --filter=recfn-google-stt`

Expected outcome:

- All targeted recfn packages build and test cleanly from `repo root`.
- Migration notes and observability wiring are complete.

## Stop condition

Report back with the final repo-root gate results and the migration note locations.


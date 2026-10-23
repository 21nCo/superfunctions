# Phase goal

Establish the durable persistence and shared storage foundations required for every later production fix.

## In scope / Out of scope

- In scope:
  - durable DB-backed repositories
  - shared storage adapter integration
  - server config seam changes required for production foundations
- Out of scope:
  - platform-specific capture fixes
  - SDK and CLI changes

## Deliverables

- `recfn/server/src/store/types.ts`
- `recfn/server/src/store/db.ts`
- `recfn/server/src/store/schema.ts`
- `recfn/server/src/integrations/storage.ts`
- `recfn/server/src/index.ts`
- `recfn/server/package.json`
- `recfn/server/__tests__/db-store.test.ts`
- `recfn/server/__tests__/storage-adapter.test.ts`

## Requirements covered

- `ARCH-001`
- `ARCH-002`
- `INT-001`

## Implementation tasks

1. Define the durable repository contract backed by `@superfunctions/db`.
2. Introduce schema definitions for bots, recordings, transcripts, participants, chat, metadata, calendars, and webhooks.
3. Replace the bespoke production storage seam with `@superfunctions/storage`.
4. Keep an in-memory path only for tests and explicit local dev harnesses.
5. Update the server boot config to require DB and storage in the production path.
6. Add tests covering namespace-scoped read/write behavior and signed URL generation.

## Verification steps

- `npm exec --workspace recfn-server tsc --noEmit`
- `npm test --workspace recfn-server -- db-store storage-adapter`

Expected outcome:

- TypeScript compiles for the new persistence/storage seams.
- Persistence and storage tests pass from `repo root`.

## Stop condition

Report back with the final repository and storage interface shapes plus passing persistence/storage tests.


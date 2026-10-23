# PHASE_00

- Phase goal: Close the unresolved TypeScript audit failures and metadata persistence defects without changing migration architecture yet.
- In scope / Out of scope
  - In scope: TS replace-completion auth re-check, anonymous init replay stability, metadata persistence on upload completion, carried-forward regression coverage.
  - Out of scope: storage routing, viewer package, Nucleus integration, migration scripts.
- Deliverables
  - `filefn/server/src/index.ts`
  - `filefn/server/src/upload-sessions/service.ts`
  - `filefn/server/src/files/service.ts`
  - `filefn/server/src/__tests__/upload-sessions.test.ts`
  - `filefn/server/src/__tests__/permissions.test.ts`
  - `filefn/server/src/__tests__/files.test.ts`
  - `filefn/server/src/__tests__/idempotency-complete.test.ts`
- Requirements covered
  - `AUTH-001`
  - `AUTH-002`
  - `UPLOAD-001`
  - `META-001`
  - `BUILD-001`
- Implementation tasks
  1. Re-check replace authorization inside upload completion before publishing a replacement version.
  2. Persist and replay the original anonymous upload-session token on identical init idempotency replays.
  3. Persist upload metadata on file completion instead of writing `{}`.
  4. Update TS tests for positive and negative replay/auth/metadata cases.
- Verification steps
  - `npm --prefix /Users/serro/Documents/dev/n/superfunctions/filefn/server test -- --run src/__tests__/upload-sessions.test.ts src/__tests__/permissions.test.ts src/__tests__/files.test.ts src/__tests__/idempotency-complete.test.ts`
  - `npm --prefix /Users/serro/Documents/dev/n/superfunctions/filefn/server run typecheck`
  - `npm --prefix /Users/serro/Documents/dev/n/superfunctions/filefn/server run build`
  - Expected outcome: all commands exit `0`; new tests prove replay/token/auth semantics and metadata persistence.
- Stop condition
  - Report exact test files added/updated and confirm the TS compliance-audit failures for `AUTH-001`, `AUTH-002`, and metadata persistence are closed.

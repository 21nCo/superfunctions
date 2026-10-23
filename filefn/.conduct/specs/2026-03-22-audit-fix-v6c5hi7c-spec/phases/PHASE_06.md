# PHASE_06

- Phase goal: Migrate Nucleus write paths to native FileFn IDs and canonical FileFn client APIs without keeping legacy file-resource creation on new writes.
- In scope / Out of scope
  - In scope: Nucleus upload entry points, write-path ID persistence, policy selection, temp upload mapping, embed/download write behavior.
  - Out of scope: final render cutover, legacy migration scripts, deletion of old read-path code.
- Deliverables
  - `/Users/serro/Documents/dev/n/nucleus/client/stores/account.store.ts`
  - `/Users/serro/Documents/dev/n/nucleus/client/persistence/persistence.ts`
  - `/Users/serro/Documents/dev/n/nucleus/client/elements/avatarPicker/AvatarPicker.svelte`
  - `/Users/serro/Documents/dev/n/nucleus/client/elements/coverPicker/CoverPicker.svelte`
  - `/Users/serro/Documents/dev/n/nucleus/client/products/memotron/capture/capture.store.ts`
  - `/Users/serro/Documents/dev/n/nucleus/client/components/markdown/mediaGrid/MediaGrid.svelte`
  - targeted Nucleus tests under `/Users/serro/Documents/dev/n/nucleus/tests`
- Requirements covered
  - `CLIENT-001`
  - `CLIENT-003`
  - `POLICY-001`
  - `NUCLEUS-001`
  - `BUILD-001`
- Implementation tasks
  1. Replace new-write paths so they persist native FileFn IDs.
  2. Map Nucleus temp/durable intent to FileFn policies rather than legacy bucket flags.
  3. Replace raw upload helper usage with FileFn client APIs plus any temporary compatibility wrapper needed for cutover.
  4. Add targeted Nucleus tests for avatar, cover, memotron capture, and markdown temp upload write paths.
- Verification steps
  - `npm --prefix /Users/serro/Documents/dev/n/nucleus/tests test`
  - `npm --prefix /Users/serro/Documents/dev/n/nucleus run build:nucleus`
  - Expected outcome: new write-path tests pass and no new legacy `file:` resource writes occur.
- Stop condition
  - Report the exact Nucleus write paths migrated and the remaining legacy read paths intentionally left for later phases.

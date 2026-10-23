# PHASE_07

- Phase goal: Build the deterministic legacy migration toolchain for export, import/adoption, rewrite mapping, and rollback.
- In scope / Out of scope
  - In scope: manifest schema, dry-run/apply workflow, import/adopt logic, rewrite manifest, rollback manifest.
  - Out of scope: final deletion of compatibility code.
- Deliverables
  - new `/Users/serro/Documents/dev/n/nucleus/tools/filefn/export-legacy-files.ts`
  - new `/Users/serro/Documents/dev/n/superfunctions/filefn/scripts/import-legacy-manifest.ts`
  - new `/Users/serro/Documents/dev/n/nucleus/tools/filefn/rewrite-file-refs.ts`
  - migration fixtures under `filefn/` and/or `nucleus/tests/fixtures/`
  - automated tests for export/import/rewrite deterministic behavior
- Requirements covered
  - `MIG-001`
  - `MIG-002`
  - `META-001`
  - `STORAGE-001`
  - `BUILD-001`
- Implementation tasks
  1. Define manifest schemas and deterministic target-file-ID derivation.
  2. Implement export dry-run with validation errors for ambiguous/conflicting rows.
  3. Implement import/adopt logic that backfills FileFn rows against existing storage keys when safe.
  4. Implement rewrite manifest and rollback manifest generation.
  5. Add automated tests for deterministic dry-run/apply behavior.
- Verification steps
  - `node /Users/serro/Documents/dev/n/nucleus/tools/filefn/export-legacy-files.ts --dry-run --fixture /Users/serro/Documents/dev/n/nucleus/tests/fixtures/filefn-migration.json`
  - `node /Users/serro/Documents/dev/n/superfunctions/filefn/scripts/import-legacy-manifest.ts --dry-run --manifest /tmp/filefn-legacy-manifest.json`
  - `node /Users/serro/Documents/dev/n/nucleus/tools/filefn/rewrite-file-refs.ts --dry-run --mapping /tmp/filefn-mapping.json`
  - Expected outcome: dry-run outputs are deterministic and non-mutating; apply-mode tests prove import/rewrite correctness.
- Stop condition
  - Report the manifest schemas, deterministic ID algorithm, and the conditions that force byte-copy fallback instead of in-place adoption.

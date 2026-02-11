# PHASE_11: Dataset import / export

## Phase goal

Implement deterministic dataset export/import artifacts for backup, restore, and environment promotion.

## In scope

- HTTP endpoints:
  - `POST /contentfn/datasets/export`
  - `POST /contentfn/datasets/import`
- Deterministic artifact format and validation
- Import creates dataset if absent and restores:
  - schema + schema version
  - documents (draft + published)
  - assets metadata
  - revision history references (full snapshots acceptable as baseline)

## Out of scope

- Large binary asset transfer in the artifact (may be out-of-band; must be documented)

## Deliverables

- `contentfn/server/src/http/endpoints/importExport.ts`
- `contentfn/server/src/importExport/exportDataset.ts`
- `contentfn/server/src/importExport/importDataset.ts`
- `contentfn/server/src/importExport/format.ts` (artifact schema)
- Tests implementing:
  - TV-IMP-EXPORT-001
  - TV-IMP-IMPORT-001
  - TV-IMP-IMPORT-002

## Requirements covered

- IMP-001

## Implementation tasks

1. Define artifact JSON schema:
   - version field for artifact itself
   - dataset name
   - exportedAt timestamp
   - schema record
   - docs arrays (published + drafts)
   - assets metadata array
   - revisions array (or references)
2. Implement export:
   - fetch schema and all entities in stable ordering
   - produce canonical JSON (stable key ordering) and return in envelope
3. Implement import:
   - validate artifact deterministically
   - create dataset if needed
   - upsert schema enforcing monotonic rules
   - insert documents/assets/revisions preserving IDs
4. Ensure cross-dataset isolation (import cannot write outside target dataset).
5. Add tests for:
   - export shape
   - import into new dataset yields equivalent query results
   - malformed artifact fails with `VALIDATION_FAILED`

## Verification steps

- Run import/export tests.
- Repeat export twice without state changes and confirm deterministic artifact (byte-for-byte) when timestamps are excluded or fixed per test harness.

## Stop condition

- Import/export endpoints pass referenced TVs and artifact format is documented and deterministic.


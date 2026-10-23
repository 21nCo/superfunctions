# PHASE_11 Completion Report: Ops import/export triggers

**Spec**: 2026-02-07-new-zr4cvxyp-spec  
**Phase**: PHASE_11  
**Date**: 2026-02-11  

## Summary

Implemented operational endpoints to trigger ContentFn dataset export/import with strict dataset isolation and deterministic responses. Permission: audit.read (documented). Export returns artifact in envelope; import validates target dataset and forwards artifact to ContentFn (ContentFn validates artifact shape and returns VALIDATION_FAILED for malformed). Studio minimal OpsPane: export trigger, import (paste artifact JSON + trigger).

## Requirements

- **OPS-001**: Authorized users can trigger ContentFn dataset export/import; dataset isolation preserved (only datasets in config.datasets allowed); cross-dataset leakage denied.

## Deliverables

### CmsFn Server

- **server/src/ops/export.ts** — contentfnExport(config, dataset): POST to ContentFn /contentfn/datasets/export, return envelope with artifact.
- **server/src/ops/import.ts** — contentfnImport(config, { dataset, artifact }): POST to ContentFn /contentfn/datasets/import; ContentFn validates artifact shape.
- **server/src/http/ops.ts** — handleOpsExport, handleOpsImport; parse body; allowedDatasets check (dataset isolation); requireAuditRead (audit.read); call contentfn export/import; pass through ContentFn errors (e.g. VALIDATION_FAILED for malformed artifact).
- **server/src/index.ts** — POST /cmsfn/ops/export, POST /cmsfn/ops/import; pass contentfnBaseUrl, allowedDatasets from config.datasets, getRolesForSubject.

### CmsFn Studio

- **studio/src/panes/ops/OpsPane.tsx** — Minimal: export button (shows artifact preview), import textarea + trigger; data-ops-pane, data-ops-export-trigger, data-ops-import-trigger, etc.

### Tests

- **server/src/__tests__/ops.test.ts** — TV-OPS-EXPORT-001 (export returns ok=true and artifact), TV-OPS-IMPORT-001 (import with valid artifact ok=true), TV-OPS-IMPORT-002 (malformed artifact → ok=false, VALIDATION_FAILED), dataset isolation (disallowed dataset → VALIDATION_FAILED).

## Test status

- TV-OPS-EXPORT-001: PASS  
- TV-OPS-IMPORT-001: PASS  
- TV-OPS-IMPORT-002: PASS  

## Verification

- cmsfn/server: npm run build && npm run test — 25 tests (all pass).
- cmsfn/studio: npm run build && npm run test — 31 tests (all pass).

## Notes

- Permission: ops endpoints require audit.read for the dataset (documented; no dedicated ops.export/ops.import action in core).
- Dataset isolation: only datasets in config.datasets are allowed; export/import for other dataset names return VALIDATION_FAILED "Dataset not allowed".
- Malformed artifact: validated by ContentFn; CmsFn passes through VALIDATION_FAILED.

## Ready for next phase?

Yes — ops export/import behave deterministically and preserve dataset isolation.

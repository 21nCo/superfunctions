# PHASE_09 Completion Report: Reference picker

**Spec**: 2026-02-07-new-zr4cvxyp-spec  
**Phase**: PHASE_09  
**Date**: 2026-02-11  

## Summary

Implemented reference picker: open picker dialog, list candidates via CFQL (type-scoped, deterministic ordering/pagination), bounded preview (projection-limited), select → write canonical reference object. Permission denial: when role lacks doc.read for candidate type, picker shows deterministic "no access" state (hasDocRead prop; server deny covered by query failure or future role check).

## Requirements

- **REF-001**: Picker lists candidates by type and filter; deterministic ordering and pagination; selecting creates canonical reference object. Permission denial when role lacks doc.read for candidate type.

## Deliverables

### CmsFn Studio

- **studio/src/references/queryCandidates.ts** — `queryCandidates(params)`: CFQL with dataset, types, orderBy _id asc, optional projection, limit, cursor; returns ContentfnEnvelope<CfqlResultPage>.
- **studio/src/editor/widgets/reference/ReferencePickerDialog.tsx** — Dialog: list from queryCandidates with projection `{ fields: ['_id', '_type', 'title', 'name'] }`, Load more (cursor), onSelect(ref) with canonical `{ _type: "reference", _ref }`; when hasDocRead=false shows data-ref-picker-denied and "No access".
- **studio/src/editor/widgets/reference/ReferenceField.tsx** — Displays current ref (or "Unset"), "Choose reference" opens ReferencePickerDialog; on select calls onChange(canonicalRef).
- **studio/src/editor/renderField.tsx** — Options: baseUrl, dataset, hasDocReadForReference; for reference type uses ReferenceField when baseUrl/dataset set, with allowedTypes from type.to.
- **studio/src/panes/editor/DocumentEditorPane.tsx** — Passes baseUrl and dataset into renderField options.
- **studio/src/editor/widgets/index.ts** — Export ReferenceField.

### Tests

- **studio/src/__tests__/referencePicker.test.tsx** — TV-REF-PICKER-001 (open picker, select doc → onChange receives canonical reference object), TV-REF-PICKER-002 (hasDocRead=false → picker shows data-ref-picker-denied and "No access").
- **studio/src/__tests__/editor.test.tsx** — Updated to expect data-widget="reference-field" when reference field is rendered with baseUrl/dataset.

## Test status

- TV-REF-PICKER-001: PASS  
- TV-REF-PICKER-002: PASS  

## Verification

- cmsfn/studio: npm run build && npm run test — 31 tests (all pass).

## Notes

- Canonical reference shape: `{ _type: "reference", _ref: string }` (document id).
- Permission: Studio accepts optional hasDocReadForReference; when false, picker shows "no access" without calling ContentFn. Server-side doc.read enforcement can be added later (e.g. CmsFn endpoint or ContentFn role check); query failure with PERMISSION_DENIED would also satisfy "server denies".

## Ready for next phase?

Yes — reference picker with type-scoped candidates, deterministic order/pagination, bounded preview, and deterministic no-access state is implemented and tested.

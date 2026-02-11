# PHASE_14 Completion Report: Extensibility + collaboration polish

**Spec**: 2026-02-07-new-zr4cvxyp-spec  
**Phase**: PHASE_14 (final)  
**Date**: 2026-02-11  

## Summary

Implemented deterministic extension points for custom field widgets and desk panes, and finalized multi-session live update behavior: list refetch on realtime events and remote-changed banner in open editors.

## Requirements

- **PLUG-001**: Field widget extension interface; register per (typeName, fieldName) or fieldType; deterministic conflict resolution (last wins).
- **DESK-001**: Desk custom pane registration and deterministic routing (registerPane / getPaneComponent / getRegisteredPaneIds).
- **COLLAB-001**: Lists update on publish/patch events; open editors show remote-changed banner when doc is patched elsewhere.

## Deliverables

### Core

- **core/src/plugins/registry.ts** — `createWidgetRegistry()`: register(selector, widgetId), getWidgetId(typeName, fieldName, fieldType). Most specific match wins; last registration wins for same selector. `createPaneRegistry()`: register(paneId), has(), getRegisteredPaneIds().

### Studio

- **studio/src/plugins/registerWidget.tsx** — `registerWidget(selector, component)`, `getWidgetForField(typeName, fieldName, fieldType)`. Uses core widget registry; stores React components by id.
- **studio/src/editor/renderField.tsx** — Consults `getWidgetForField(docTypeName, field.name, fieldTypeKind)` when `options.docTypeName` is set; renders custom widget when present.
- **studio/src/panes/editor/DocumentEditorPane.tsx** — Passes `docTypeName` into renderField options. Accepts `remoteChanged` and `onClearRemoteChanged`; renders `data-remote-changed-banner` with "Document changed elsewhere" and Refresh button.
- **studio/src/desk/registerPane.tsx** — `registerPane(paneId, Component)`, `getPaneComponent(paneId)`, `getRegisteredPaneIds()`. Uses core pane registry for deterministic ids.
- **studio/src/realtime/applyEvents.ts** — Pure `applyEvents(event, ctx)` → `{ listShouldRefetch, showRemoteChangedBanner }`. Event types event/doc.patch/doc.publish; ctx has openDocId, listDataset. Normalizes draft id matching (drafts.X ↔ X).
- **studio/src/realtime/subscribe.ts** — Added `subscribeToDataset({ realtimeUrl, dataset, onEvent })` for dataset-level realtime; onEvent receives `{ type, dataset, docId }`.
- **studio/src/app.tsx** — State `listRefreshTrigger`, `remoteChanged`. Effect: `subscribeToDataset` when realtimeUrl and dataset set; onEvent calls `applyEvents` and updates state. Passes `refreshTrigger` to DocumentListPane, `remoteChanged`/`onClearRemoteChanged` to DocumentEditorPane. Clearing remoteChanged when opening a doc from list.
- **studio/src/panes/list/DocumentListPane.tsx** — Optional `refreshTrigger` prop; effect runs `runQuery()` when `refreshTrigger` changes (TV-COLLAB-001).

## Test status

- **TV-PLUG-001**: PASS — Custom widget registered for (typeName, fieldName) is used when renderField is called with docTypeName (plugins.test.tsx).
- **TV-PLUG-002**: PASS — Two widgets for same (typeName, fieldName); second registration wins (plugins.test.tsx).
- **TV-COLLAB-001**: PASS — applyEvents returns listShouldRefetch for event in same dataset; DocumentListPane accepts refreshTrigger and refetches (realtimeApplyEvents.test.ts, collab.test.tsx).
- **TV-COLLAB-002**: PASS — applyEvents returns showRemoteChangedBanner when event doc matches open doc (incl. drafts.X ↔ X); DocumentEditorPane shows data-remote-changed-banner when remoteChanged true (realtimeApplyEvents.test.ts, collab.test.tsx).

### Additional tests

- **core/src/plugins/registry.test.ts** — Widget registry: no match, typeName+fieldName, last wins, specificity (typeName+fieldName over fieldType), fieldType applies to any. Pane registry: has, getRegisteredPaneIds.

## Verification

- cmsfn/core: `npm run build && npm run test` — 24 tests (all pass).
- cmsfn/studio: `npm run build && npm run test` — 49 tests (all pass).

## Notes

- Custom panes are registered but app.tsx does not yet route a desk node to a custom pane (e.g. customPane kind in desk config); the extension mechanism is in place for PHASE_14. History/Webhooks panes from PHASE_12 can be registered via registerPane if desired.
- Realtime event shape from ContentFn is assumed to include `type: "event"`, `dataset`, and `document._id`; applyEvents normalizes to docId for matching.

## Ready for next phase?

N/A — PHASE_14 is the final phase. Spec implementation complete.

# PHASE_05: Schema-driven editor (widgets + save + conflicts)

## Phase goal

Implement schema-driven document editors that render field widgets, save via ContentFn patch with `ifRev`, and surface validation/conflict errors deterministically.

## In scope

- Editor pane UI for documents:
  - render widgets for ContentFn field kinds
  - required field indicators
  - richtext basic editor (block array)
  - asset/reference field placeholders (full pickers in later phases)
- Save behavior:
  - construct patch ops deterministically
  - call ContentFn `docs.patch` with `ifRev`
- Error handling:
  - ContentFn `VALIDATION_FAILED` mapping to fields
  - ContentFn `REV_CONFLICT` conflict UI

## Out of scope

- Preview pane (PHASE_07)
- Full media/reference pickers (PHASE_08/09)

## Deliverables

- `cmsfn/studio/src/panes/editor/DocumentEditorPane.tsx`
- `cmsfn/studio/src/editor/renderField.tsx`
- `cmsfn/studio/src/editor/widgets/*` (string/number/boolean/date/object/array/richtext/reference/asset)
- `cmsfn/studio/src/editor/save/buildPatchOps.ts`
- `cmsfn/studio/src/editor/conflicts/ConflictBanner.tsx`
- Tests implementing:
  - TV-EDITOR-RENDER-001
  - TV-EDITOR-RENDER-002
  - TV-EDITOR-VALIDATE-001
  - TV-EDITOR-VALIDATE-002
  - TV-EDITOR-SAVE-001
  - TV-EDITOR-CONFLICT-001

## Requirements covered

- SCHEMA-001
- SCHEMA-002
- DOC-002

## Implementation tasks

1. Fetch schema for dataset and cache it in Studio state.
2. Map schema field types to widgets deterministically.
3. Implement pre-validation for required fields and simple type checks.
4. Build patch ops:
   - compute changed fields
   - create `set`/`unset` ops in stable order (sorted by path)
5. Call `docs.patch` with `ifRev`.
6. Handle errors:
   - `VALIDATION_FAILED`: highlight field via `details.path`
   - `REV_CONFLICT`: show conflict UI with refresh and re-apply strategy (deterministic)
7. Add tests for widget rendering and save network shapes.

## Verification steps

- Run editor tests; confirm patch ops ordering is stable.
- Simulate REV_CONFLICT and ensure deterministic UI state.

## Stop condition

- Editor renders schema-driven widgets, saves via patch with `ifRev`, and passes referenced TVs.


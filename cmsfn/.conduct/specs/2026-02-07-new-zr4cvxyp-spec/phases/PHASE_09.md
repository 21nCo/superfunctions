# PHASE_09: Reference picker

## Phase goal

Implement the reference picker widget for reference fields with deterministic browse/search and bounded previews.

## In scope

- Reference widget UX:
  - open picker dialog
  - list candidates via CFQL (type-scoped)
  - deterministic ordering and pagination
  - bounded preview (projection-limited)
  - select → write canonical reference object into document
- Permission enforcement:
  - if role denies `doc.read` for candidate type, picker denies deterministically

## Out of scope

- Complex graph traversal beyond bounded preview

## Deliverables

- `cmsfn/studio/src/editor/widgets/reference/ReferenceField.tsx`
- `cmsfn/studio/src/editor/widgets/reference/ReferencePickerDialog.tsx`
- `cmsfn/studio/src/references/queryCandidates.ts`
- Tests implementing:
  - TV-REF-PICKER-001
  - TV-REF-PICKER-002

## Requirements covered

- REF-001

## Implementation tasks

1. Implement candidate query:
   - types filter
   - projection for display fields (title/name)
   - deterministic ordering and paging
2. Implement bounded preview:
   - use ContentFn expand/projection limited fields
3. Enforce permissions:
   - deny picker access when role lacks read permission
4. Add tests for selection and denial behavior.

## Verification steps

- Run reference picker tests.

## Stop condition

- Reference picker works deterministically and respects permissions.


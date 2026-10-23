# PHASE_08: Media library (assets)

## Phase goal

Implement media library UX: upload, browse, and insert canonical asset references into documents.

## In scope

- Media pane UI:
  - upload asset
  - browse assets deterministically
  - select asset and insert into asset field or richtext
- Limits enforcement for uploads (client pre-check + server error surfacing)

## Out of scope

- Image transformations and rendition management (undefined unless configured)

## Deliverables

- `cmsfn/studio/src/panes/media/MediaLibraryPane.tsx`
- `cmsfn/studio/src/media/upload.ts`
- `cmsfn/studio/src/media/browse.ts`
- `cmsfn/studio/src/media/insertAssetRef.ts`
- Tests implementing:
  - TV-MEDIA-UPLOAD-001
  - TV-MEDIA-BROWSE-001
  - TV-MEDIA-INSERT-001
  - TV-LIMIT-UPLOAD-001

## Requirements covered

- MEDIA-001
- LIMIT-001 (upload)

## Implementation tasks

1. Implement asset upload:
   - pre-check size vs `maxUploadBytes`
   - call ContentFn assets.upload
2. Implement browse:
   - deterministic ordering (e.g., createdAt desc, assetId asc)
3. Implement insert:
   - create canonical asset ref object and patch doc
4. Add tests for deterministic ordering and limit rejection.

## Verification steps

- Run media tests.

## Stop condition

- Media library works end-to-end and enforces limits deterministically.


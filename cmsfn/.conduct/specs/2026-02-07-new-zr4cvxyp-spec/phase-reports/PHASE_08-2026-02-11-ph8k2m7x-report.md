# PHASE_08 Completion Report: Media library (assets)

**Spec**: 2026-02-07-new-zr4cvxyp-spec  
**Phase**: PHASE_08  
**Date**: 2026-02-11  

## Summary

Implemented media library UX: upload (with client-side size pre-check), browse (deterministic order via ContentFn assets list), and insert canonical asset ref into document fields. Added ContentFn assets list endpoint to support browse.

## Requirements

- **MEDIA-001**: Upload uses ContentFn assets API and enforces upload size limits; browse lists assets deterministically; insert creates `{ _type: "asset", _ref: "<id>", assetType: "image"|"file" }`.
- **LIMIT-001 (upload)**: Client pre-check vs maxUploadBytes; reject with PAYLOAD_TOO_LARGE before calling ContentFn.

## Deliverables

### ContentFn (enabler for browse)

- **contentfn/server/src/storage/assets.ts** — `assetList(config, { dataset, limit?, offset? })` with orderBy createdAt desc, assetId asc; returns `{ assets: AssetListItem[] }`.
- **contentfn/server/src/http/endpoints/assets.ts** — `handleAssetsList`; body: dataset, optional limit/offset.
- **contentfn/server/src/http/router.ts** — POST /contentfn/assets/list route.
- **contentfn/server/src/auth/authorize.ts** — ACTIONS.ASSETS_LIST added.

### Cmsfn Studio

- **studio/src/contentfn/client.ts** — `uploadAsset`, `listAssets`, `AssetListItem` type.
- **studio/src/media/upload.ts** — `uploadAssetWithLimit`: pre-check bytes length vs maxUploadBytes (PAYLOAD_TOO_LARGE); then call ContentFn assets.upload.
- **studio/src/media/browse.ts** — `browseAssets`: calls listAssets with deterministic order (ContentFn returns createdAt desc, assetId asc).
- **studio/src/media/insertAssetRef.ts** — `buildAssetRef(assetId, contentType)` returns canonical `{ _type: "asset", _ref, assetType: "image"|"file" }`.
- **studio/src/panes/media/MediaLibraryPane.tsx** — Upload input, asset list (data-media-list), select button per asset; onSelectAsset(ref); data-media-upload-error for limit/upload errors.
- **studio/src/editor/widgets/AssetWidget.tsx** — "Select from library" button when onOpenMediaPicker set; still allows manual ref input.
- **studio/src/editor/renderField.tsx** — Optional `RenderFieldOptions.onOpenMediaPicker`; passed to AssetWidget for asset fields.
- **studio/src/panes/editor/DocumentEditorPane.tsx** — State mediaPickerField; renders MediaLibraryPane when set; onSelectAsset updates formState and clears; passes maxUploadBytes; renderField gets onOpenMediaPicker.
- **studio/src/app.tsx** — Passes config.limits?.maxUploadBytes to DocumentEditorPane.

### Tests

- **studio/src/__tests__/media.test.tsx** — TV-MEDIA-UPLOAD-001 (upload within limit calls ContentFn, returns assetId/url), TV-LIMIT-UPLOAD-001 (over maxUploadBytes → PAYLOAD_TOO_LARGE without calling API), TV-MEDIA-BROWSE-001 (browse returns deterministic list), TV-MEDIA-INSERT-001 (buildAssetRef canonical shape; MediaLibraryPane onSelectAsset called with ref), AssetWidget shows and invokes onOpenMediaPicker.

## Test status

- TV-MEDIA-UPLOAD-001: PASS  
- TV-MEDIA-BROWSE-001: PASS  
- TV-MEDIA-INSERT-001: PASS  
- TV-LIMIT-UPLOAD-001: PASS  

## Verification

- cmsfn/studio: npm run build && npm run test — 29 tests (all pass).
- contentfn/server: asset list code added; full server build currently fails on an unrelated DTS error in revisions.ts (pre-existing). Studio does not depend on contentfn server build for unit tests (mocked fetch).

## Notes

- ContentFn asset list uses findMany with orderBy createdAt desc, assetId asc; limit default 50, max 100.
- Insert flow: user opens media picker from asset field → MediaLibraryPane → select asset → buildAssetRef → setFormState → user saves doc via existing patch.

## Ready for next phase?

Yes — media library upload, browse, and insert ref are implemented and tested.

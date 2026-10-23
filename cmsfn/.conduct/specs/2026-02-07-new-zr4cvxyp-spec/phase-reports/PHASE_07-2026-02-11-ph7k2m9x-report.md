# PHASE_07 Completion Report: Preview tokens + live preview updates

**Spec**: 2026-02-07-new-zr4cvxyp-spec  
**Phase**: PHASE_07  
**Date**: 2026-02-11  

## Summary

Implemented preview token minting on the CmsFn server (POST /cmsfn/preview/token), deterministic disabled UI when preview is not configured, and a Studio preview pane that requests a token, builds the preview URL with the token, and refreshes on draft changes (via refreshTrigger after save and optional ContentFn realtime subscription).

## Requirements

- **PREVIEW-001**: Studio can request a preview token and open a preview URL; draft edits cause preview to update (via refresh-on-save and optional realtime); missing preview config returns PREVIEW_NOT_CONFIGURED or deterministic disabled UI.
- **COLLAB-001 (partial)**: Live updates via realtime subscription (subscribe.ts) and refresh-on-save trigger.

## Deliverables

### Server

- **`server/src/preview/tokens.ts`** — `mintPreviewToken(config, dataset, docIds)` (HMAC-signed payload with dataset, docIds, exp), `verifyPreviewToken(secret, token)`; deterministic expiry (ttlSec, default 15 min).
- **`server/src/http/preview.ts`** — `handlePreviewToken`: validates body (dataset required; docId or docIds), returns PREVIEW_NOT_CONFIGURED when preview disabled or no previewSecret, authorizes doc.read, mints token, returns `CmsfnPreviewTokenResult` (token, expiresAt, dataset, docIds).
- **`server/src/index.ts`** — POST /cmsfn/preview/token registered (no db required); `CmsfnServerConfig.previewSecret` added.
- **`server/src/__tests__/preview.test.ts`** — TV-PREVIEW-TOKEN-001 (token + expiresAt ISO), TV-PREVIEW-DISABLED-001 (disabled or no secret → PREVIEW_NOT_CONFIGURED), permission denied when role lacks doc.read.

### Studio

- **`studio/src/panes/preview/PreviewPane.tsx`** — When preview disabled or missing cmsfnApiUrl/docId: shows deterministic disabled UI (data-preview-disabled). When enabled: fetches token from CmsFn, builds URL via resolveUrl(doc) + token query param, renders iframe; refreshTrigger prop and realtime subscription trigger debounced refresh (iframe key increment).
- **`studio/src/realtime/subscribe.ts`** — `subscribeToDoc(config)`: when realtimeUrl set, opens WebSocket, sends subscribe message, on event matching dataset/docId calls onUpdate (debounced); returns unsubscribe. When realtimeUrl absent, no-op unsubscribe.
- **`studio/src/panes/editor/DocumentEditorPane.tsx`** — Optional `previewConfig` and `realtimeUrl`; renders PreviewPane when previewConfig set; increments refresh trigger on successful save.
- **`studio/src/app.tsx`** — Passes config.preview and config.contentfn.realtimeUrl to DocumentEditorPane.
- **`studio/src/__tests__/preview.test.tsx`** — TV-PREVIEW-DISABLED-001 (disabled UI when previewEnabled false or missing config), TV-PREVIEW-LIVE-001 (refreshTrigger change causes iframe to remain with token in src), subscribeToDoc no-op when realtimeUrl absent.

### Core

- **`core/src/desk/types.ts`** — `contentfn.realtimeUrl` optional for WebSocket URL.

## Test status

- **TV-PREVIEW-TOKEN-001**: PASS — POST /cmsfn/preview/token with dataset, docId returns ok, result.token, result.expiresAt (ISO).
- **TV-PREVIEW-DISABLED-001**: PASS — Server returns PREVIEW_NOT_CONFIGURED when disabled or no secret; Studio shows deterministic disabled UI.
- **TV-PREVIEW-LIVE-001**: PASS — Preview pane refreshes when refreshTrigger changes (iframe remount); subscribeToDoc supports realtime when URL configured.

## Verification

- `cmsfn/server`: npm run build && npm run test — 17 tests (status, roles, publish, preview).
- `cmsfn/studio`: npm run build && npm run test — 22 tests (list, studio, workflow, editor, preview).
- `cmsfn/core`: npm run build — success.

## Notes

- Token format: base64url(payload).base64url(hmac-sha256); payload = { dataset, docIds, exp }. Unforgeable with server secret.
- ContentFn realtime is deployment-specific (WebSocket URL); when not configured, live updates rely on refresh-on-save only.
- Preview pane is rendered inside DocumentEditorPane when previewConfig is provided; layout (side-by-side or tab) is minimal (block flow).

## Ready for next phase?

Yes — preview token endpoint, preview pane, and live refresh path are implemented and tested.

# PHASE_07: Preview tokens + live preview updates

## Phase goal

Implement preview token minting on the CmsFn server and a Studio preview pane that updates on draft changes via realtime events.

## In scope

- Server endpoint:
  - `POST /cmsfn/preview/token`
- Token behavior:
  - short-lived, unforgeable, dataset/doc-bound
  - deterministic expiration policy
- Studio preview pane:
  - compute preview URL using config resolver
  - include token for authentication to preview target
  - update preview deterministically when draft changes (message or reload strategy)

## Out of scope

- Complex preview rendering (handled by target site/app)

## Deliverables

- `cmsfn/server/src/http/preview.ts`
- `cmsfn/server/src/preview/tokens.ts`
- `cmsfn/studio/src/panes/preview/PreviewPane.tsx`
- `cmsfn/studio/src/realtime/subscribe.ts`
- Tests implementing:
  - TV-PREVIEW-TOKEN-001
  - TV-PREVIEW-LIVE-001
  - TV-PREVIEW-DISABLED-001

## Requirements covered

- PREVIEW-001
- COLLAB-001 (partial: live updates)

## Implementation tasks

1. Implement preview token endpoint:
   - validate input dataset/docIds
   - enforce permissions (doc.read at minimum)
   - generate token signed with server secret (HMAC/JWT-like) and set expiry
2. Implement preview pane:
   - if preview disabled show deterministic disabled UI
   - otherwise request token and open iframe/window URL
3. Subscribe to ContentFn realtime events for open doc:
   - on draft change, trigger deterministic preview update (reload after debounce)
4. Add tests for token minting and disabled behavior; add UI-level test for live update trigger.

## Verification steps

- Run preview tests.
- Manual smoke: edit draft and see preview refresh.

## Stop condition

- Preview token + preview pane works and updates on draft changes deterministically.


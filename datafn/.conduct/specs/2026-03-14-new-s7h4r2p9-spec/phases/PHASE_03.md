# Phase Goal
Implement record-level sharing, permission inspection, and viewer/editor behavior.

# In Scope / Out Of Scope
- In scope:
  - Share panel for record grants.
  - Permission inspector backed by `getPermissions(id)`.
  - Viewer and editor behavior.
  - Unshare flow.
- Out of scope:
  - Team scope grants.
  - Multi-context sync automation.

# Deliverables
- `datafn/examples/sharing-app/client/src/App.svelte`
- `datafn/examples/sharing-app/client/src/lib/api.ts` (if needed for helper fetches)
- Any supporting component or helper files for share controls.

# Requirements Covered
- UI-003
- SHARE-001
- SHARE-002
- SHARE-003

# Implementation Tasks
- [ ] Add a selected-document share panel.
- [ ] Allow selecting `user:alice`, `user:bob`, `user:charlie` as record-share principals.
- [ ] Call `table.share()` and `table.unshare()` using `principalId`.
- [ ] Fetch and render `table.getPermissions(id)`.
- [ ] Demonstrate viewer denial and editor success in the UI.
- [ ] Preserve canonical error codes in the activity log or status surface.

# Verification Steps
- Manual:
  - Alice shares a document to Bob as viewer.
  - Bob reads it and attempts to edit.
  - Expected: read succeeds, edit fails with `FORBIDDEN`.
- Manual:
  - Alice upgrades Bob to editor.
  - Bob edits content successfully but cannot reshare.
- Manual:
  - Alice unshares Bob.
  - Expected: document disappears from Bob after refresh/pull.

# Stop Condition
Report the observed viewer/editor/revoke behavior and the permission inspector output before moving to Phase 04.

# Phase Goal
Demonstrate pull-based sharing sync across two browser contexts with clear status feedback.

# In Scope / Out Of Scope
- In scope:
  - Activity/status panel updates for reset and sync.
  - Two-context manual verification of grant backfill and revoke tombstone.
  - Explicit pull or sync controls if needed for deterministic testing.
- Out of scope:
  - Final Playwright automation.

# Deliverables
- `datafn/examples/sharing-app/client/src/App.svelte`
- Supporting client helper files for sync status if needed.

# Requirements Covered
- SHARE-003
- SYNC-001

# Implementation Tasks
- [ ] Add a visible sync status surface.
- [ ] Add an explicit “Pull now” or equivalent deterministic sync trigger if current sync cadence is not test-friendly.
- [ ] Verify that a second browser context receives a historical document after grant.
- [ ] Verify that revoke removes the record after pull.
- [ ] Log enough UI-visible status to make the flow understandable in manual testing.

# Verification Steps
- Manual:
  - Open Alice and Bob in separate browser contexts.
  - Alice shares an existing document to Bob.
  - Bob triggers pull.
  - Expected: document appears with success status.
- Manual:
  - Alice revokes Bob.
  - Bob triggers pull.
  - Expected: document is removed with sync-driven status update.

# Stop Condition
Report the two-context grant/revoke sync results before moving to Phase 06.

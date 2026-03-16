# Phase Goal
Implement team scope grants and explicit workspace isolation teaching flows.

# In Scope / Out Of Scope
- In scope:
  - Scope-grant controls for `team:design`.
  - Workspace switcher validation against namespace isolation.
  - Cross-workspace denial handling.
- Out of scope:
  - Automated multi-context sync coverage.

# Deliverables
- `datafn/examples/sharing-app/client/src/App.svelte`
- Any helper modules required for scope-grant UI state.
- Optional server-side helper validation if the example needs explicit cross-workspace principal rejection behavior.

# Requirements Covered
- SHARE-004
- ISO-001

# Implementation Tasks
- [ ] Add a scope-grant panel for `team:design`.
- [ ] Show which actors in the current workspace inherit the team grant.
- [ ] Add UI copy or status messages explaining workspace-scoped sharing.
- [ ] Implement and surface deterministic failure for attempted cross-workspace sharing.
- [ ] Verify switching between `acme` and `globex` keeps records isolated.

# Verification Steps
- Manual:
  - In `acme`, apply a scope grant for `team:design`.
  - Expected: Bob gains access, Charlie does not.
- Manual:
  - Switch Bob from `acme` to `globex`.
  - Expected: `acme` records disappear and only `globex` data remains.
- Manual:
  - Attempt the documented cross-workspace share path.
  - Expected: deterministic error and no data leak.

# Stop Condition
Report the scope-grant behavior and cross-workspace denial result before moving to Phase 05.

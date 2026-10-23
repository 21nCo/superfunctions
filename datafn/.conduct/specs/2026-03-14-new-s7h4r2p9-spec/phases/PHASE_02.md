# Phase Goal
Implement client session switching, context visibility, and document CRUD against the real DataFn server.

# In Scope / Out Of Scope
- In scope:
  - Demo session store.
  - Custom remote adapter with demo headers.
  - `switchContext()` handling.
  - Context panel and visible document list.
  - Create/edit document flows.
- Out of scope:
  - Sharing controls.
  - Playwright automation.

# Deliverables
- `datafn/examples/sharing-app/client/src/lib/demoSession.ts`
- `datafn/examples/sharing-app/client/src/lib/demoRemoteAdapter.ts`
- `datafn/examples/sharing-app/client/src/lib/datafn.ts`
- `datafn/examples/sharing-app/client/src/App.svelte`
- `datafn/examples/sharing-app/client/src/app.css`

# Requirements Covered
- AUTH-003
- UI-001
- UI-002

# Implementation Tasks
- [ ] Create a typed `DemoSession` store with workspace/user selectors.
- [ ] Create a remote adapter that sends `x-demo-workspace-id` and `x-demo-user-id`.
- [ ] Use `client.switchContext()` to rotate local namespace on session changes.
- [ ] Render the context panel with workspace, namespace, actor, and principals.
- [ ] Query visible documents from the real DataFn resource.
- [ ] Implement document create and edit flows with deterministic ordering.
- [ ] Surface canonical error codes in the activity/status panel.

# Verification Steps
- Manual:
  - Start server and client.
  - Switch from `acme/user:alice` to `acme/user:bob`.
  - Expected: context panel and visible docs update immediately.
- Manual:
  - As Alice, create a new document.
  - Expected: it appears in Alice’s list and persists after refresh.

# Stop Condition
Report the session-switch behavior and a screenshot-equivalent summary of the context panel state before moving to Phase 03.

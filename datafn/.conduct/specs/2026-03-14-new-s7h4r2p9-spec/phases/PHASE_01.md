# Phase Goal
Implement the demo server, deterministic baseline data, and identity/context endpoints.

# In Scope / Out Of Scope
- In scope:
  - `documents` schema.
  - Demo identity validation middleware.
  - `/demo/bootstrap`, `/demo/context`, `/demo/reset`.
  - In-memory seed/reset logic.
- Out of scope:
  - Client UI.
  - Playwright automation.

# Deliverables
- `datafn/examples/sharing-app/server/src/index.ts`
- `datafn/examples/sharing-app/server/src/schema.datafn.ts`
- `datafn/examples/sharing-app/server/src/demo/identity.ts`
- `datafn/examples/sharing-app/server/src/demo/bootstrap.ts`
- `datafn/examples/sharing-app/server/src/demo/seed.ts`
- `datafn/examples/sharing-app/server/src/demo/reset.ts`

# Requirements Covered
- DATA-001
- AUTH-001
- AUTH-002
- API-001
- API-002

# Implementation Tasks
- [ ] Define the `documents` schema with shareable private defaults and cross-namespace denial.
- [ ] Implement demo identity allowlist validation for headers.
- [ ] Resolve server namespace as `org:{workspaceId}` and actor as `user:*`.
- [ ] Seed deterministic memberships and baseline documents.
- [ ] Implement `GET /demo/bootstrap`.
- [ ] Implement `GET /demo/context`.
- [ ] Implement `POST /demo/reset`.
- [ ] Add endpoint-level tests or smoke scripts for the demo endpoints.

# Verification Steps
- `curl -s http://localhost:3001/demo/bootstrap | jq`
  - Expected: workspaces, users, and defaults are returned.
- `curl -s -H 'x-demo-workspace-id: acme' -H 'x-demo-user-id: user:alice' http://localhost:3001/demo/context | jq`
  - Expected: namespace `org:acme`, actor `user:alice`, principals `["team:design","user:alice"]`.
- `curl -s -X POST -H 'content-type: application/json' -d '{"scenario":"baseline"}' http://localhost:3001/demo/reset | jq`
  - Expected: deterministic counts for documents and memberships.

# Stop Condition
Report the endpoint contracts and a sample successful `/demo/context` response before moving to Phase 02.

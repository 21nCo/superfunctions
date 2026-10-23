# Phase Goal
Automate the example’s key behaviors with Playwright and finish the teaching documentation.

# In Scope / Out Of Scope
- In scope:
  - Example-level Playwright config.
  - Deterministic E2E specs.
  - Final README walkthrough and command documentation.
- Out of scope:
  - New sharing capability work outside the example.

# Deliverables
- `datafn/examples/sharing-app/playwright.config.ts`
- `datafn/examples/sharing-app/e2e/*.spec.ts`
- `datafn/examples/sharing-app/e2e/helpers/*.ts`
- `datafn/examples/sharing-app/README.md`

# Requirements Covered
- TEST-001
- DOC-001

# Implementation Tasks
- [ ] Add Playwright config that starts server and client or documents required startup commands.
- [ ] Add reset helper usage before tests or test groups.
- [ ] Write tests for record share, viewer denial, editor upgrade, revoke, team scope grant, and workspace isolation.
- [ ] Write a multi-context test for grant backfill and revoke tombstone.
- [ ] Update README with model explanation, run steps, reset instructions, and walkthrough.

# Verification Steps
- `npm --prefix datafn/examples/sharing-app run test:e2e`
  - Expected: Playwright suite passes locally without external services.
- `sed -n '1,220p' datafn/examples/sharing-app/README.md`
  - Expected: README covers model, commands, and walkthrough.

# Stop Condition
Report Playwright results and README coverage summary; only then is the spec fully implemented.

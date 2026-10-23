# Phase Goal
Create the separate sharing example scaffold and package entry points without changing the existing todo example’s responsibility.

# In Scope / Out Of Scope
- In scope:
  - New `datafn/examples/sharing-app` directory.
  - Root README and package/script skeleton.
  - Client/server folder scaffolding.
- Out of scope:
  - Running server logic.
  - Implementing UI or Playwright scenarios.

# Deliverables
- `datafn/examples/sharing-app/README.md`
- `datafn/examples/sharing-app/package.json`
- `datafn/examples/sharing-app/client/package.json`
- `datafn/examples/sharing-app/server/package.json`

# Requirements Covered
- EXAPP-001

# Implementation Tasks
- [ ] Create `datafn/examples/sharing-app/` root with `client`, `server`, and `e2e` directories.
- [ ] Add a root README describing the example at a high level.
- [ ] Add root scripts for starting server/client and running Playwright.
- [ ] Add client and server package manifests with placeholder scripts.
- [ ] Confirm `datafn/examples/todo-app` is not used as the implementation home.

# Verification Steps
- `find datafn/examples/sharing-app -maxdepth 2 -type f | sort`
  - Expected: root README plus client/server package manifests are present.
- `test -d datafn/examples/todo-app`
  - Expected: todo app still exists unchanged as a separate example.

# Stop Condition
Report the created file layout and script names before moving to Phase 01.

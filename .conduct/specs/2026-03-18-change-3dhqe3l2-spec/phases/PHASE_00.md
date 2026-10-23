# Phase goal

Lock down package placement, workspace wiring, and public dependency contracts before shared-package implementation begins.

# In scope / Out of scope

- **In scope**: `clifn` placement decision, workspace updates, provider contract inventory, no-duplication guardrails.
- **Out of scope**: provider implementation code and package tests.

# Deliverables

- `/Users/serro/Documents/dev/n/superfunctions/package.json`
- `/Users/serro/Documents/dev/n/superfunctions/turbo.json`
- `/Users/serro/Documents/dev/n/superfunctions/clifn/` or `/Users/serro/Documents/dev/n/superfunctions/clifn/core/` package scaffold
- contract note in the relevant package README or `.conduct` status doc for maintainers

# Requirements covered

- WORKSPACE-001
- PLUG-001

# Implementation tasks

- [ ] Confirm the final package path for `clifn` using repo conventions.
- [ ] Update root workspaces to include the new package path.
- [ ] Record the public PlugFn action/trigger contract additions required by Conduct.
- [ ] Verify no duplicate HTTP/client/credential helpers are planned outside `clifn`.

# Verification steps

1. Run `npm install` from `/Users/serro/Documents/dev/n/superfunctions`.
   Expected: the new workspace path resolves cleanly.
2. Run `npm run build -- --filter=clifn...` once the scaffold exists.
   Expected: the workspace is recognized.

# Stop condition

Report the final `clifn` package path and updated workspace patterns before Phase 01 starts.

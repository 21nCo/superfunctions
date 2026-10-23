# Phase Goal
Finish snippet provenance, broken-link cleanup, and final site verification so the rewritten docs are shippable and locally enforceable.

# In Scope / Out Of Scope
- In scope:
  - Final `docs:audit` rule expansion.
  - Snippet provenance completion.
  - Internal-link cleanup after all page moves.
  - Final build and manual route verification.
- Out of scope:
  - Additional scope expansion beyond the rewritten docs tree.

# Deliverables
- `datafn/docs/scripts/audit-docs.mjs`
- any helper script(s) added for snippet/link verification
- all touched public docs files after final link cleanup

# Requirements Covered
- EXAMPLE-001
- QA-001
- QA-002

# Implementation Tasks
- [ ] Expand `docs:audit` to cover snippet provenance, related-guide backlinks, and broken-link checks required by the final docs tree.
- [ ] Update any lingering internal links to new sharing or glossary paths.
- [ ] Verify banned legacy content is absent across the public docs tree.
- [ ] Run final `next build` for the docs site.
- [ ] Manually verify the highest-traffic routes: root, getting-started, client setup, server setup, sync overview, sharing overview, DFQL, reference, and CLI.

# Verification Steps
- `npm --prefix datafn/docs run docs:audit`
  - Expected: zero error findings.
- `npm --prefix datafn/docs run build`
  - Expected: build succeeds.
- Manual:
  - Run `npm --prefix datafn/docs run dev`.
  - Open `/docs`, `/docs/documentation`, `/docs/documentation/client/setup`, `/docs/documentation/server/setup`, `/docs/documentation/sync/overview`, `/docs/documentation/sharing/overview`, `/docs/dfql`, `/docs/reference`, and `/docs/cli`.
  - Expected: all routes render, navigation is correct, and the rewritten paths are internally consistent.

# Stop Condition
Report the final `docs:audit` result, the build result, and any manual-route issues; only then is the docs rewrite complete.

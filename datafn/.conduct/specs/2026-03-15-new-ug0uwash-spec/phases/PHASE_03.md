# Phase Goal
Rewrite the server guide cluster to be setup-first, runtime-truthful, and explicit about TypeScript/Python applicability.

# In Scope / Out Of Scope
- In scope:
  - All `documentation/server/*.mdx` pages.
  - Runtime applicability notes.
  - Setup/reference separation for server configuration.
- Out of scope:
  - Reference/server pages.
  - Sync and sharing guide consolidation.

# Deliverables
- `datafn/docs/content/docs/documentation/server/setup.mdx`
- `datafn/docs/content/docs/documentation/server/routes.mdx`
- `datafn/docs/content/docs/documentation/server/authorization.mdx`
- `datafn/docs/content/docs/documentation/server/validation.mdx`
- `datafn/docs/content/docs/documentation/server/rest-api.mdx`
- `datafn/docs/content/docs/documentation/server/websockets.mdx`
- `datafn/docs/content/docs/documentation/server/rate-limiting.mdx`
- `datafn/docs/content/docs/documentation/server/observability.mdx`

# Requirements Covered
- GUIDE-001
- SETUP-001
- RUNTIME-001
- EXAMPLE-001

# Implementation Tasks
- [ ] Rewrite `server/setup.mdx` to lead with the shortest working server path and defer full config detail to `reference/server/config.mdx`.
- [ ] Add near-top applicability notes to pages with TypeScript/Python differences.
- [ ] Rewrite `routes.mdx` so unsupported runtime combinations are explicit and easy to spot.
- [ ] Rewrite auth/validation/rest/websocket/rate-limit/observability pages as decision-first guides rather than internals-first docs.
- [ ] Cross-link server guides to the relevant reference pages and concept pages.
- [ ] Ensure server guide snippets map to real maintained sources or examples.

# Verification Steps
- `npm --prefix datafn/docs run docs:audit`
  - Expected: runtime-scope and guide-template checks pass for the server cluster.
- Manual:
  - Open `/docs/documentation/server/setup` and `/docs/documentation/server/routes`.
  - Expected: the page lead clearly states runtime applicability and shortest working path.
- Manual:
  - Inspect `server/routes.mdx`.
  - Expected: TypeScript-only and unimplemented Python routes are stated near the top, not buried.

# Stop Condition
Report the runtime applicability language now used for server pages and the reference pages each guide points to before starting Phase 04.

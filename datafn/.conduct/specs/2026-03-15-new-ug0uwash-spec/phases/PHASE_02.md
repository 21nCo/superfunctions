# Phase Goal
Rewrite the client guide cluster so first-time implementers can set up, query, mutate, and react to data without wading through reference-heavy exposition.

# In Scope / Out Of Scope
- In scope:
  - All `documentation/client/*.mdx` pages.
  - Setup/reference separation for client configuration.
  - Example-driven client teaching flow.
- Out of scope:
  - Server guides.
  - Reference/client pages.

# Deliverables
- `datafn/docs/content/docs/documentation/client/setup.mdx`
- `datafn/docs/content/docs/documentation/client/queries.mdx`
- `datafn/docs/content/docs/documentation/client/mutations.mdx`
- `datafn/docs/content/docs/documentation/client/transactions.mdx`
- `datafn/docs/content/docs/documentation/client/signals.mdx`
- `datafn/docs/content/docs/documentation/client/frameworks.mdx`
- `datafn/docs/content/docs/documentation/client/events.mdx`
- `datafn/docs/content/docs/documentation/client/kv.mdx`
- `datafn/docs/content/docs/documentation/client/tables.mdx`

# Requirements Covered
- GUIDE-001
- SETUP-001
- START-001
- EXAMPLE-001

# Implementation Tasks
- [ ] Rewrite `client/setup.mdx` to lead with a shortest working client setup and defer exhaustive options to reference.
- [ ] Rewrite query/mutation/transaction pages around concrete tasks, not only API surface.
- [ ] Rewrite signals/events/tables/KV pages so they teach the reader when to reach for each surface.
- [ ] Keep framework-support language truthful; avoid implying non-existent adapters are equally available today.
- [ ] Link relevant client guides to `reference/client/*` pages where exhaustive detail exists.
- [ ] Ensure examples point to or align with real example-app code.

# Verification Steps
- `npm --prefix datafn/docs run docs:audit`
  - Expected: guide-template and snippet-provenance checks pass for the client cluster.
- Manual:
  - Open `/docs/documentation/client/setup`.
  - Expected: the first code path is runnable before any exhaustive config table appears.
- Manual:
  - Open `/docs/documentation/client/queries` and `/docs/documentation/client/mutations`.
  - Expected: both pages read like task guides rather than raw API inventories.

# Stop Condition
Report which client pages now link to reference pages and which example sources back the rewritten snippets before starting Phase 03.

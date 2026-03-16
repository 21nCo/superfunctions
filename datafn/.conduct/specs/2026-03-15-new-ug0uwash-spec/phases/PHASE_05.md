# Phase Goal
Rewrite storage, plugins, database, and advanced guide clusters so they teach reader decisions and tasks before internal contracts and implementation detail.

# In Scope / Out Of Scope
- In scope:
  - `documentation/storage/*.mdx`
  - `documentation/plugins/*.mdx`
  - `documentation/database/*.mdx`
  - `documentation/advanced/*.mdx`
- Out of scope:
  - DFQL/CLI/reference sections.
  - Final audit/build pass.

# Deliverables
- `datafn/docs/content/docs/documentation/storage/overview.mdx`
- `datafn/docs/content/docs/documentation/storage/indexeddb.mdx`
- `datafn/docs/content/docs/documentation/storage/memory.mdx`
- `datafn/docs/content/docs/documentation/storage/custom.mdx`
- `datafn/docs/content/docs/documentation/plugins/overview.mdx`
- `datafn/docs/content/docs/documentation/plugins/client-search.mdx`
- `datafn/docs/content/docs/documentation/plugins/custom-plugins.mdx`
- `datafn/docs/content/docs/documentation/database/adapters.mdx`
- `datafn/docs/content/docs/documentation/database/drizzle.mdx`
- `datafn/docs/content/docs/documentation/database/transactions.mdx`
- `datafn/docs/content/docs/documentation/advanced/idempotency.mdx`
- `datafn/docs/content/docs/documentation/advanced/change-tracking.mdx`
- `datafn/docs/content/docs/documentation/advanced/guards.mdx`
- `datafn/docs/content/docs/documentation/advanced/debouncing.mdx`
- `datafn/docs/content/docs/documentation/advanced/error-handling.mdx`
- `datafn/docs/content/docs/documentation/advanced/security.mdx`

# Requirements Covered
- GUIDE-001
- ADV-001
- SEARCH-001
- RUNTIME-001

# Implementation Tasks
- [ ] Rewrite storage pages to help readers choose the right adapter and understand when each is needed.
- [ ] Rewrite plugin pages to lead with “why and when” rather than hook internals.
- [ ] Rewrite `database/adapters.mdx` to be decision-first and push raw interfaces to reference or late sections.
- [ ] Rewrite advanced pages so they frame user value before internal classes or tables.
- [ ] Remove remaining public legacy search language from plugin-facing search docs.
- [ ] Add applicability notes where runtime/package support differs.

# Verification Steps
- `npm --prefix datafn/docs run docs:audit`
  - Expected: no guide/reference-mix findings in the rewritten clusters.
- Manual:
  - Open `/docs/documentation/database/adapters` and `/docs/documentation/plugins/overview`.
  - Expected: both lead with reader decisions and use cases.
- Manual:
  - Open `/docs/documentation/advanced/change-tracking`.
  - Expected: the page explains value and context before internal tables/services.

# Stop Condition
Report which internals were moved later or linked outward in these clusters before starting Phase 06.

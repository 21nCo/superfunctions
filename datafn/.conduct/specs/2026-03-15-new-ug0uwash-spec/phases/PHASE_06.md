# Phase Goal
Rewrite the DFQL section so it remains comprehensive while clearly positioned as the underlying language/reference layer rather than the first mandatory stop for beginners.

# In Scope / Out Of Scope
- In scope:
  - `dfql/meta.json`
  - `dfql/*.mdx`
  - `dfql/schema/meta.json`
  - `dfql/schema/*.mdx`
- Out of scope:
  - CLI and reference sections.
  - Final full-site QA.

# Deliverables
- `datafn/docs/content/docs/dfql/meta.json`
- `datafn/docs/content/docs/dfql/index.mdx`
- `datafn/docs/content/docs/dfql/queries.mdx`
- `datafn/docs/content/docs/dfql/mutations.mdx`
- `datafn/docs/content/docs/dfql/transactions.mdx`
- `datafn/docs/content/docs/dfql/search.mdx`
- `datafn/docs/content/docs/dfql/filters.mdx`
- `datafn/docs/content/docs/dfql/sorting.mdx`
- `datafn/docs/content/docs/dfql/pagination.mdx`
- `datafn/docs/content/docs/dfql/select.mdx`
- `datafn/docs/content/docs/dfql/aggregations.mdx`
- `datafn/docs/content/docs/dfql/schema/meta.json`
- `datafn/docs/content/docs/dfql/schema/index.mdx`
- `datafn/docs/content/docs/dfql/schema/resources.mdx`
- `datafn/docs/content/docs/dfql/schema/fields.mdx`
- `datafn/docs/content/docs/dfql/schema/relations.mdx`
- `datafn/docs/content/docs/dfql/schema/system-fields.mdx`

# Requirements Covered
- DFQL-001
- LEG-001
- SEARCH-001
- REF-001

# Implementation Tasks
- [ ] Rewrite `dfql/index.mdx` to explain when readers should use DFQL directly vs typed APIs.
- [ ] Rework operation pages to keep canonical envelopes, minimal examples, and guide backlinks.
- [ ] Remove public deprecated-sharing payload guidance from DFQL mutation/search pages.
- [ ] Ensure schema pages remain comprehensive but readable, with clear mental framing at the top.
- [ ] Cross-link DFQL pages back to the relevant guide pages for onboarding continuity.

# Verification Steps
- `npm --prefix datafn/docs run docs:audit`
  - Expected: DFQL pages pass frontmatter, related-link, and legacy-content checks.
- Manual:
  - Open `/docs/dfql` and `/docs/dfql/mutations`.
  - Expected: readers can tell what DFQL is for and still find canonical envelope examples quickly.
- Manual:
  - Search `dfql/*.mdx` for `shareWith.userId`.
  - Expected: no matches.

# Stop Condition
Report the final DFQL positioning language and confirm that deprecated public DFQL examples are gone before starting Phase 07.

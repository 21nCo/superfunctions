# Phase Goal
Consolidate and rewrite generic sync plus the dedicated sharing cluster, and remove public migration content from the docs site.

# In Scope / Out Of Scope
- In scope:
  - Generic sync guide pages and sync navigation cleanup.
  - Dedicated sharing subtree creation and moved page rewrites.
  - Removal of public migration pages.
  - Sharing cross-links to capabilities, namespaces, and sync.
- Out of scope:
  - Storage/plugins/database/advanced clusters.
  - Reference rewrites.

# Deliverables
- `datafn/docs/content/docs/documentation/sync/meta.json`
- `datafn/docs/content/docs/documentation/sync/overview.mdx`
- `datafn/docs/content/docs/documentation/sync/offline-first.mdx`
- `datafn/docs/content/docs/documentation/sync/clone.mdx`
- `datafn/docs/content/docs/documentation/sync/pull-push.mdx`
- `datafn/docs/content/docs/documentation/sync/hydration.mdx`
- `datafn/docs/content/docs/documentation/sync/clone-up.mdx`
- `datafn/docs/content/docs/documentation/sync/cross-tab.mdx`
- `datafn/docs/content/docs/documentation/sharing/meta.json`
- `datafn/docs/content/docs/documentation/sharing/overview.mdx`
- `datafn/docs/content/docs/documentation/sharing/patterns.mdx`
- `datafn/docs/content/docs/documentation/sharing/sync-lifecycle.mdx`

# Requirements Covered
- IA-003
- LEG-001
- SHARE-001
- SYNC-001
- TERM-001

# Implementation Tasks
- [ ] Remove sharing-specific lifecycle content from the generic sync nav and keep sync focused on clone/pull/push/hydration/cross-tab.
- [ ] Create the public `documentation/sharing` subtree and wire it into Guides navigation.
- [ ] Move/rewrite sharing overview, patterns, and sync-lifecycle content into the new sharing subtree.
- [ ] Delete or otherwise remove public `documentation/migrations/*` from the docs site.
- [ ] Remove all public sharing migration/deprecation/compatibility copy.
- [ ] Rewrite sharing pages so examples and plain language appear before internal tables or indexes.
- [ ] Update all internal links pointing at old sharing paths to the new public sharing routes.

# Verification Steps
- `npm --prefix datafn/docs run docs:audit`
  - Expected: no `DOCS_LEGACY_PUBLIC` findings and sharing/sync navigation checks pass.
- Manual:
  - Open `/docs/documentation/sync`.
  - Expected: generic sync pages no longer include a sharing-specific lifecycle entry.
- Manual:
  - Open `/docs/documentation/sharing/overview`, `/docs/documentation/sharing/patterns`, and `/docs/documentation/sharing/sync-lifecycle`.
  - Expected: all three render and cross-link correctly.
- Manual:
  - Search the public docs tree for `shareWith.userId`, `dual-read`, and `legacy MiniSearch`.
  - Expected: no matches.

# Stop Condition
Report the final public sharing routes and confirm that no public migration/compatibility content remains before starting Phase 05.

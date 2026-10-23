# Phase Goal
Establish the target public navigation tree, frontmatter contract, and local docs-audit foundation before rewriting page content at scale.

# In Scope / Out Of Scope
- In scope:
  - Public `meta.json` reordering and retitling.
  - New `documentation/sharing/meta.json`.
  - Docs-audit script scaffolding and package script wiring.
  - Canonical frontmatter enforcement.
- Out of scope:
  - Full prose rewrites for root, concept, or guide pages.
  - Final route polish.

# Deliverables
- `datafn/docs/content/docs/meta.json`
- `datafn/docs/content/docs/documentation/meta.json`
- `datafn/docs/content/docs/documentation/concepts/meta.json`
- `datafn/docs/content/docs/documentation/sync/meta.json`
- `datafn/docs/content/docs/documentation/sharing/meta.json`
- `datafn/docs/package.json`
- `datafn/docs/scripts/audit-docs.mjs`

# Requirements Covered
- IA-002
- IA-003
- META-001
- QA-001

# Implementation Tasks
- [ ] Retitle `documentation` to `Guides` in public navigation.
- [ ] Reorder Guides sections to the target newcomer-first order.
- [ ] Add the new `documentation/sharing` subtree to public navigation.
- [ ] Remove public `migrations` and `use-cases` groups from sidebar metadata.
- [ ] Add or update the canonical frontmatter fields on any page touched in this phase.
- [ ] Add `docs:audit` to `datafn/docs/package.json`.
- [ ] Implement `datafn/docs/scripts/audit-docs.mjs` with checks for nav shape, frontmatter presence, and banned legacy content.
- [ ] Ensure audit output uses the stable JSON envelope and error codes from the spec.

# Verification Steps
- `npm --prefix datafn/docs run docs:audit`
  - Expected: nav and frontmatter checks run locally and return documented JSON output.
- Manual:
  - Start the docs site with `npm --prefix datafn/docs run dev`.
  - Open `/docs`.
  - Expected: the sidebar reflects `Guides`, `DFQL`, `Reference`, `CLI`, and no `migrations` group appears.

# Stop Condition
Report the final public sidebar group order and a sample successful `docs:audit` JSON envelope before starting Phase 01.

# Phase Goal
Rewrite the root landing, getting-started page, and concepts cluster into a coherent newcomer path with a shared glossary and plain-language mental models.

# In Scope / Out Of Scope
- In scope:
  - Root `/docs` landing content.
  - `documentation/index.mdx`.
  - Concepts overview, glossary, capabilities, and namespaces.
- Out of scope:
  - Client/server task guides.
  - Sharing cluster consolidation.

# Deliverables
- `datafn/docs/content/docs/index.mdx`
- `datafn/docs/content/docs/documentation/index.mdx`
- `datafn/docs/content/docs/documentation/concepts/overview.mdx`
- `datafn/docs/content/docs/documentation/concepts/glossary.mdx`
- `datafn/docs/content/docs/documentation/concepts/capabilities.mdx`
- `datafn/docs/content/docs/documentation/concepts/multi-tenancy.mdx`

# Requirements Covered
- IA-001
- TERM-001
- CONCEPT-001
- START-001

# Implementation Tasks
- [ ] Rewrite `index.mdx` into a real homepage with product summary, reader paths, and example links.
- [ ] Rewrite `documentation/index.mdx` into a typed quickstart that covers schema, server, client, and one end-to-end flow.
- [ ] Add the new glossary page and wire it into concepts navigation.
- [ ] Rewrite concepts pages to lead with plain language, examples, and rules of thumb.
- [ ] Move internal mechanics in concept pages behind late-page `Under the hood` sections where still necessary.
- [ ] Ensure all concept pages include the canonical frontmatter envelope.

# Verification Steps
- `npm --prefix datafn/docs run docs:audit`
  - Expected: frontmatter and concept-template checks pass for the rewritten pages.
- Manual:
  - Open `/docs`, `/docs/documentation`, and `/docs/documentation/concepts/overview`.
  - Expected: a newcomer can identify what DataFn is, where to start, and which concepts to read next.
- Manual:
  - Open `/docs/documentation/concepts/glossary`.
  - Expected: namespace, actor, principal, guide, and reference are defined in reader-facing language.

# Stop Condition
Report the new root/start-here flow and the glossary terms that now anchor the rest of the docs before starting Phase 02.

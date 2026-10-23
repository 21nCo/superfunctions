# Architecture Sketch
- `datafn/docs/content/docs/meta.json`
  - Top-level section order and public entry points.
- `datafn/docs/content/docs/documentation/**/meta.json`
  - Guides-side information architecture and subsection ordering.
- `datafn/docs/content/docs/**/*.mdx`
  - Public content pages, rewritten by audience type: landing, guide, concept, reference.
- `datafn/docs/package.json`
  - Local docs quality commands such as `docs:audit`.
- `datafn/docs/scripts/*`
  - Deterministic docs audit and optional snippet/link verification helpers.
- `datafn/docs/app/docs/layout.tsx` and `datafn/docs/lib/source.ts`
  - Existing docs app plumbing that consumes the content tree; expected to remain structurally intact.

# Dependency Graph
1. Define the target navigation tree and docs rules before mass content edits.
2. Add docs-audit scaffolding early so later phases can verify frontmatter, nav, and banned public legacy content.
3. Rewrite root/start-here and concepts before downstream task guides, so later pages can link to stable glossary/concept targets.
4. Rewrite client and server setup before sync/sharing because those pages are the primary prerequisites for the rest of the guides.
5. Consolidate sharing after the new Guides structure exists, since sharing moves depend on new navigation targets.
6. Rewrite supporting clusters (storage/plugins/database/advanced) after the core learning path is stable.
7. Rewrite DFQL, CLI, and reference after guide/reference boundaries are settled.
8. Run final audit/build/manual route verification only after all content moves and link rewrites are complete.

# Phases Overview
- Phase 00 -> Goal: establish the public information architecture and docs-audit foundation. Delivered capability: stable target sidebar, frontmatter rules, and local docs audit command scaffold. Verification: `docs:audit` nav/frontmatter checks and manual `/docs` sidebar inspection.
- Phase 01 -> Goal: turn the root landing, getting-started, and concepts cluster into a clear newcomer path. Delivered capability: usable homepage, glossary, and plain-language core concepts. Verification: rendered `/docs`, `/docs/documentation`, and `/docs/documentation/concepts/*`.
- Phase 02 -> Goal: rewrite client guides to be task-first and reference-linked. Delivered capability: cleaner client onboarding and day-one implementation flow. Verification: route inspection plus audit/template checks.
- Phase 03 -> Goal: rewrite server guides with runtime truthfulness and setup/reference separation. Delivered capability: accurate server onboarding for TypeScript/Python readers. Verification: route inspection plus audit/runtime checks.
- Phase 04 -> Goal: consolidate and rewrite sync and sharing into coherent public learning paths. Delivered capability: dedicated sharing section, generic sync section, and removal of public migration pages. Verification: moved routes render, old banned content absent.
- Phase 05 -> Goal: rewrite storage, plugins, database, and advanced guides from decision-first/task-first angles. Delivered capability: support clusters that teach usage before internals. Verification: guide-template audit and manual lead-section review.
- Phase 06 -> Goal: rewrite DFQL as a complete but clearly positioned language/reference section. Delivered capability: stronger wire-format docs without forcing beginners into DFQL first. Verification: DFQL routes and canonical example checks.
- Phase 07 -> Goal: rewrite CLI and API reference orientation while preserving exhaustive detail. Delivered capability: reference pages with summaries/examples/guide backlinks and task-first CLI docs. Verification: reference/CLI route inspection and related-link audit.
- Phase 08 -> Goal: finish snippet provenance, broken-link cleanup, and final site verification. Delivered capability: release-ready docs tree with deterministic local quality gates. Verification: `docs:audit`, `next build`, and spot-checked public routes.

# Definition Of Done
No phase is complete unless its verification steps pass.

# Recommended File Map By Workstream
- Navigation + metadata:
  - `datafn/docs/content/docs/meta.json`
  - `datafn/docs/content/docs/documentation/meta.json`
  - `datafn/docs/content/docs/documentation/concepts/meta.json`
  - `datafn/docs/content/docs/documentation/sync/meta.json`
  - `datafn/docs/content/docs/documentation/sharing/meta.json`
- Root/start-here:
  - `datafn/docs/content/docs/index.mdx`
  - `datafn/docs/content/docs/documentation/index.mdx`
- Concepts:
  - `datafn/docs/content/docs/documentation/concepts/overview.mdx`
  - `datafn/docs/content/docs/documentation/concepts/glossary.mdx`
  - `datafn/docs/content/docs/documentation/concepts/capabilities.mdx`
  - `datafn/docs/content/docs/documentation/concepts/multi-tenancy.mdx`
- Client guides:
  - `datafn/docs/content/docs/documentation/client/*.mdx`
- Server guides:
  - `datafn/docs/content/docs/documentation/server/*.mdx`
- Sync + sharing:
  - `datafn/docs/content/docs/documentation/sync/*.mdx`
  - `datafn/docs/content/docs/documentation/sharing/*.mdx`
  - delete/remove public `datafn/docs/content/docs/documentation/migrations/*`
  - remove old sharing locations from public docs tree
- Storage/plugins/database/advanced:
  - `datafn/docs/content/docs/documentation/storage/*.mdx`
  - `datafn/docs/content/docs/documentation/plugins/*.mdx`
  - `datafn/docs/content/docs/documentation/database/*.mdx`
  - `datafn/docs/content/docs/documentation/advanced/*.mdx`
- DFQL:
  - `datafn/docs/content/docs/dfql/*.mdx`
  - `datafn/docs/content/docs/dfql/meta.json`
  - `datafn/docs/content/docs/dfql/schema/*.mdx`
  - `datafn/docs/content/docs/dfql/schema/meta.json`
- CLI:
  - `datafn/docs/content/docs/cli/*.mdx`
  - `datafn/docs/content/docs/cli/meta.json`
- Reference:
  - `datafn/docs/content/docs/reference/index.mdx`
  - `datafn/docs/content/docs/reference/meta.json`
  - `datafn/docs/content/docs/reference/client/*.mdx`
  - `datafn/docs/content/docs/reference/core/*.mdx`
  - `datafn/docs/content/docs/reference/server/*.mdx`
- Quality gates:
  - `datafn/docs/package.json`
  - `datafn/docs/scripts/audit-docs.mjs`
  - any helper script(s) for snippet provenance or broken-link verification

# Execution Notes
- The rewrite SHOULD preserve the current docs app infrastructure and use content/meta changes as the main lever.
- Because the library is unpublished, URL cleanups and public file moves are acceptable if all internal links are updated in the same phase.
- The docs audit SHOULD be introduced early and expanded as phases add new guarantees.

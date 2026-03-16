# Phase Goal
Rewrite CLI and API reference orientation so readers can reliably look things up without losing context or being dropped into raw types without explanation.

# In Scope / Out Of Scope
- In scope:
  - `cli/*.mdx` and `cli/meta.json`
  - `reference/index.mdx` and `reference/meta.json`
  - `reference/client/*.mdx`
  - `reference/core/*.mdx`
  - `reference/server/*.mdx`
- Out of scope:
  - Final end-to-end QA/build cleanup.

# Deliverables
- `datafn/docs/content/docs/cli/meta.json`
- `datafn/docs/content/docs/cli/index.mdx`
- `datafn/docs/content/docs/cli/generate.mdx`
- `datafn/docs/content/docs/cli/validate.mdx`
- `datafn/docs/content/docs/cli/type-codegen.mdx`
- `datafn/docs/content/docs/cli/drizzle-codegen.mdx`
- `datafn/docs/content/docs/reference/index.mdx`
- `datafn/docs/content/docs/reference/meta.json`
- `datafn/docs/content/docs/reference/client/*.mdx`
- `datafn/docs/content/docs/reference/core/*.mdx`
- `datafn/docs/content/docs/reference/server/*.mdx`

# Requirements Covered
- CLI-001
- REF-001
- RUNTIME-001
- EXAMPLE-001

# Implementation Tasks
- [ ] Rewrite CLI landing and command pages so each page states task intent, usage, and expected output.
- [ ] Rewrite reference landing pages to explain what belongs in reference and where beginners should go instead.
- [ ] Add plain-language summaries, minimal examples, and guide backlinks to each reference page.
- [ ] Add applicability notes to reference pages where runtime/package support differs.
- [ ] Ensure any public reference examples still map to maintained sources.

# Verification Steps
- `npm --prefix datafn/docs run docs:audit`
  - Expected: related-guide, runtime-scope, and snippet-provenance checks pass for CLI/reference pages.
- Manual:
  - Open `/docs/reference`, `/docs/reference/client/config`, and `/docs/cli`.
  - Expected: each page explains what it is for before diving into exhaustive detail.
- Manual:
  - Spot-check at least one client, core, and server reference page.
  - Expected: each has a plain-language summary, an example, and a guide backlink.

# Stop Condition
Report the final reference-page orientation pattern and CLI task framing before starting Phase 08.

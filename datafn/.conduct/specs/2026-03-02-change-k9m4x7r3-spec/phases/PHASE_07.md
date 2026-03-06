# PHASE_07: Restructure Sidebar — Move Schema Sub-Topics Under DFQL + Create Concepts Overview

## Phase Goal

Move resources, fields, relations, and system-fields pages from the Concepts section to the DFQL section. Create a schema page under DFQL. Replace the Concepts schema page with a high-level overview page that introduces all core DataFn concepts.

## In Scope

- RST-001: Move resources, fields, relations, system-fields from concepts to DFQL sidebar
- RST-002: Create concepts overview page replacing schema page
- RST-003: Add DFQL schema page under dfql/ section

## Out of Scope

- Cross-linking DFQL from main docs (Phase 8)
- System architecture diagram (Phase 8)
- Python SDK merge (Phase 9)
- Modifying content of existing DFQL pages (queries, filters, etc.)

## Deliverables

| File | Action |
|---|---|
| `datafn/docs/content/docs/dfql/schema.mdx` | CREATE — move/adapt from `concepts/schema.mdx` |
| `datafn/docs/content/docs/dfql/resources.mdx` | CREATE — move from `concepts/resources.mdx` |
| `datafn/docs/content/docs/dfql/fields.mdx` | CREATE — move from `concepts/fields.mdx` |
| `datafn/docs/content/docs/dfql/system-fields.mdx` | CREATE — move from `concepts/system-fields.mdx` |
| `datafn/docs/content/docs/dfql/meta.json` | UPDATE — add schema, resources, fields, relations, system-fields to pages array |
| `datafn/docs/content/docs/documentation/concepts/overview.mdx` | CREATE — high-level concepts overview page |
| `datafn/docs/content/docs/documentation/concepts/meta.json` | UPDATE — replace schema/resources/fields/relations/system-fields with overview |
| `datafn/docs/content/docs/documentation/concepts/schema.mdx` | DELETE or REDIRECT — content moved to dfql/schema.mdx |
| `datafn/docs/content/docs/documentation/concepts/resources.mdx` | DELETE — moved to dfql/ |
| `datafn/docs/content/docs/documentation/concepts/fields.mdx` | DELETE — moved to dfql/ |
| `datafn/docs/content/docs/documentation/concepts/system-fields.mdx` | DELETE — moved to dfql/ |

## Requirements Covered

RST-001, RST-002, RST-003

## Implementation Tasks

### RST-001: Move schema sub-topic files to DFQL

1. [ ] Copy `documentation/concepts/resources.mdx` → `dfql/resources.mdx`
2. [ ] Copy `documentation/concepts/fields.mdx` → `dfql/fields.mdx`
3. [ ] Copy `documentation/concepts/system-fields.mdx` → `dfql/system-fields.mdx`
4. [ ] Note: `dfql/relations.mdx` already exists — check if `concepts/relations.mdx` has different content
   - If `concepts/relations.mdx` focuses on schema definition and `dfql/relations.mdx` on querying, merge the schema-definition content into a "Defining Relations" section at the top of `dfql/relations.mdx`
   - If content is largely duplicated, keep `dfql/relations.mdx` and discard the concepts version
5. [ ] Update frontmatter of moved files if needed (descriptions should reference DFQL context)
6. [ ] Delete the original files from `documentation/concepts/` after confirming the copies are correct

### RST-003: Create DFQL schema page

7. [ ] Copy `documentation/concepts/schema.mdx` → `dfql/schema.mdx`
8. [ ] Update frontmatter title/description to fit DFQL context (e.g., title: "Schema Definition", description: "Define your data model for DFQL operations.")
9. [ ] Ensure content covers `DatafnSchema`, `defineSchema()`, `DatafnResourceSchema`, `DatafnRelationSchema`, `namespaced`
10. [ ] Remove `documentation/concepts/schema.mdx`

### Update meta.json files

11. [ ] Update `dfql/meta.json` to:
    ```json
    {
      "title": "DFQL",
      "description": "DataFn Query Language",
      "root": true,
      "pages": [
        "index",
        "schema",
        "resources",
        "fields",
        "relations",
        "system-fields",
        "queries",
        "filters",
        "sorting",
        "pagination",
        "select",
        "aggregations",
        "search",
        "mutations",
        "transactions"
      ]
    }
    ```
12. [ ] Update `documentation/concepts/meta.json` to:
    ```json
    {
      "title": "Concepts",
      "pages": ["overview", "multi-tenancy"]
    }
    ```

### RST-002: Create concepts overview page

13. [ ] Create `documentation/concepts/overview.mdx` with:
    - Frontmatter: title "Overview", description "A high-level introduction to the DataFn ecosystem."
    - **What is DataFn** — 2-3 sentence introduction
    - **DFQL** — brief description + link to `/docs/dfql`
      - Schema, Resources, Fields, Queries, Mutations, Transactions
    - **Client** — brief description + link to `/docs/documentation/client/setup`
      - Signals, Offline-first, Storage
    - **Server** — brief description + link to `/docs/documentation/server/setup`
      - Routes, Authorization, Sync Engine
    - **Framework Libraries** — brief description + link to framework adapters doc
      - `@datafn/svelte` (available), React/Vue/Solid/Angular (planned)
    - **Sync** — brief description + link to `/docs/documentation/sync/overview`
      - Clone, Pull, Push, Offline-first
    - Placeholder for system architecture diagram (to be added in Phase 8)

### Fix internal links

14. [ ] Search all doc files for links to the old paths (`/docs/documentation/concepts/schema`, `/docs/documentation/concepts/resources`, etc.) and update them to the new DFQL paths (`/docs/dfql/schema`, `/docs/dfql/resources`, etc.)
15. [ ] Check `reference/core/schema.mdx` for any links that need updating

## Verification Steps

1. Doc site builds successfully:
   ```bash
   cd datafn/docs && npm run build
   ```
2. Sidebar shows:
   - DFQL section includes: Schema, Resources, Fields, Relations, System Fields, Queries, Filters, Sorting, Pagination, Select, Aggregations, Search, Mutations, Transactions
   - Concepts section includes: Overview, Namespace / Multi-Tenancy
3. No broken links:
   ```bash
   grep -r "documentation/concepts/schema\|documentation/concepts/resources\|documentation/concepts/fields\|documentation/concepts/system-fields" datafn/docs/content/
   ```
   (should return no results in non-.conduct paths)

## Stop Condition

- All schema sub-topic pages are under DFQL section in sidebar.
- Concepts section has overview + multi-tenancy only.
- Overview page created with high-level intro to all concepts.
- No broken internal links.
- Doc site builds.

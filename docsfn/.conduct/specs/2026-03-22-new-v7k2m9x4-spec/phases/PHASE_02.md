# PHASE 02: Core Content — Getting Started, Configuration, Content Format

## Phase Goal

Write the foundational documentation content: Getting Started guide, Configuration reference, and Content Format guide.

## In Scope

- content/docs/getting-started/ section (index, installation, quick-start, project-structure)
- content/docs/core-concepts/configuration.md
- content/docs/core-concepts/content-format.md
- Updated meta.json files for navigation

## Out of Scope

- Other core concept pages (Phase 3, 4)
- API reference (Phase 6, 7)
- Guides (Phase 5)

## Deliverables

| File | Description |
|---|---|
| `content/docs/getting-started/index.md` | Getting Started overview |
| `content/docs/getting-started/installation.md` | Package installation for SvelteKit and Next.js |
| `content/docs/getting-started/quick-start.md` | Minimal working example |
| `content/docs/getting-started/project-structure.md` | Directory structure explanation |
| `content/docs/getting-started/meta.json` | Navigation: index, installation, quick-start, project-structure |
| `content/docs/core-concepts/index.md` | Core Concepts overview |
| `content/docs/core-concepts/configuration.md` | Exhaustive config reference |
| `content/docs/core-concepts/content-format.md` | Markdown, frontmatter, meta.json docs |
| `content/docs/core-concepts/meta.json` | Navigation for core concepts |
| `content/docs/meta.json` | Updated root navigation: index, getting-started, core-concepts, guides |

## Requirements Covered

- CONTENT-001, CONTENT-002, CONTENT-003

## Implementation Tasks

1. Create `content/docs/getting-started/index.md`:
   - Title: "Getting Started"
   - Overview of what docsfn is and what you'll build
   - Links to sub-pages
2. Create `content/docs/getting-started/installation.md`:
   - Title: "Installation"
   - npm/pnpm/yarn install commands for each docsfn package
   - Required peer dependencies (svelte/sveltekit or react/next)
   - Monorepo workspace setup notes
3. Create `content/docs/getting-started/quick-start.md`:
   - Title: "Quick Start"
   - Step-by-step: create config → add first page → add meta.json → run dev server
   - Complete, copy-pasteable code examples
   - Both SvelteKit and Next.js paths
4. Create `content/docs/getting-started/project-structure.md`:
   - Title: "Project Structure"
   - Annotated directory tree
   - Explain each directory's purpose
   - How content maps to URLs
5. Create `content/docs/getting-started/meta.json`:
   ```json
   { "title": "Getting Started", "pages": ["index", "installation", "quick-start", "project-structure"] }
   ```
6. Create `content/docs/core-concepts/index.md`:
   - Title: "Core Concepts"
   - Brief overview with links to each concept page
7. Create `content/docs/core-concepts/configuration.md`:
   - Title: "Configuration"
   - Document every DocsConfig field:
     - schemaVersion, site (title, description, basePath, canonicalUrl, editLink, pageActions, theme), compat (preset, allowRawHtml), versions (mode, versions array), content (root, docsDir, pagesDir, blogDir, apiDir, assetsDir, metaFileName), navigation (topNav items, sidebars definitions), search (enabled, scopes, bodyIndexing, maxArtifactBytes), auth (enabled, mode), analytics (enabled, provider, respectDnt)
   - Each field: type, default value, description, example
   - Config file naming: docsfn.config.ts, .mjs, .js
   - Complete example config
8. Create `content/docs/core-concepts/content-format.md`:
   - Title: "Content Format"
   - Markdown features: headings, paragraphs, code blocks, lists, tables, links, images
   - Docsfn extensions: callouts (> [!NOTE] etc.), mermaid blocks, tabs, component blocks
   - Frontmatter fields: title (required), description, draft, tags, date, author, version
   - meta.json structure: title, pages array (string or {key, label, icon, hidden}), root flag
   - File naming: .md extension, index.md for sections
   - Directory → URL mapping rules
   - Collection types: docs, pages, blog, api
9. Create `content/docs/core-concepts/meta.json`:
   ```json
   { "title": "Core Concepts", "pages": ["index", "configuration", "content-format"] }
   ```
   (Will be extended in Phase 3 and 4)
10. Update `content/docs/meta.json`:
    ```json
    { "title": "docsfn", "pages": ["index", "getting-started", "core-concepts", "guides"] }
    ```

## Verification Steps

1. Dev server running → navigate to `/docs/getting-started` → page renders
2. Navigate to `/docs/getting-started/installation` → installation content visible
3. Navigate to `/docs/getting-started/quick-start` → quick start with code examples visible
4. Navigate to `/docs/getting-started/project-structure` → directory tree visible
5. Navigate to `/docs/core-concepts/configuration` → all config fields documented
6. Navigate to `/docs/core-concepts/content-format` → markdown features and meta.json documented
7. Sidebar shows Getting Started and Core Concepts sections with correct sub-pages

## Stop Condition

Report: all 8 content files created, all pages render correctly, sidebar navigation shows Getting Started (4 pages) and Core Concepts (3 pages). Content matches acceptance criteria in REQUIREMENTS.md.

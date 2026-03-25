# PHASE 07: API Reference — next, react

## Phase Goal

Write the P1 API reference documentation for @docsfn/next and @docsfn/react.

## In Scope

- content/api/next/ (full API reference)
- content/api/react/ (full component reference)

## Out of Scope

- All other content (completed in prior phases)

## Deliverables

| File | Description |
|---|---|
| `content/api/next/index.md` | @docsfn/next full API reference |
| `content/api/next/meta.json` | Navigation |
| `content/api/react/index.md` | @docsfn/react overview |
| `content/api/react/components.md` | All React components with props |
| `content/api/react/meta.json` | Navigation |

## Requirements Covered

- API-006, API-007

## Implementation Tasks

1. Create `content/api/next/index.md`:
   - Title: "@docsfn/next"
   - Package description: Next.js 15 App Router helpers
   - Installation
   - All exports documented:
     - generateStaticParams(manifest): generates params for [...slug] pages
     - resolveDocsRouteData(slug, manifest): returns route entry
     - resolveDocsPageSurface(entry, manifest, config): returns page surface
     - generatePageMetadata(surface): returns Next.js Metadata object
     - createSearchArtifactResponse(artifact): returns Response
   - Each function: full signature, parameters, return type, usage example

2. Create `content/api/next/meta.json`:
   ```json
   { "title": "@docsfn/next", "pages": ["index"] }
   ```

3. Create `content/api/react/index.md`:
   - Title: "@docsfn/react"
   - Package description: React components for docsfn
   - Installation, peer dependencies (React 18/19)

4. Create `content/api/react/components.md`:
   - All React components:
     - DocsLayout: props, children pattern
     - DocsSidebar: props
     - Breadcrumbs: props
     - DocsContent: props (compiled content rendering)
     - DocsToc: props (intersection observer)
     - Pagination: props (keyboard shortcuts)
     - DocsSearch: props (dialog, keyboard)
     - ApiReferenceRenderer: props (OpenAPI rendering)
     - BlogList: props (post listing)
     - VersionSwitcher: props
     - ThemeProvider: props (context provider)
     - TopBar: props
     - EmbeddedPage: props
   - Usage examples for common patterns

5. Create `content/api/react/meta.json`:
   ```json
   { "title": "@docsfn/react", "pages": ["index", "components"] }
   ```

## Verification Steps

1. `/docs/api/next` renders with full @docsfn/next documentation
2. `/docs/api/react` renders with overview
3. `/docs/api/react/components` renders with all 13 React components documented
4. API sidebar shows next and react sections

## Stop Condition

Report: all 7 package API references complete, API sidebar fully populated. Ready for Blog (Phase 8) and Search (Phase 9).

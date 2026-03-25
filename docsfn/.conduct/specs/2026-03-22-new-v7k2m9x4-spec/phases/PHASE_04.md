# PHASE 04: Core Content — Blog, Versioning, OpenAPI, Security, Analytics, RSS, Markdown Extensions, Diagnostics

## Phase Goal

Write the P1 core concept documentation pages covering all remaining docsfn features.

## In Scope

- content/docs/core-concepts/blog.md
- content/docs/core-concepts/versioning.md
- content/docs/core-concepts/openapi.md
- content/docs/core-concepts/security.md
- content/docs/core-concepts/analytics.md
- content/docs/core-concepts/rss.md
- content/docs/core-concepts/markdown-extensions.md
- content/docs/core-concepts/diagnostics.md
- Updated meta.json

## Out of Scope

- API reference (Phase 6, 7)
- Guides (Phase 5)

## Deliverables

| File | Description |
|---|---|
| `content/docs/core-concepts/blog.md` | Blog setup, frontmatter, drafts, tags, archives, RSS |
| `content/docs/core-concepts/versioning.md` | Versioning modes, config, version switcher |
| `content/docs/core-concepts/openapi.md` | OpenAPI spec loading, auto-generated routes |
| `content/docs/core-concepts/security.md` | HTML sanitization, auth modes, redaction |
| `content/docs/core-concepts/analytics.md` | Event types, DNT, provider config |
| `content/docs/core-concepts/rss.md` | RSS feed generation |
| `content/docs/core-concepts/markdown-extensions.md` | Callouts, mermaid, tabs, components |
| `content/docs/core-concepts/diagnostics.md` | Error codes, severity levels, troubleshooting |
| `content/docs/core-concepts/meta.json` | Updated with all pages |

## Requirements Covered

- CONTENT-009, CONTENT-010, CONTENT-011, CONTENT-012, CONTENT-013, CONTENT-014, CONTENT-017, CONTENT-018

## Implementation Tasks

1. Create `content/docs/core-concepts/blog.md`:
   - Blog directory setup (content/blog/)
   - Required frontmatter: title, date (ISO format)
   - Optional frontmatter: author (string or object), tags (array), excerpt, summary, draft (boolean)
   - Draft filtering: frontmatter draft: true, "true", "yes", or 1
   - Tag normalization: lowercase, deduped
   - Archive pagination: pageSize (default 10), route patterns
   - Tag index pages
   - Blog listing route and post routes
   - BlogManifestSurface: listRoute, feedPath, postOrder, tags, archives

2. Create `content/docs/core-concepts/versioning.md`:
   - Versioning modes: "none" (default), "path-prefix", "path-segment"
   - Version definition: slug, label, default flag
   - Config example with versions array
   - URL generation: path-prefix → /v2.0/page, path-segment → /page/v2.0
   - Version detection from frontmatter.version or path
   - VersionSwitcher component: props, behavior
   - Versioned static params generation

3. Create `content/docs/core-concepts/openapi.md`:
   - Supported formats: JSON (.json), YAML (.yaml, .yml)
   - Adding specs to content/api/ directory
   - Auto-generated routes: overview, tag groups, operations, schemas
   - Route patterns: /api/{spec}/, /api/{spec}/tag/{slug}, /api/{spec}/operation/{id}, /api/{spec}/schema/{name}
   - CanonicalOpenApiReference structure
   - ApiReferenceRenderer component usage

4. Create `content/docs/core-concepts/security.md`:
   - HTML sanitization: blocked tags (script, iframe, object, embed, link, meta), blocked patterns (on*=, javascript:)
   - Auth modes: public (no auth), private (all routes require auth), mixed (per-route)
   - Route-level access: frontmatter.private flag, /private/* URL pattern
   - Sensitive data detection: keys (secret, token, password, api_key, etc.), values (Bearer, xox*, gh*, sk_)
   - Redaction in diagnostics and analytics
   - DOCSFN_HTML_UNSAFE_ALLOWLIST env var for overrides

5. Create `content/docs/core-concepts/analytics.md`:
   - Event types: docs.pageview, docs.search, docs.search_result_click, docs.external_click
   - Analytics event shape: name, timestamp, route, version, sidebarId, etc.
   - DNT respect: navigator.doNotTrack
   - Provider: "watchfn"
   - URL sanitization: removes sensitive query params
   - Config: enabled, provider, respectDnt

6. Create `content/docs/core-concepts/rss.md`:
   - RSS 2.0 format
   - Auto-generation from blog posts
   - Feed elements: title, link, description, pubDate, author, category
   - Atom self-link
   - Serving in SvelteKit/Next.js

7. Create `content/docs/core-concepts/markdown-extensions.md`:
   - Callouts: `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`, `> [!INFO]`, `> [!CAUTION]`
   - Syntax and rendered appearance for each
   - Mermaid diagrams: ` ```mermaid ` code fence
   - Supported diagram types (graph, sequence, etc.)
   - Tabs: `<Tabs><Tab value="key">content</Tab></Tabs>`
   - Code blocks: language highlighting, supported languages
   - Component blocks: `<ComponentName prop="value">body</ComponentName>`
   - Compiled content block types: heading, paragraph, code, mermaid, tabs, callout, component

8. Create `content/docs/core-concepts/diagnostics.md`:
   - All 17 error codes with descriptions:
     - DOCS_CONFIG_INVALID, DOCS_CONFIG_UNSUPPORTED, DOCS_PROVIDER_ERROR, DOCS_ENTRY_INVALID, DOCS_META_INVALID, DOCS_ROUTE_CONFLICT, DOCS_ROUTE_NOT_FOUND, DOCS_VERSION_INVALID, DOCS_COMPAT_UNSUPPORTED, DOCS_MDX_COMPILE_FAILED, DOCS_HTML_UNSAFE, DOCS_SEARCH_BUILD_FAILED, DOCS_OPENAPI_PARSE_FAILED, DOCS_REMOTE_FETCH_FAILED, DOCS_AUTH_REQUIRED, DOCS_AUTH_FORBIDDEN, DOCS_ARTIFACT_INVALID
   - Severity levels: error (blocks build), warning (non-blocking), info (informational)
   - DocsDiagnostic shape: code, severity, message, location, details, suggestion
   - Reading diagnostics.json output
   - Common scenarios and resolutions

9. Update `content/docs/core-concepts/meta.json` to include all pages:
   ```json
   {
     "title": "Core Concepts",
     "pages": ["index", "configuration", "content-format", "sidebars", "navigation", "search", "seo", "theming", "cli", "content-providers", "blog", "versioning", "openapi", "security", "analytics", "rss", "markdown-extensions", "diagnostics"]
   }
   ```

## Verification Steps

1. All 8 new pages render at their URLs
2. Sidebar shows all 18 core concept pages in correct order
3. Content matches acceptance criteria per REQUIREMENTS.md
4. No broken internal links

## Stop Condition

Report: all P1 core concept pages created, core concepts section complete with 18 pages. Ready for Guides (Phase 5) and API Reference (Phase 6).

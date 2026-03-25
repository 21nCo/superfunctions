# PHASE 09: Search Wiring

## Phase Goal

Wire up full-text search: ensure the search artifact endpoint works, the DocsSearch component is integrated, and search covers all content.

## In Scope

- DocsSearch component integration in layout
- Search artifact endpoint verification
- Keyboard shortcut (Cmd/Ctrl+K)
- Scope filtering (docs, api, blog)
- Search result navigation

## Out of Scope

- Search endpoint creation (Phase 1)
- Content (Phases 2-8)

## Deliverables

| File | Description |
|---|---|
| `src/routes/+layout.svelte` | Updated to include DocsSearch component with artifact loading |

Note: Most search infrastructure is created in Phase 0 (config) and Phase 1 (endpoint + layout). This phase ensures everything is wired together correctly after content exists.

## Requirements Covered

- SEARCH-001, SEARCH-002, SEARCH-003, SEARCH-004

## Implementation Tasks

1. Verify search configuration in docsfn.config.ts:
   - `search.enabled: true`
   - `search.scopes: ["docs", "api", "blog"]`
   - `search.bodyIndexing: "summary"`

2. Verify search artifact endpoint:
   - `curl http://localhost:6004/search.json` returns valid JSON
   - Response contains documents from all 3 scopes
   - schemaVersion is 1, engine is "searchfn"
   - bytes field is populated

3. Wire DocsSearch component in root layout:
   - Import DocsSearch from @docsfn/svelte
   - Pass searchArtifact from layout data (or a loader function that fetches /search.json)
   - Configure scopes: ["docs", "api", "blog"]
   - Set placeholder text: "Search documentation..."

4. Verify keyboard shortcut:
   - Cmd+K (macOS) / Ctrl+K (other) opens search dialog
   - Arrow keys navigate results
   - Enter selects and navigates to result
   - Escape closes dialog

5. Verify scope filtering:
   - Default scope shows all results
   - Selecting "docs" filters to documentation pages only
   - Selecting "api" filters to API reference only
   - Selecting "blog" filters to blog posts only

6. Verify search result display:
   - Each result shows kind (page/api/post indicator)
   - Title is displayed
   - Summary/excerpt is displayed
   - Path is displayed
   - Clicking navigates to the correct page

7. Verify search coverage:
   - Search for a term from docs content → docs results appear
   - Search for a term from API content → api results appear
   - Search for "introducing" → blog post appears

## Verification Steps

1. `curl http://localhost:6004/search.json | jq '.documents | length'` → returns > 0
2. `curl http://localhost:6004/search.json | jq '.scopes'` → returns ["docs", "api", "blog"]
3. Open site → press Cmd/Ctrl+K → search dialog opens
4. Type "config" → results from docs and/or api scope appear
5. Type "introducing" → blog post result appears
6. Click a result → navigates to correct page
7. Filter by scope → results filtered correctly

## Stop Condition

Report: search is fully functional — endpoint serves artifact, dialog opens with keyboard shortcut, results display correctly with scope filtering, clicking results navigates to correct pages.

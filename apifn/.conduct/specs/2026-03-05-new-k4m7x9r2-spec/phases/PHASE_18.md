# Phase 18: React UI Components

## Phase Goal
Build the React component library for the API explorer and try-it console.

## In Scope
- `ApiExplorer` — full explorer layout with sidebar, search, endpoint list
- `EndpointViewer` — single endpoint documentation
- `SchemaViewer` — JSON Schema tree rendering
- `TryIt` — interactive request builder and sender
- `RequestHistory` — past request list
- `ResponseDiff` — side-by-side response comparison
- `PerformanceOverlay` — watchfn metrics display
- Theme support (light/dark/auto)
- Responsive layout

## Out of Scope
- Svelte components (next phase)
- docsfn integration (later phase)

## Deliverables
- `apifn/react/src/ApiExplorer.tsx`
- `apifn/react/src/EndpointViewer.tsx`
- `apifn/react/src/SchemaViewer.tsx`
- `apifn/react/src/TryIt.tsx`
- `apifn/react/src/RequestHistory.tsx`
- `apifn/react/src/ResponseDiff.tsx`
- `apifn/react/src/PerformanceOverlay.tsx`
- `apifn/react/src/styles/` — CSS modules or CSS-in-JS
- `apifn/react/src/index.ts` — exports
- `apifn/react/__tests__/` — component render tests

## Requirements Covered
- UI-R-001 through UI-R-009

## Implementation Tasks
1. [ ] Design component hierarchy: ApiExplorer contains sidebar + main area, main area shows EndpointViewer + TryIt
2. [ ] Implement SchemaViewer: recursive tree rendering with collapse/expand, type badges, required markers
3. [ ] Implement EndpointViewer: method badge, path, summary, parameters table, request body, response schemas
4. [ ] Implement TryIt: URL bar, method selector, parameter inputs, body editor, auth config, send button, response display
5. [ ] Implement HTTP client for TryIt: fetch with CORS proxy fallback
6. [ ] Implement ApiExplorer: sidebar with grouped endpoints, search/filter, route navigation
7. [ ] Implement RequestHistory: list of past requests, click to view
8. [ ] Implement ResponseDiff: side-by-side JSON diff
9. [ ] Implement PerformanceOverlay: latency bars, error rate, throughput counters
10. [ ] Implement theming: CSS variables for light/dark, auto detection via prefers-color-scheme
11. [ ] Implement responsive layout: sidebar collapse on mobile
12. [ ] Write component render tests
13. [ ] Export all components from index

## Verification Steps
1. `npm run build` → builds without errors
2. ApiExplorer renders with a sample OpenAPI spec (visual inspection)
3. TryIt sends a request and displays response
4. SchemaViewer renders nested schemas with collapse/expand
5. Responsive: sidebar collapses at 768px

## Stop Condition
All components render correctly. TryIt sends real requests. Report component count and build size.

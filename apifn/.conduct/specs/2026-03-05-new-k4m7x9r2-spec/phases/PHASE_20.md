# Phase 20: docsfn Plugin

## Phase Goal
Build the docsfn plugin that provides a content provider and API reference renderers for embedding API documentation in docsfn sites.

## In Scope
- `createApifnProvider(options)` — DocsContentProvider implementation
- `ApifnApiReference` React component
- `ApifnApiReference` Svelte component
- Auto-sidebar generation from API tags
- Split by tag/path support
- Optional try-it and performance overlay integration

## Out of Scope
- watchfn data fetching (Phase 21)
- Composite provider support in docsfn core (works as standalone provider or manual merge)

## Deliverables
- `apifn/docsfn/src/provider.ts`
- `apifn/docsfn/src/react/ApifnApiReference.tsx`
- `apifn/docsfn/src/svelte/ApifnApiReference.svelte`
- `apifn/docsfn/src/index.ts`
- `apifn/docsfn/__tests__/provider.test.ts`

## Requirements Covered
- DOCS-001, DOCS-002, DOCS-003, DOCS-004, DOCS-005, DOCS-006

## Implementation Tasks
1. [ ] Implement `createApifnProvider()`: accept OpenAPI doc, Router, or file path; return DocsContentProvider
2. [ ] Implement split-by-tag: one `RawContentEntry` per tag group with `kind: "api"`
3. [ ] Implement full-spec mode: single entry with complete spec
4. [ ] Implement sidebar generation: create SidebarItem groups from tags
5. [ ] Implement `ApifnApiReference` React component: wraps @apifn/react components, renders from docsfn's `ApiReference` type
6. [ ] Implement `ApifnApiReference` Svelte component: same for Svelte
7. [ ] Implement try-it toggle: show/hide TryIt per endpoint
8. [ ] Implement watchfn prop: pass through to PerformanceOverlay
9. [ ] Write provider test: verify RawContentEntry output
10. [ ] Export all from docsfn index

## Verification Steps
1. `npm run test` → provider tests pass
2. TV-DOCS-001: Provider returns correct entries for tagged spec
3. React renderer displays API reference (visual inspection)
4. Sidebar items generated correctly

## Stop Condition
Provider produces valid docsfn entries. Renderers display API docs. Report entry count.

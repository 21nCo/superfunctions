# PLAN

## Architecture Sketch

```
@datafn/core          ← Remove multiTenant from types, schema validation, defineSchema
   │
   ├── @datafn/server ← Remove authContextProvider, legacy bridge, @superfunctions/auth import
   │
   ├── @datafn/client ← Remove authContext, currentContext, createForUser, simplify storage factory
   │   │
   │   └── @datafn/svelte  ← Already exists; needs docs only (no code changes)
   │
   ├── @datafn/cli    ← Rename isMultiTenant → isNamespaced, update comments
   │
   └── datafn/docs    ← Remove all legacy refs, add Svelte/framework adapter docs
```

## Dependency Graph

1. **Core types first** (Phase 0): `@datafn/core` changes must land before server/client, since they import from core.
2. **Server + Client in parallel** (Phase 1): Server and client changes are independent of each other; both depend on core.
3. **CLI** (Phase 1): CLI depends on core's `isNamespaced()` — can be done alongside server/client.
4. **Tests** (Phase 2): After source changes, update/delete tests.
5. **Docs** (Phase 3): After code is final, update documentation.
6. **Svelte docs** (Phase 4): New documentation for `@datafn/svelte` and framework ecosystem.

## Phases Overview

| Phase | Goal | Delivered Capability | Verification |
|---|---|---|---|
| PHASE_00 | Remove `multiTenant` from `@datafn/core` | Core types, schema validation, defineSchema, isNamespaced simplified | `npx vitest run` in `datafn/core` |
| PHASE_01 | Remove legacy code from `@datafn/server` | No `authContextProvider`, no legacy bridge, no `@superfunctions/auth` import | `npx vitest run` in `datafn/server` |
| PHASE_02 | Remove legacy code from `@datafn/client` | No `authContext`, no `currentContext()`, simplified storage factory, no `createForUser` | `npx vitest run` in `datafn/client` |
| PHASE_03 | Update CLI codegen | `isMultiTenant` → `isNamespaced`, comments updated | `npx vitest run` in `datafn/cli` |
| PHASE_04 | Update/delete tests | All legacy test cases removed, all remaining tests pass | `npx vitest run` across all datafn packages |
| PHASE_05 | Update existing docs — remove legacy references | All docs reflect current API only | Manual review of doc files |
| PHASE_06 | Add `@datafn/svelte` and framework ecosystem docs | New framework adapters doc page, Svelte API reference, updated signals/setup docs | Manual review of new doc files |
| PHASE_07 | Restructure sidebar: move schema sub-topics under DFQL + create concepts overview | Schema/resources/fields/relations/system-fields under DFQL, new overview page in concepts | Doc site builds, sidebar correct |
| PHASE_08 | Cross-link DFQL pages from main documentation + add system architecture diagram | Contextual links in client docs to DFQL pages, mermaid diagram on home + overview | Doc site builds, links valid |
| PHASE_09 | Merge Python SDK docs into main server docs using tabbed code blocks | Python examples in server/database docs via Fumadocs Tabs, Python sidebar removed | Doc site builds, no Python sidebar |

## Dependency Graph (updated)

1. **Core types first** (Phase 0): `@datafn/core` changes must land before server/client.
2. **Server + Client in parallel** (Phase 1, 2): Independent of each other; both depend on core.
3. **CLI** (Phase 3): Depends on core's `isNamespaced()`.
4. **Tests** (Phase 4): After source changes.
5. **Docs: remove legacy** (Phase 5): After code is final.
6. **Docs: Svelte** (Phase 6): After Phase 5 (builds on cleaned docs).
7. **Docs: restructure sidebar** (Phase 7): After Phase 5 (moves cleaned pages). Can run in parallel with Phase 6.
8. **Docs: cross-links + diagram** (Phase 8): After Phase 7 (needs DFQL pages in final location). Can run in parallel with Phase 6.
9. **Docs: Python merge** (Phase 9): After Phase 5 (builds on cleaned server docs). Can run in parallel with Phases 6-8.

## Definition of Done

No phase is complete unless its verification steps pass. All TypeScript compilation must succeed. All vitest tests must pass. All documentation must accurately reflect the current API surface with no references to removed APIs. The doc site must build successfully after each docs phase.

# INTENT AUDIT

## Intent Inventory

The user's intent was extracted from the conversation prompt (original + update):

1. **Remove support for legacy `authContextProvider`** — the predecessor spec (`2026-03-01-change-r7k4m9x3-spec`) introduced new namespace usage but kept old code for backward compatibility.
2. **No backward compatibility needed** — the library is not used by anyone yet, so all legacy code should be completely removed.
3. **Update docs accordingly** — all documentation must reflect only the current API surface with no references to deprecated/removed APIs.
4. **Update docs to include svelte package** — `@datafn/svelte` usage at relevant places, in reference docs, etc.
5. **Mention other client packages will be added** to the datafn ecosystem.
6. **Document how framework-specific packages are used** — usage examples with Svelte.
7. **Mention similar usage in future for other frameworks** — React, Vue, etc. follow the same adapter pattern.
8. **Nest resources, fields, relations etc under schema and move schema from concepts to DFQL** — schema sub-topics belong under DFQL section, not concepts.
9. **Replace schema in concepts with an overview page** — high-level overview covering all core concepts (client, server, DFQL, schema, query, framework libraries, etc.).
10. **Cross-link DFQL pages from main documentation** — e.g., client queries mentions select → link to full DFQL select page.
11. **Cross-link other relevant DFQL pages** from main documentation at appropriate places.
12. **Create a mermaid diagram of entire DataFn system** — use on home page and concepts overview.
13. **Merge Python SDK into main server docs** — instead of separate Python sidebar, use tabbed code blocks (Fumadocs Tabs).

---

## Coverage Matrix

| # | Intent Item | SPEC.md Section | Requirement IDs | Test Vectors |
|---|---|---|---|---|
| 1 | Remove `authContextProvider` legacy code | Overview (item 1), Goals (1-3), Public API (server section) | REM-005 through REM-010 | TV-REM-005 through TV-REM-008 |
| 2 | No backward compatibility — complete removal | Overview ("deleted entirely"), Goals (1-3), Non-goals (none defer removal) | REM-001 through REM-023 (all removal reqs) | TV-REM-001 through TV-REM-017 |
| 2a | Remove `multiTenant` from schema | Public API (core section) | REM-001, REM-002, REM-003, REM-004, REM-023 | TV-REM-001 through TV-REM-004, TV-REM-017 |
| 2b | Remove `authContext` from client | Public API (client section) | REM-011 through REM-020 | TV-REM-009 through TV-REM-015 |
| 2c | Remove `createForUser` | Public API (client section, IndexedDbStorageAdapter) | REM-017 | TV-REM-015 |
| 2d | Remove `currentContext()` | Public API (client section, DatafnClient) | REM-013 | TV-REM-011 |
| 2e | Remove `userId` from changelog | Public API (client section, DatafnChangelogEntry) | REM-016 | TV-REM-014 |
| 2f | Simplify `DatafnStorageFactory` | Public API (client section) | REM-015 | TV-REM-013 |
| 2g | Remove `@superfunctions/auth` import | Public API (server + client sections) | REM-010, REM-018, REM-019 | N/A (build verification) |
| 2h | Remove deprecation warnings | Public API (server, client), Observability | REM-009, REM-020 | N/A (absence check) |
| 2i | Update CLI codegen variable names | Public API (CLI section) | REM-021, REM-022 | TV-REM-016 |
| 2j | Update tests | (covered implicitly by all REM requirements) | TST-001 through TST-006 | N/A |
| 3 | Update docs — remove legacy references | Goals (4), covered in phase plan | DOC-001 through DOC-011 | N/A |
| 3a | Update multi-tenancy/namespace doc | Goals (4) | DOC-001 | N/A |
| 3b | Update client docs (setup, config ref) | Goals (4) | DOC-002, DOC-004 | N/A |
| 3c | Update server docs (setup, config ref) | Goals (4) | DOC-003, DOC-005 | N/A |
| 3d | Update storage docs (reference, overview, indexeddb) | Goals (4) | DOC-006, DOC-008, DOC-009 | N/A |
| 3e | Update core types reference | Goals (4) | DOC-007 | N/A |
| 3f | Update security doc | Goals (4) | DOC-010 | N/A |
| 3g | Update schema concept doc | Goals (4) | DOC-011 | N/A |
| 4 | Document `@datafn/svelte` at relevant places | Goals (5-6) | SVL-001 through SVL-006 | N/A |
| 4a | Create framework adapters overview page | Goals (5) | SVL-001 | N/A |
| 4b | Svelte usage examples in signals doc | Goals (5) | SVL-002 | N/A |
| 4c | Svelte mention in client setup doc | Goals (5) | SVL-003 | N/A |
| 4d | Svelte API reference page | Goals (5) | SVL-004 | N/A |
| 5 | Mention other client packages will be added | Goals (6) | SVL-005 | N/A |
| 6 | Framework-specific usage examples with Svelte | Goals (5) | SVL-001, SVL-002, SVL-006 | N/A |
| 7 | Mention similar future usage for other frameworks | Goals (6) | SVL-005 | N/A |
| 8 | Nest resources, fields, relations under DFQL | Goals (8), Docs Restructuring | RST-001 | N/A |
| 9 | Replace schema in concepts with overview page | Goals (8), Docs Restructuring | RST-002, RST-003 | N/A |
| 10 | Cross-link DFQL pages from client queries (select, sort, etc.) | Goals (9), Docs Restructuring (cross-linking table) | LNK-001 | N/A |
| 11 | Cross-link other DFQL pages from appropriate places | Goals (9) | LNK-002, LNK-003, LNK-004 | N/A |
| 12 | Create mermaid diagram of entire DataFn system | Goals (10), Docs Restructuring | DIA-001, DIA-002, DIA-003 | N/A |
| 13 | Merge Python SDK into main server docs using tabbed code blocks | Goals (11), Docs Restructuring (Python integration) | PY-001, PY-002, PY-003, PY-004, PY-005 | N/A |

---

## Missing Intent Items

**No missing intent items.** All 13 items from the user's prompt (original + update) are fully covered:

1. Legacy `authContextProvider` removal → 23 REM requirements + 6 TST requirements
2. No backward compatibility → All REM requirements delete rather than deprecate
3. Update docs → 11 DOC requirements
4. Svelte package docs → 6 SVL requirements
5. Other framework packages → SVL-005
6. Framework usage examples → SVL-001, SVL-002, SVL-006
7. Future framework mention → SVL-005
8. Nest schema sub-topics under DFQL → RST-001
9. Overview page in concepts → RST-002, RST-003
10. Cross-link DFQL from client queries → LNK-001
11. Cross-link other DFQL pages → LNK-002, LNK-003, LNK-004
12. Mermaid system diagram → DIA-001, DIA-002, DIA-003
13. Python SDK merge into server docs → PY-001, PY-002, PY-003, PY-004, PY-005

The spec also covers related items not explicitly mentioned but logically required:
- Removing `multiTenant` (sibling deprecated field from same spec)
- Removing `createForUser` (sibling deprecated method)
- Removing `currentContext()` (sibling deprecated method)
- Removing `userId` from changelog (sibling deprecated field)
- Simplifying `DatafnStorageFactory` type (consequence of removing `AuthContext`)
- CLI codegen updates (consequence of removing `multiTenant`)
- Test updates (consequence of all source changes)

**Final assessment: No missing intent items. Full coverage achieved.**

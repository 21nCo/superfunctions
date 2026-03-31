# Intent Inventory
1. Native-backed Swift DataFn needs local search.
2. Local search in native-backed mode should not use IndexedDB.
3. SearchFn Swift should remain reusable on its own, with DataFn-specific integration separated.
4. DataFn must support the SearchFn Swift package as its native search backend.
5. Browser-owned mode must continue to support IndexedDB + JS-owned search.
6. Embedded `WKWebView` mode must use Swift-owned local search and Swift-owned sync.
7. CloudKit mode must use derived local search and must not replicate the search index itself through CloudKit.
8. Native and WebView callers should be able to query the same native search backend.
9. Search fields should come from the existing DataFn schema semantics instead of a duplicated side configuration.

# Coverage Audit
## 1. Native-backed Swift DataFn needs local search.
- Covered in SPEC.md: `Overview`, `Goals / Non-goals`, `Public API`, `Semantics`
- Requirement IDs: `DARCH-001`, `DAPI-001`, `DRT-001`
- Test vectors: `TV-DFS-002`, `TV-DFS-003`, `TV-DFS-010`

## 2. Local search in native-backed mode should not use IndexedDB.
- Covered in SPEC.md: `Goals / Non-goals`, `Semantics`, `Invariants`
- Requirement IDs: `DJS-001`, `DPST-001`
- Test vectors: `TV-DFS-003`, `TV-DFS-004`

## 3. SearchFn Swift should remain reusable on its own, with DataFn-specific integration separated.
- Covered in SPEC.md: `Overview`, `Public API`, `Compatibility / versioning strategy`
- Requirement IDs: `DARCH-001`
- Test vectors: `TV-DFS-002`, `TV-DFS-010`

## 4. DataFn must support the SearchFn Swift package as its native search backend.
- Covered in SPEC.md: `Overview`, `Public API`, `Semantics`
- Requirement IDs: `DARCH-001`, `DRT-001`
- Test vectors: `TV-DFS-002`, `TV-DFS-010`

## 5. Browser-owned mode must continue to support IndexedDB + JS-owned search.
- Covered in SPEC.md: `Overview`, `Semantics`
- Requirement IDs: `DJS-001`, `DDOC-001`
- Test vectors: `TV-DFS-001`

## 6. Embedded `WKWebView` mode must use Swift-owned local search and Swift-owned sync.
- Covered in SPEC.md: `Overview`, `Semantics`, `Invariants`
- Requirement IDs: `DAPI-001`, `DJS-001`, `DIDX-001`
- Test vectors: `TV-DFS-002`, `TV-DFS-003`, `TV-DFS-004`, `TV-DFS-005`

## 7. CloudKit mode must use derived local search and must not replicate the search index itself through CloudKit.
- Covered in SPEC.md: `Overview`, `Goals / Non-goals`, `Semantics`, `Invariants`
- Requirement IDs: `DIDX-001`, `DPST-001`
- Test vectors: `TV-DFS-006`

## 8. Native and WebView callers should be able to query the same native search backend.
- Covered in SPEC.md: `Goals / Non-goals`, `Public API`, `Semantics`
- Requirement IDs: `DRT-001`
- Test vectors: `TV-DFS-010`

## 9. Search fields should come from the existing DataFn schema semantics instead of a duplicated side configuration.
- Covered in SPEC.md: `Data formats / protocol`, `Semantics`, `Invariants`
- Requirement IDs: `DCFG-001`
- Test vectors: `TV-DFS-001`, `TV-DFS-002`, `TV-DFS-009`

# Result
No missing intent items.

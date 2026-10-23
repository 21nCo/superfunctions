# Intent Inventory
1. A Swift SearchFn package is needed.
2. The Swift SearchFn package must be usable independently for search workflows, not only through DataFn.
3. The Swift SearchFn design must also be suitable for later use as a DataFn-backed search subsystem.
4. Core Data must not become the primary search index model.
5. Search persistence should live in a SearchFn-owned local index store.
6. The Swift package should preserve the current SearchFn architecture rather than inventing a completely different model.
7. The package should expose both low-level reusable layers and a high-level ergonomic API.
8. The scope for this spec is local/in-process search, not an HTTP server.
9. The design should stay portable where possible instead of hard-coding Apple-only frameworks into the search core.

# Coverage Audit
## 1. A Swift SearchFn package is needed.
- Covered in SPEC.md: `Overview`, `Goals / Non-goals`, `Public API`
- Requirement IDs: `SARCH-001`, `SDOC-001`
- Test vectors: `TV-SF-001`, `TV-SF-006`

## 2. The Swift SearchFn package must be usable independently for search workflows, not only through DataFn.
- Covered in SPEC.md: `Overview`, `Goals / Non-goals`, `Public API`, `Invariants`
- Requirement IDs: `SARCH-001`, `SMEM-001`
- Test vectors: `TV-SF-001`, `TV-SF-007`, `TV-SF-009`

## 3. The Swift SearchFn design must also be suitable for later use as a DataFn-backed search subsystem.
- Covered in SPEC.md: `Overview`, `Goals / Non-goals`, `Invariants`, `Compatibility / versioning strategy`
- Requirement IDs: `SARCH-001`, `SAPI-001`
- Test vectors: `TV-SF-001`, `TV-SF-002`, `TV-SF-004`

## 4. Core Data must not become the primary search index model.
- Covered in SPEC.md: `Overview`, `Goals / Non-goals`, `Public API`, `Undefined / Explicitly user-deferred only`
- Requirement IDs: `SSQL-001`
- Test vectors: `TV-SF-006`

## 5. Search persistence should live in a SearchFn-owned local index store.
- Covered in SPEC.md: `Data formats / protocol`, `Semantics`, `Security`
- Requirement IDs: `SSQL-001`
- Test vectors: `TV-SF-006`, `TV-SF-008`

## 6. The Swift package should preserve the current SearchFn architecture rather than inventing a completely different model.
- Covered in SPEC.md: `Overview`, `Goals / Non-goals`, `Public API`, `Compatibility / versioning strategy`
- Requirement IDs: `SARCH-001`, `SAPI-001`, `SENG-001`
- Test vectors: `TV-SF-001`, `TV-SF-002`, `TV-SF-003`, `TV-SF-004`

## 7. The package should expose both low-level reusable layers and a high-level ergonomic API.
- Covered in SPEC.md: `Goals / Non-goals`, `Public API`
- Requirement IDs: `SMEM-001`, `SDOC-001`
- Test vectors: `TV-SF-001`, `TV-SF-009`

## 8. The scope for this spec is local/in-process search, not an HTTP server.
- Covered in SPEC.md: `Overview`, `Goals / Non-goals`, `Undefined / Explicitly user-deferred only`
- Requirement IDs: `SARCH-001`
- Test vectors: `TV-SF-001`

## 9. The design should stay portable where possible instead of hard-coding Apple-only frameworks into the search core.
- Covered in SPEC.md: `Public API`, `Security`, `Compatibility / versioning strategy`
- Requirement IDs: `SPLAT-001`
- Test vectors: `TV-SF-001`, `TV-SF-006`

# Result
No missing intent items.

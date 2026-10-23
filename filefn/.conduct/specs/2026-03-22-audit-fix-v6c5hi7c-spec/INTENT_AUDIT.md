# INTENT_AUDIT.md

This intent audit was derived from the authoritative inputs for this bundle:
- the 2026-03-22 FileFn audit-fix compliance audit
- the 2026-03-22 FileFn readiness audit for replacing Nucleus uploads/rendering
- the superseded 2026-03-20 FileFn audit-fix bundle
- the Superfunctions and Nucleus AGENTS files
- the user’s explicit scope and decision answers

## Intent Inventory
1. All unresolved findings from the 2026-03-22 compliance audit MUST be fixed.
2. The prior FileFn production-readiness guarantees MUST remain in force unless explicitly superseded.
3. TypeScript replace completion auth MUST be fixed.
4. Anonymous init replay MUST return the original semantic success result.
5. Deterministic list/read/delete parity MUST be completed on Python.
6. Python observability/redaction parity MUST be completed.
7. FileFn MUST become the canonical file platform for Nucleus.
8. Final-state Nucleus IDs MUST be native FileFn IDs.
9. Only a temporary migration compatibility layer is allowed.
10. Legacy file migration MUST prefer in-place object adoption.
11. Multi-bucket routing MUST be implemented as a plugin/wrapper, not hard-coded in FileFn core.
12. FileFn MUST provide a first-class viewer/render abstraction.
13. Nucleus MUST replace old rendering flows with the FileFn viewer approach.
14. Unsynced local files MUST persist to OPFS.
15. Unsynced local files MUST support immediate local preview/access.
16. Browser HEIC conversion MUST be provided as a FileFn capability/plugin.
17. FileFn MUST support PDF preview thumbnails.
18. FileFn MUST continue to support image thumbnails.
19. FileFn MUST preserve resumable upload/proxy fallback semantics.
20. FileFn MUST preserve canonical envelopes and stable error codes.
21. No public response may return `proxy://...`.
22. File/version/artifact/share/render auth MUST remain consistent.
23. Metadata MUST no longer be dropped on completion/import.
24. Logical storage targets MUST be policy-driven.
25. Physical bucket choice MUST be routed through storage plugin logic.
26. Nucleus-aligned MIME/type and 100 MiB caps MUST be encoded in FileFn policies.
27. Render/view resolution MUST prefer artifacts or local pending bytes deterministically.
28. Nucleus write paths MUST stop creating new legacy `file:` resources.
29. Nucleus read paths MUST stop depending on persisted `url` / `thumbnailUrl` identity semantics.
30. Migration MUST be manifest-driven and deterministic.
31. Migration MUST emit rewrite and rollback artifacts.
32. Temporary dual-read during cutover is allowed.
33. Legacy code MUST be deleted after successful cutover.
34. Python server/storage semantics for new bundle features MUST stay parity-targeted.
35. `@filefn/viewer` MUST be a real package, not an experimental note.
36. `@uifn/files` MUST not become the critical-path viewer package for cutover.
37. FileFn examples/smoke coverage MUST expand to the new render/migration surfaces.
38. Anything not explicitly specified remains undefined.

## Coverage mapping
| Intent # | Covered in SPEC.md | Requirement IDs | Test vectors |
| --- | --- | --- | --- |
| 1 | Overview; Goals / Non-goals; Semantics | AUTH-001, AUTH-002, FILE-001, FILE-003, OBS-001, PY-002 | TV-AUTH-001, TV-AUTH-002, TV-FILE-001, TV-FILE-003, TV-PY-002 |
| 2 | Goals / Non-goals; Compatibility / versioning strategy | BUILD-001, API-001, AUTH-001, AUTH-002, UPLOAD-001, UPLOAD-002, FILE-001, FILE-002, FILE-003, DEDUPE-001, RATE-001, PROCESS-001, OBS-001, PY-001, PY-002, PY-003, DEMO-001 | TV-BUILD-001, TV-API-001, TV-DEMO-001 |
| 3 | Semantics → Upload/session/auth semantics; Security | AUTH-002 | TV-AUTH-002 |
| 4 | Semantics → Upload/session/auth semantics; Invariants | AUTH-001, UPLOAD-001 | TV-AUTH-001, TV-UPLOAD-001 |
| 5 | Semantics → Upload/session/auth semantics; Semantics → Nucleus migration semantics | FILE-001, FILE-003, PY-002 | TV-FILE-001, TV-FILE-003, TV-PY-002 |
| 6 | Observability; Security | OBS-001, PY-002 | TV-OBS-001, TV-PY-002 |
| 7 | Overview; Goals / Non-goals | NUCLEUS-001, NUCLEUS-002, MIG-001, MIG-002 | TV-NUCLEUS-001, TV-NUCLEUS-002, TV-MIG-001, TV-MIG-002 |
| 8 | Compatibility / versioning strategy; Semantics → Nucleus migration semantics | CLIENT-001, NUCLEUS-001 | TV-CLIENT-001, TV-NUCLEUS-001 |
| 9 | Goals / Non-goals; Compatibility / versioning strategy | MIG-002, NUCLEUS-002 | TV-MIG-002, TV-NUCLEUS-002 |
| 10 | Context; Semantics → Nucleus migration semantics | MIG-001 | TV-MIG-001 |
| 11 | Public API → Storage-router plugin surface; Semantics → Storage routing semantics | STORAGE-001 | TV-STORAGE-001 |
| 12 | Public API → Viewer package surface; Public API → Render descriptor response shape | VIEW-001 | TV-VIEW-001 |
| 13 | Semantics → Render/view semantics; Semantics → Nucleus migration semantics | VIEW-001, VIEW-002, NUCLEUS-001 | TV-VIEW-001, TV-VIEW-002, TV-NUCLEUS-001 |
| 14 | Semantics → Offline/local preview semantics | CLIENT-002 | TV-CLIENT-002 |
| 15 | Semantics → Offline/local preview semantics; Semantics → Render/view semantics | CLIENT-002, VIEW-002 | TV-CLIENT-002, TV-VIEW-002 |
| 16 | Public API → Client surface; Semantics → Offline/local preview semantics | CLIENT-003 | TV-CLIENT-003 |
| 17 | Public API → Canonical artifact kinds; Semantics → Processing semantics | PROCESS-002 | TV-PROCESS-002 |
| 18 | Public API → Canonical artifact kinds; Semantics → Processing semantics | PROCESS-002 | TV-PROCESS-002 |
| 19 | Goals / Non-goals; Semantics → Upload/session/auth semantics | UPLOAD-001, UPLOAD-002 | TV-UPLOAD-001, TV-UPLOAD-002 |
| 20 | Data formats / protocol | API-001 | TV-API-001 |
| 21 | Data formats / protocol; Invariants | FILE-002 | TV-FILE-002 |
| 22 | Security; Semantics → Upload/session/auth semantics; Semantics → Render/view semantics | AUTH-002, FILE-002, VIEW-002 | TV-AUTH-002, TV-FILE-002, TV-VIEW-002 |
| 23 | Semantics → Metadata semantics | META-001 | TV-META-001 |
| 24 | Public API → TypeScript server surface; Semantics → Storage routing semantics | STORAGE-001, POLICY-001 | TV-STORAGE-001, TV-POLICY-001 |
| 25 | Public API → Storage-router plugin surface; Semantics → Storage routing semantics | STORAGE-001 | TV-STORAGE-001 |
| 26 | Limits/caps; Semantics → Storage routing semantics | POLICY-001 | TV-POLICY-001 |
| 27 | Data formats / protocol → Render intent selection; Semantics → Render/view semantics | VIEW-001, VIEW-002 | TV-VIEW-001, TV-VIEW-002 |
| 28 | Semantics → Nucleus migration semantics; Compatibility / versioning strategy | CLIENT-001, NUCLEUS-001 | TV-CLIENT-001, TV-NUCLEUS-001 |
| 29 | Semantics → Render/view semantics; Compatibility / versioning strategy | VIEW-001, VIEW-002, NUCLEUS-001 | TV-VIEW-001, TV-VIEW-002, TV-NUCLEUS-001 |
| 30 | Data formats / protocol → Legacy migration manifest; Invariants | MIG-001 | TV-MIG-001 |
| 31 | Data formats / protocol → Legacy migration manifest; Observability | MIG-002 | TV-MIG-002 |
| 32 | Context; Semantics → Nucleus migration semantics | MIG-002 | TV-MIG-002 |
| 33 | Compatibility / versioning strategy | NUCLEUS-002 | TV-NUCLEUS-002 |
| 34 | Context; Public API → Python package | PY-001, PY-002, PY-003 | TV-PY-001, TV-PY-002, TV-PY-003 |
| 35 | Public API → Package boundaries; Public API → Viewer package surface | VIEW-001, BUILD-001 | TV-VIEW-001, TV-BUILD-001 |
| 36 | Assumptions; Compatibility / versioning strategy | VIEW-001, NUCLEUS-001 | TV-VIEW-001, TV-NUCLEUS-001 |
| 37 | Goals / Non-goals; Observability | DEMO-001 | TV-DEMO-001 |
| 38 | Undefined / Explicitly user-deferred only | All requirements + explicit Undefined list | N/A |

## Final audit result
No missing intent items.

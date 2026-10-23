# INTENT AUDIT

## Source Material
- Conversation context: searchfn adapter architecture + DataFn integration + production-readiness audit corrections
- Existing codebase: `searchfn/client/src/`, `datafn/server/src/`, `datafn/client/src/`
- Existing spec bundle: `searchfn/.conduct/specs/2026-03-08-new-q4k7m2r8-spec/*`
- Audit findings applied: `/Users/serro/Documents/dev/n/superfunctions/.conduct/audits/2026-03-08-p7m2x9k4-full-audit.md`

## Intent Inventory

### Core architecture intent

| # | Intent Item | SPEC.md Section | Requirement IDs | Test Vectors |
|---|---|---|---|---|
| 1 | Core engine internals shared across adapters | §1, §14 | CORE-004 | TV-CORE-003 |
| 2 | Memory and IndexedDB are first-class adapters | §5.2, §5.3 | CORE-002, CORE-003 | TV-MEM-*, TV-IDB-* |
| 3 | Unified adapter contract for all backends | §5.1 | CORE-001 | TV-CORE-001, TV-CORE-002 |
| 4 | External adapter surface exists (stub-level in this spec) | §5.4 | CORE-011 | TV-STUB-001 |

### DataFn integration intent

| # | Intent Item | SPEC.md Section | Requirement IDs | Test Vectors |
|---|---|---|---|---|
| 5 | Dedicated `SearchProvider` (not `DatafnPlugin`) | §5.5 | PROV-001 | TV-PROV-001 |
| 6 | Config-slot integration on server/client (`searchProvider`) | §5.6 | PROV-002, PROV-003 | TV-PROV-002, TV-PROV-003 |
| 7 | `createSearchProvider(adapter)` bridge | §5.7 | PROV-004 | TV-PROV-004, TV-PROV-005 |
| 8 | `searchAll` fallback in provider bridge | §7.4 | PROV-005 | TV-FALL-001, TV-FALL-002, TV-FALL-003 |
| 9 | Built-in mutation index wiring (fail-soft) | §7.6 | PROV-006 | TV-HOOK-001, TV-HOOK-002 |
| 10 | Built-in sync index wiring | §7.7 | PROV-007 | TV-SYNC-001 |
| 11 | Clone deferral + async rebuild lifecycle for local-first scale | §7.7 | PROV-012 | TV-SYNC-002, TV-REIDX-001 |
| 12 | Provider lifecycle init/dispose | §7.8 | PROV-008, PROV-009 | TV-INIT-001, TV-DISP-001 |
| 13 | Single-resource DFQL search uses provider | §7.9 | PROV-011 | TV-DFQL-001 |

### Cross-resource search and endpoint intent

| # | Intent Item | SPEC.md Section | Requirement IDs | Test Vectors |
|---|---|---|---|---|
| 14 | First-class `DatafnServer.search()` | §5.8, §7.5 | XSRC-001 | TV-XSRV-001, TV-XSRV-002, TV-XSRV-003 |
| 15 | First-class `DatafnClient.search()` | §5.8, §7.5 | XSRC-002 | TV-XCLI-001, TV-XCLI-002, TV-OFFL-001 |
| 16 | `POST /datafn/search` route | §5.9 | XSRC-003 | TV-HTTP-001, TV-HTTP-002, TV-HTTP-003, TV-HTTP-004 |
| 17 | Per-resource post-candidate filtering | §7.5, §9 | XSRC-004 | TV-FILT-001 |
| 18 | Hydration from DB + select projection | §7.5 | XSRC-005 | TV-HYDR-001 |
| 19 | AbortSignal behavior | §7.5 | XSRC-006 | TV-ABRT-001 |
| 20 | Offline behavior is canonical and deterministic | §7.5 | XSRC-007, PROV-010 | TV-OFFL-001, TV-NOPROV-001, TV-NOPROV-002 |

### End-state search use-case intent (no migration mechanics)

| # | Intent Item | SPEC.md Section | Requirement IDs | Test Vectors |
|---|---|---|---|---|
| 21 | Empty query boundary (`.search()` not recents/default API) | §7.5, §7.10 | XSRC-008 | TV-HTTP-003, TV-USEC-001 |
| 22 | Linking-search profile via scoped/bounded `.search()` | §7.10 | XSRC-009 | TV-USEC-002 |
| 23 | Highlighting/strict behavior boundary is explicitly client-side | §4, §7.10 | XSRC-010 | TV-USEC-003 |

### Reliability, determinism, compatibility intent

| # | Intent Item | SPEC.md Section | Requirement IDs | Test Vectors |
|---|---|---|---|---|
| 24 | Deterministic ordering and tie-breaks | §6.3, §8 | DET-001 | TV-DET-001 |
| 25 | Canonical error mapping across entry points | §6.4, §8 | DET-002 | TV-ERR-001 |
| 26 | Query/resource/filter caps | §10 | VLIM-001, VLIM-002, VLIM-004 | TV-VLIM-001, TV-VLIM-003, TV-VLIM-005, TV-VLIM-006 |
| 27 | Deterministic large-batch indexing behavior | §10 | VLIM-003 | TV-VLIM-004 |
| 28 | Backward compatibility for `InMemorySearchFn` + `SearchFn` core and advanced APIs | §12 | BKWD-001, BKWD-002 | TV-BKWD-001, TV-BKWD-002, TV-BKWD-004 |
| 29 | Export-surface compatibility guard | §12 | BKWD-003 | TV-BKWD-003, TV-BKWD-005 |
| 30 | DataFn plugin-search migration completeness | §12 | BKWD-004 | TV-MIGR-001 |

---

## Coverage Summary

**Total intent items**: 30

**Covered in spec**: 30/30

**Missing intent items**: None

All intent items are covered by SPEC sections, requirement IDs, and test vectors.

**No missing intent items.**

---

## Corrective Edits Made (This Update)

1. Resolved fallback conflict with a canonical no-provider policy (server DB-native-or-unsupported; offline client unsupported).
2. Repaired traceability by adding missing `TV-XSRV-*` and `TV-XCLI-*` vectors and wiring references.
3. Added end-state search use-case requirements: empty-query boundary, linking profile, strict/highlight boundary.
4. Added local-first clone deferral + async rebuild lifecycle requirements and vectors.
5. Added determinism requirements (stable tie-break, canonical error mapping) and vectors.
6. Strengthened compatibility requirements for advanced `SearchFn` APIs and export-baseline checks.
7. Added resources/filter complexity caps and corresponding validation vectors.

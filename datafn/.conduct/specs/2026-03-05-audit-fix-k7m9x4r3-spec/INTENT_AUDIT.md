# INTENT AUDIT

## Source Material

- **Primary**: `datafn/.conduct/audit-2026-03-05-error-handling.md` — audit report with 24 findings
- **Trigger**: `datafn/.conduct/issues/2026-03-03-r4k7m9x3-issue.md` — original issue

## Intent Inventory

Extracted from the audit report, organized by finding:

### CRITICAL Findings (C-01 through C-05)

| # | Intent | SPEC.md Coverage | Requirements | Test Vectors | Phase |
|---|--------|-----------------|--------------|--------------|-------|
| 1 | C-01: Pass `logger` to `executeMutation()` in mutation route | Semantics → Logging Rules | LOG-001 | TV-LOG-001 | PHASE_00 |
| 2 | C-02: Pass `logger` to `executeTransaction()` in transact route | Semantics → Logging Rules | LOG-002 | TV-LOG-002 | PHASE_00 |
| 3 | C-03: Pass `logger` to `executeReconcile()` in sync route | Semantics → Logging Rules | LOG-003 | TV-LOG-003 | PHASE_00 |
| 4 | C-04: Add `logger` param to `executeClone()` + pass from caller | Semantics → Logging Rules | LOG-004 | TV-LOG-004 | PHASE_01 |
| 5 | C-05: Add `logger` param to `createRestRoutes()` + log in REST handlers | Semantics → Logging Rules | LOG-005 | TV-LOG-005 | PHASE_01 + PHASE_02 |

### HIGH Findings (H-01 through H-07)

| # | Intent | SPEC.md Coverage | Requirements | Test Vectors | Phase |
|---|--------|-----------------|--------------|--------------|-------|
| 6 | H-01: Add `logger` to `DbDataStore.create()` and `forPushdownResult()` + log in 12+ catches | Semantics → Logging Rules | LOG-006, LOG-014 | TV-LOG-006, TV-LOG-014 | PHASE_01 + PHASE_02 |
| 7 | H-02: Add logging to `executeClone` 5 bare catch blocks | Semantics → Error Propagation | LOG-008 | TV-LOG-008 | PHASE_02 |
| 8 | H-03: Add logging to `executeReconcile` 2 catch blocks | Semantics → Error Propagation | LOG-009 | TV-LOG-009 | PHASE_02 |
| 9 | H-04: Log non-duplicate errors in `idempotency-db.ts set()` | Semantics → Logging Rules | LOG-010 | TV-LOG-010 | PHASE_01 + PHASE_02 |
| 10 | H-05: Propagate errors in `getLatestServerSeq()` instead of returning 0 | Semantics → Error Propagation | SEQ-001 | TV-SEQ-001 | PHASE_02 |
| 11 | H-06: Propagate errors in `getCurrent()` instead of returning 0 | Semantics → Error Propagation | SEQ-002 | TV-SEQ-002 | PHASE_02 |
| 12 | H-07: Add `logger?.error()` to outer catch in `executeMutationCore` | Semantics → Logging Rules | LOG-007 | TV-LOG-007 | PHASE_00 |

### MEDIUM Findings (M-01 through M-08)

| # | Intent | SPEC.md Coverage | Requirements | Test Vectors | Phase |
|---|--------|-----------------|--------------|--------------|-------|
| 13 | M-01: Generic "Internal error" returned to client across all routes | Non-goals | N/A (intentional) | N/A | N/A — out of scope |
| 14 | M-02: Push inner catch blocks — logged but generic to client | Non-goals | N/A (intentional) | N/A | N/A — out of scope |
| 15 | M-03: `recordChangeWithRetry` — retry loop with no logging | Semantics → Logging Rules | LOG-011 | TV-LOG-011 | PHASE_01 + PHASE_02 |
| 16 | M-04: `executeTransaction` — DB errors not logged when logger undefined | Semantics → Logging Rules | LOG-002 (fixes root cause) | TV-LOG-002 | PHASE_00 |
| 17 | M-05: WebSocket `handleMessage` — bare catch discards all errors | Semantics → Logging Rules | WS-002 | TV-WS-002 | PHASE_03 |
| 18 | M-06: WebSocket heartbeat ping — no logging on failure | Semantics → Logging Rules | WS-001 | TV-WS-001 | PHASE_03 |
| 19 | M-07: HTTP middleware `readBodyWithLimit` — error swallowed | Semantics → Logging Rules | LOG-013 | TV-LOG-013 | PHASE_01 + PHASE_02 |
| 20 | M-08: `server.ts` rate limit key extractor — namespace provider errors swallowed | Semantics → Logging Rules | LOG-012 | TV-LOG-012 | PHASE_02 |

### LOW Findings (L-01 through L-04)

| # | Intent | SPEC.md Coverage | Requirements | Test Vectors | Phase |
|---|--------|-----------------|--------------|--------------|-------|
| 21 | L-01: `idempotency-db.ts` JSON.parse catch too broad | Semantics → Logging Rules | IDEM-001 | TV-IDEM-001 | PHASE_03 |
| 22 | L-02: WebSocket `close()` — client close errors swallowed | Semantics → Logging Rules | WS-003 | TV-WS-003 | PHASE_03 |
| 23 | L-03: Sequence store CAS retry — intermediate failures not logged | Semantics → Logging Rules | CAS-001 | TV-CAS-001 | PHASE_03 |
| 24 | L-04: Change tracking CAS retry — intermediate failures not logged | Semantics → Logging Rules | CAS-002 | TV-CAS-002 | PHASE_03 |

---

## Coverage Summary

| Audit Finding | Covered by Requirement(s) | Phase |
|---------------|--------------------------|-------|
| C-01 | LOG-001 | PHASE_00 |
| C-02 | LOG-002 | PHASE_00 |
| C-03 | LOG-003 | PHASE_00 |
| C-04 | LOG-004 | PHASE_01 |
| C-05 | LOG-005 | PHASE_01 + PHASE_02 |
| H-01 | LOG-006, LOG-014 | PHASE_01 + PHASE_02 |
| H-02 | LOG-008 | PHASE_02 |
| H-03 | LOG-009 | PHASE_02 |
| H-04 | LOG-010 | PHASE_01 + PHASE_02 |
| H-05 | SEQ-001 | PHASE_02 |
| H-06 | SEQ-002 | PHASE_02 |
| H-07 | LOG-007 | PHASE_00 |
| M-01 | N/A (out of scope — intentional) | — |
| M-02 | N/A (out of scope — intentional) | — |
| M-03 | LOG-011 | PHASE_01 + PHASE_02 |
| M-04 | LOG-002 (root cause fix) | PHASE_00 |
| M-05 | WS-002 | PHASE_03 |
| M-06 | WS-001 | PHASE_03 |
| M-07 | LOG-013 | PHASE_01 + PHASE_02 |
| M-08 | LOG-012 | PHASE_02 |
| L-01 | IDEM-001 | PHASE_03 |
| L-02 | WS-003 | PHASE_03 |
| L-03 | CAS-001 | PHASE_03 |
| L-04 | CAS-002 | PHASE_03 |

---

## Deferred / Out of Scope Items

| Item | Reason | Audit Finding |
|------|--------|---------------|
| M-01: Generic "Internal error" to client | Intentional security design — not leaking internal details | M-01 |
| M-02: Push inner catch blocks generic to client | Same as M-01 — logged server-side, intentionally generic to client | M-02 |
| Error correlation IDs | Desirable but separate effort per SPEC.md Non-goals | — |
| Structured error objects | Replacing `String(error)` with richer serialization is a separate concern | — |

---

## Final Audit Statement

**No missing intent items.** All 24 audit findings are covered:
- 22 findings are addressed by specific requirements and phases.
- 2 findings (M-01, M-02) are explicitly out of scope as intentional security design (generic client error messages).

Every requirement has test vectors. Every finding maps to a specific phase.

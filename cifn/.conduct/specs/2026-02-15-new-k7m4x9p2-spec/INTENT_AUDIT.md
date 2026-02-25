# CiFn Python SDK Intent Audit

## Intent source

The intent for this spec is derived from:
1. **User request**: "Create a detailed and thorough specification for creating the thin wrapper Python library for cifn" — the user explicitly scoped this as a thin wrapper (HTTP client) for the existing TypeScript control plane API.
2. **cifn/SPEC.md** (root): States "Optional Python SDK" and "Python SDK (later)" in file layout.
3. **cifn/.conduct/specs/2026-02-05-new-c8f2n1xq-spec/SPEC.md**: Lines 36 and 257 state "Optional Python SDK. Not required for spec completeness; MAY be added in a later phase."
4. **Ecosystem patterns**: Observed from authfn/python, cachefn/python, sendfn/python — consistent structure with pydantic, hatchling, async-first, factory pattern.

---

## Intent Inventory

| # | Intent item | Source |
|---|------------|--------|
| I-01 | Python package wrapping CiFn control plane HTTP API | User request + cifn/SPEC.md line 251 ("python/ Python SDK (later)") |
| I-02 | Thin wrapper — HTTP client only, not server reimplementation | User request ("thin wrapper") |
| I-03 | Typed Pydantic models for all API types (PipelineSpec, Run, Job, Step, triggers, responses) | Derived from TypeScript type exports in control-plane/src/index.ts |
| I-04 | Async-first HTTP client using httpx | Ecosystem convention (cachefn, sendfn patterns) |
| I-05 | Sync wrappers for non-async usage | Ecosystem convention (cachefn memoize pattern) |
| I-06 | Exception hierarchy mapping CiFn error codes | Derived from TypeScript error codes in api/envelope.ts |
| I-07 | Envelope unwrapping (ok/data vs ok/error) | CiFn API protocol (SPEC.md "Response envelope") |
| I-08 | Factory function pattern (`create_cifn()`) | Ecosystem convention (create_auth, create_cache) |
| I-09 | Config class with Pydantic BaseModel | Ecosystem convention |
| I-10 | Credential redaction in repr/str | Security best practice |
| I-11 | camelCase ↔ snake_case alias support | Ecosystem convention (Field alias + populate_by_name) |
| I-12 | All control plane endpoints: POST /runs, GET /runs, GET /runs/:id, POST /runs/:id/cancel, GET /runs/:id/jobs/:key/logs, GET /runs/:id/artifacts | TypeScript routes.ts |
| I-13 | Runner endpoints: POST /runners/register, POST /runners/heartbeat | TypeScript routes.ts |
| I-14 | Health endpoint: GET /health | TypeScript server.ts |
| I-15 | GitHub webhook endpoint: POST /webhooks/github | TypeScript routes.ts |
| I-16 | Context manager support (async with) | httpx best practice |
| I-17 | Minimal dependencies (pydantic + httpx only) | User said "thin wrapper" |
| I-18 | Follow ecosystem conventions (hatchling, ruff, black, mypy, pytest-asyncio) | Observed from cachefn/python/pyproject.toml |
| I-19 | Connection lifecycle management (close) | httpx best practice |
| I-20 | Limit clamping on list_runs (1-100) | CiFn API spec: GET /runs limit max 100 |

---

## Coverage matrix

| Intent # | SPEC.md section | Requirements | Test vectors | Phase |
|----------|----------------|--------------|--------------|-------|
| I-01 | Overview | PKG-001, PKG-002 | TV-PKG-001, TV-PKG-002 | 00 |
| I-02 | Overview, Non-goals | (scoping) | N/A | N/A |
| I-03 | Data formats / Type definitions | TYPE-001, TYPE-002, TYPE-003, TYPE-004, TYPE-006, TYPE-007 | TV-TYPE-001 through TV-TYPE-009 | 00 |
| I-04 | Public API / Semantics | CLIENT-001 | TV-CLIENT-001 | 02 |
| I-05 | Public API (sync wrappers) | SYNC-001, SYNC-002 | TV-SYNC-001, TV-SYNC-002 | 03 |
| I-06 | Data formats (enums, errors) | TYPE-005, ENV-002 | TV-ENV-003, TV-ENV-006 | 01 |
| I-07 | Semantics (Envelope unwrapping) | ENV-001 | TV-ENV-001, TV-ENV-002, TV-ENV-004, TV-ENV-005 | 02 |
| I-08 | Public API (Factory function) | CFG-002 | TV-CFG-004 | 02 |
| I-09 | Public API (Configuration) | CFG-001 | TV-CFG-001, TV-CFG-002, TV-CFG-003 | 02 |
| I-10 | Security | CFG-003, SEC-001, SEC-002 | TV-SEC-001, TV-SEC-002 | 02 |
| I-11 | Data formats (Serialization) | TYPE-006 | TV-TYPE-008 | 00 |
| I-12 | Public API (Run management) | CLIENT-002 through CLIENT-007 | TV-CLIENT-002 through TV-CLIENT-015 | 02 |
| I-13 | Public API (Runner management) | CLIENT-008, CLIENT-009 | TV-CLIENT-016 through TV-CLIENT-019 | 02 |
| I-14 | Public API (Health) | CLIENT-010 | TV-CLIENT-020, TV-CLIENT-021 | 02 |
| I-15 | Public API (Webhooks) | (mentioned in SPEC.md, no formal requirement — webhook triggering is a convenience method) | N/A | 02 |
| I-16 | Semantics (Connection lifecycle) | CLIENT-001 | (tested in test_client.py context manager tests) | 02 |
| I-17 | Overview (Hard constraints) | PKG-002 | TV-PKG-002 | 00 |
| I-18 | (pyproject.toml) | PKG-001, PKG-004 | N/A (tooling check) | 00, 03 |
| I-19 | Semantics (Connection lifecycle) | CLIENT-001 | (tested in context manager tests) | 02 |
| I-20 | Semantics / Limits | CLIENT-003 | TV-CLIENT-006 | 02 |

---

## Gap analysis

### I-15 (GitHub webhook trigger)
The SPEC.md mentions `trigger_github_webhook()` as a convenience method, but no formal requirement (CLIENT-xxx) was created for it.

**Resolution**: This is intentionally light. The method is documented in SPEC.md Public API. It is a simple POST forwarding. The `_request()` envelope handler covers the mechanics. No dedicated requirement needed; it's covered implicitly by CLIENT-001 (httpx setup) and ENV-001 (envelope handling). A test SHOULD be added in Phase 02 as part of `test_client.py`.

### No missing intent items

All 20 intent items are covered by at least one SPEC.md section, one requirement ID, and (where applicable) one or more test vectors. The webhook trigger (I-15) has lighter formal coverage but is addressed in the implementation plan.

**Final status: No missing intent items.**

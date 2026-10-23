# Intent audit (audit-fix: k7n2m9p4)

This document maps the extracted intent (from the issue report + audit report) to coverage in this spec bundle.

## Intent Inventory (extracted from authoritative inputs)
1. Fix client upload init payload field names (`size`/`mimeType`), not `fileSize`/`contentType`.
2. Fix client parsing of server responses: server uses `{ ok: true, data: ... }`; client must unwrap `data` (avoid `uploadSessionId === undefined`).
3. Preserve canonical JSON envelopes and stable error codes so clients can reliably handle errors.
4. Implement proxy upload fallback when signed upload URLs are unsupported.
5. Implement proxy download streaming/URLs when signed download URLs are unsupported.
6. Capability-gate upload/download paths; do not call unsupported adapter methods.
7. Enforce authorization using the audited `Authorizer` interface across upload/file/version routes, including replace-by-fileId.
8. Implement `GET /` to list files accessible to the principal (owned/public/shared/granted), and do not leak private files.
9. Implement missing server routes: `GET /policies`, `GET /quota/storage` (when supported), `GET /:fileId/versions/:versionId`.
10. Fix version binding: version metadata/download must verify `versionId` belongs to `fileId`.
11. Implement idempotency semantics for init, part completion, and complete; add deterministic conflict behavior.
12. Validate uploaded bytes at completion when provider constraints can’t be enforced; reject size mismatches deterministically.
13. Provide GC/cleanup entrypoint for expired sessions and abort multipart uploads when supported.
14. Align `@superfunctions/db` `KVStoreAdapter` API with audited spec (ttlSeconds, optional incr).
15. Align `@superfunctions/middleware` RateLimiter API with audited spec and ensure FileFn uses ISO resetAt.
16. Fix event naming to audited spec (`file:uploaded`, `file:deleted`) and ensure payload does not leak signed URLs.
17. Integrate LogFn logger support while preserving correlation IDs and redacting secrets.
18. Trigger processing on upload completion; when FlowFn is provided, enqueue jobs idempotently.
19. Make Azure storage adapter stateless (no per-instance mutable upload maps).
20. Wire deduplication config/behavior so identical bytes within a tenant are deduplicated; cross-tenant dedupe is forbidden.

---

## Coverage mapping

### 1) Init payload field names
- SPEC.md coverage: Public API → “Upload init request”; Semantics → “Client ↔ server contract”
- Requirements: CLIENT-001, SERVER-002
- Test vectors: TV-UPLOAD-INIT-001, TV-CLIENT-UPLOAD-001

### 2) Client envelope unwrapping
- SPEC.md coverage: Semantics → “Client ↔ server contract”; Public API → “Canonical HTTP envelopes”
- Requirements: CLIENT-001
- Test vectors: TV-CLIENT-ENVELOPE-UNWRAP-001

### 3) Canonical envelopes + stable error codes
- SPEC.md coverage: Public API → “Canonical HTTP envelopes”; Data formats / protocol
- Requirements: SERVER-002, POLICY-001
- Test vectors: TV-UPLOAD-INIT-NEG-001 (stable code), TV-UPLOAD-INIT-NEG-002

### 4) Proxy upload fallback
- SPEC.md coverage: Public API → “Proxy upload data-plane”; Semantics → “Upload mode selection” and “Proxy upload semantics”
- Requirements: UPLOAD-005
- Test vectors: TV-UPLOAD-PROXY-001, TV-UPLOAD-MODE-NEG-001

### 5) Proxy download streaming/URLs
- SPEC.md coverage: Public API → “Proxy download data-plane”; Semantics → “Proxy download semantics”
- Requirements: FILE-002
- Test vectors: TV-FILE-DOWNLOAD-PROXY-001

### 6) Capability gating
- SPEC.md coverage: Semantics → “Upload mode selection”
- Requirements: STORAGE-002, UPLOAD-005, FILE-002
- Test vectors: TV-STORAGE-CAP-NEG-001

### 7) Authorization enforcement (including replace)
- SPEC.md coverage: Semantics → “Authorization enforcement”; Security
- Requirements: AUTHZ-001, FILE-004
- Test vectors: TV-VERSION-REPLACE-NEG-001, TV-FILE-GET-NEG-001

### 8) Accessible list semantics
- SPEC.md coverage: Semantics → “Authorization enforcement”
- Requirements: FILE-001
- Test vectors: TV-FILE-LIST-001, TV-FILE-LIST-NEG-001

### 9) Missing routes (/policies, /quota/storage, version metadata)
- SPEC.md coverage: Public API → “Routes”; Semantics (overall)
- Requirements: SERVER-002, POLICY-001, VERSION-001
- Test vectors: TV-POLICY-LIST-001, TV-QUOTA-GET-001, TV-VERSION-GET-001

### 10) Version binding
- SPEC.md coverage: Semantics → “Version binding”; Security
- Requirements: VERSION-001
- Test vectors: TV-VERSION-DOWNLOAD-BINDING-NEG-001

### 11) Idempotency semantics
- SPEC.md coverage: Semantics → “Idempotency”
- Requirements: UPLOAD-004
- Test vectors: TV-IDEMPOTENCY-001, TV-IDEMPOTENCY-NEG-001, TV-UPLOAD-PART-COMPLETE-IDEMP-001, TV-UPLOAD-PART-COMPLETE-IDEMP-NEG-001, TV-UPLOAD-COMPLETE-IDEMP-001, TV-UPLOAD-COMPLETE-IDEMP-NEG-001

### 12) Completion-time size validation
- SPEC.md coverage: Semantics → “Idempotency” (completion validation) and Proxy upload semantics
- Requirements: STORAGE-005
- Test vectors: TV-UPLOAD-COMPLETE-VALIDATE-SIZE-NEG-001

### 13) Expiration + GC
- SPEC.md coverage: Limits / caps (TTL defaults); Semantics → “Idempotency” (expiry behavior)
- Requirements: UPLOAD-006
- Test vectors: TV-UPLOAD-EXPIRE-001, TV-UPLOAD-GC-001, TV-UPLOAD-GC-NEG-001

### 14) KVStoreAdapter API alignment
- SPEC.md coverage: Public API → “Shared package APIs (conformance)”
- Requirements: PKG-007
- Test vectors: TV-KVSTORE-001, TV-KVSTORE-NEG-001

### 15) RateLimiter API alignment + ISO resetAt
- SPEC.md coverage: Public API → “Shared package APIs (conformance)”; Semantics → “Rate limiting”
- Requirements: PKG-006, RATE-001
- Test vectors: TV-RATE-001, TV-RATE-NEG-001

### 16) Canonical event names + no signed URLs
- SPEC.md coverage: Observability
- Requirements: PROCESS-001
- Test vectors: TV-OBS-001, TV-OBS-NEG-001

### 17) Logger integration + redaction
- SPEC.md coverage: Observability
- Requirements: OBS-001
- Test vectors: TV-OBS-LOG-001, TV-OBS-LOG-NEG-001, TV-OBS-REDACTION-001

### 18) Processing on completion + FlowFn enqueue
- SPEC.md coverage: Semantics → “Processing trigger”
- Requirements: PROCESS-003
- Test vectors: TV-PROCESS-001, TV-PROCESS-NEG-001, TV-PROCESS-FLOW-001, TV-PROCESS-FLOW-NEG-001

### 19) Azure adapter statelessness
- SPEC.md coverage: Overview/Context (storage adapters) + Invariants
- Requirements: STORAGE-001
- Test vectors: TV-STORAGE-AZURE-STATELESS-001

### 20) Deduplication wiring + tenant scoping
- SPEC.md coverage: Semantics → “Deduplication”
- Requirements: DEDUPE-001
- Test vectors: TV-DEDUP-001, TV-DEDUP-NEG-001

---

## Final audit result
No missing intent items.

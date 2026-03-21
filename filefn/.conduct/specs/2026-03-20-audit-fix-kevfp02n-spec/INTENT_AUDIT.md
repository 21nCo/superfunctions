# INTENT_AUDIT.md

This intent audit was derived from the authoritative inputs for this bundle:
- the 2026-03-20 full FileFn audit report
- `filefn/python/README.md`
- `filefn/examples/full-demo/README.md`
- the two prior FileFn spec bundles

## Intent Inventory
1. The unresolved 2026-03-20 audit findings MUST all be fixed, not selectively deferred.
2. `@filefn/server` MUST be production-build green, not merely test-green.
3. Upload-session follow-up operations MUST be bound to the initiating caller.
4. Anonymous upload flows MUST remain secure if authentication is optional.
5. Browser resumable uploads MUST work against the real server payload shape.
6. Upload mode selection MUST never advertise unsupported bare `signed-url` behavior.
7. Proxy upload MUST remain a first-class supported fallback.
8. File listing MUST be deterministic and access-filtered.
9. Version-aware reads/downloads MUST honor `versionId` everywhere, including provider APIs.
10. Share and artifact downloads MUST return real HTTP URLs, not placeholders.
11. Artifact list/download MUST obey read authorization.
12. Delete MUST clean related metadata, not only file/version rows.
13. Delete MUST remain correct when dedupe causes multiple logical references to one storage key.
14. Dedupe MUST be tenant-scoped and publicly configurable.
15. Rate limiting MUST support route categories and ISO reset information.
16. Processing enqueue MUST be idempotent and artifact access MUST be secured.
17. Observability MUST preserve request IDs and redact secrets without over-redaction.
18. `@filefn/client` MUST publish under the canonical package boundary.
19. `@superfunctions/files` MUST have executable conformance tests.
20. The Python package MUST match its README’s core claims.
21. Python auth/rate-limit/dedup config MUST be real, not placeholder.
22. Python wire semantics MUST match TypeScript semantics.
23. Python processing/storage protocol usage MUST be internally consistent.
24. Python MUST have executable tests, not just syntax checks.
25. The full demo MUST actually exercise upload/list/download/delete successfully.
26. Canonical envelopes and stable error codes remain mandatory.
27. No public response may return `proxy://...`.
28. Anything not explicitly fixed in this bundle remains governed by prior FileFn specs.

## Coverage mapping
| Intent # | Covered in SPEC.md | Requirement IDs | Test vectors |
|---|---|---|---|
| 1 | Overview; Goals / Non-goals | BUILD-001, PKG-001, API-001, AUTH-001, AUTH-002, UPLOAD-001..005, FILE-001..004, DEDUPE-001, RATE-001, PROCESS-001, OBS-001, CLIENT-001..002, PY-001..003, DEMO-001 | TV-BUILD-001, TV-BUILD-NEG-001 |
| 2 | Overview; Public API; Compatibility / versioning strategy | BUILD-001 | TV-BUILD-001, TV-BUILD-NEG-001 |
| 3 | Semantics → Authentication and upload-session binding | AUTH-001 | TV-UPLOAD-AUTH-001, TV-UPLOAD-AUTH-NEG-001 |
| 4 | Semantics → Authentication and upload-session binding | AUTH-001 | TV-UPLOAD-AUTH-001, TV-UPLOAD-AUTH-NEG-001 |
| 5 | Public API → FileProvider conformance; Data formats / protocol → Upload status success data | UPLOAD-001, CLIENT-001 | TV-UPLOAD-STATUS-001, TV-UPLOAD-STATUS-NEG-001, TV-CLIENT-001 |
| 6 | Semantics → Upload mode selection | UPLOAD-002 | TV-UPLOAD-MODE-001, TV-UPLOAD-MODE-NEG-001 |
| 7 | Public API → HTTP routes; Semantics → Proxy upload semantics | UPLOAD-003 | TV-UPLOAD-PROXY-001, TV-UPLOAD-PROXY-NEG-001 |
| 8 | Semantics → List semantics | FILE-001 | TV-FILE-LIST-001, TV-FILE-LIST-NEG-001 |
| 9 | Semantics → Version and artifact binding; Public API → FileProvider conformance | FILE-002, AUTH-002 | TV-VERSION-001, TV-VERSION-NEG-001, TV-ACCESS-001 |
| 10 | Public API → HTTP routes; Data formats / protocol → Download descriptor success data | FILE-003 | TV-DOWNLOAD-FALLBACK-001, TV-DOWNLOAD-FALLBACK-NEG-001 |
| 11 | Semantics → Version and artifact binding; Security | AUTH-002, PROCESS-001 | TV-ACCESS-001, TV-ACCESS-NEG-001, TV-PROCESS-001 |
| 12 | Semantics → Delete and cleanup semantics | FILE-004 | TV-DELETE-CASCADE-001, TV-DELETE-CASCADE-NEG-001 |
| 13 | Semantics → Delete and cleanup semantics; Deduplication semantics | FILE-004, DEDUPE-001 | TV-DELETE-CASCADE-001, TV-DEDUP-001 |
| 14 | Public API → `@filefn/server` TypeScript surface; Semantics → Deduplication semantics | DEDUPE-001 | TV-DEDUP-001, TV-DEDUP-NEG-001 |
| 15 | Public API → `@filefn/server` TypeScript surface; Semantics → Rate limiting semantics | RATE-001 | TV-RATE-001, TV-RATE-NEG-001 |
| 16 | Semantics → Processing semantics | PROCESS-001 | TV-PROCESS-001, TV-PROCESS-NEG-001 |
| 17 | Observability; Security | OBS-001 | TV-OBS-001, TV-OBS-NEG-001 |
| 18 | Public API → Package boundaries; Browser client surface | PKG-001, CLIENT-001 | TV-PKG-001, TV-PKG-NEG-001, TV-CLIENT-001 |
| 19 | Public API → Package boundaries | BUILD-001, PKG-001 | TV-BUILD-001 |
| 20 | Overview; Public API → Python public surface; Semantics → Python parity semantics | PY-001, PY-002, PY-003 | TV-PY-CORE-001, TV-PY-FLOWS-001, TV-PY-TESTS-001 |
| 21 | Public API → Python public surface | PY-001 | TV-PY-CORE-001, TV-PY-CORE-NEG-001 |
| 22 | Semantics → Python parity semantics | PY-002 | TV-PY-FLOWS-001, TV-PY-FLOWS-NEG-001 |
| 23 | Semantics → Python parity semantics | PY-002 | TV-PY-FLOWS-001, TV-PY-FLOWS-NEG-001 |
| 24 | Semantics → Python parity semantics | PY-003 | TV-PY-TESTS-001, TV-PY-TESTS-NEG-001 |
| 25 | Overview; Public API → HTTP routes | DEMO-001 | TV-DEMO-001, TV-DEMO-NEG-001 |
| 26 | Data formats / protocol | API-001 | TV-ENVELOPE-001, TV-ENVELOPE-NEG-001 |
| 27 | Data formats / protocol → Download descriptor success data; Invariants | FILE-003 | TV-DOWNLOAD-FALLBACK-001, TV-DOWNLOAD-FALLBACK-NEG-001 |
| 28 | Overview; Compatibility / versioning strategy | All requirements in this bundle apply only to the unresolved audited surfaces; prior specs govern unaffected surfaces | N/A |

## Final audit result
No missing intent items.

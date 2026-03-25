# Metadata
- Timestamp (UTC): 2026-03-22T08:14:20Z
- Agent name: audit
- Model: Codex (GPT-5-based; exact version not exposed)
- Launcher: Codex Desktop
- Workspace/project (absolute): /Users/serro/Documents/dev/n/superfunctions/filefn
- OS + shell:
  - OS: Darwin ArBook.local 25.3.0 arm64
  - Shell: /bin/zsh
- Repo metadata:
  - VCS: git
  - Branch: next
  - Commit: b69090aaa83f0515924aa9b11df3b1fcd4de3a1a
  - Dirty: true (pre-existing unrelated workspace changes were present and were not modified)
- Intent/notes paths audited:
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/audits/2026-03-20-t8w3b4h3-full-audit.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/python/README.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/examples/full-demo/README.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec/SPEC.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec/REQUIREMENTS.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec/TEST_VECTORS.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec/PLAN.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec/INTENT_AUDIT.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-26-audit-fix-k7n2m9p4-spec/SPEC.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-26-audit-fix-k7n2m9p4-spec/REQUIREMENTS.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-26-audit-fix-k7n2m9p4-spec/TEST_VECTORS.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-26-audit-fix-k7n2m9p4-spec/PLAN.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-26-audit-fix-k7n2m9p4-spec/INTENT_AUDIT.md
- Spec bundle paths audited:
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-03-20-audit-fix-kevfp02n-spec
    - SPEC.md
    - REQUIREMENTS.md
    - TEST_VECTORS.md
    - PLAN.md
    - INTENT_AUDIT.md
    - phases/PHASE_00.md
    - phases/PHASE_01.md
    - phases/PHASE_02.md
    - phases/PHASE_03.md
    - phases/PHASE_04.md
    - phases/PHASE_05.md
    - phases/PHASE_06.md
    - phases/PHASE_07.md
    - phases/PHASE_08.md
    - phases/PHASE_09.md
- Codebase scope audited:
  - Primary: /Users/serro/Documents/dev/n/superfunctions/filefn
  - Shared dependency evidence: /Users/serro/Documents/dev/n/superfunctions/packages/files, /Users/serro/Documents/dev/n/superfunctions/packages/middleware, /Users/serro/Documents/dev/n/superfunctions/packages/db, /Users/serro/Documents/dev/n/superfunctions/packages/storage, /Users/serro/Documents/dev/n/superfunctions/packages/storage-azure, /Users/serro/Documents/dev/n/superfunctions/packages/storage-gcs, /Users/serro/Documents/dev/n/superfunctions/packages/storage-local, /Users/serro/Documents/dev/n/superfunctions/packages/storage-minio, /Users/serro/Documents/dev/n/superfunctions/packages/storage-r2, /Users/serro/Documents/dev/n/superfunctions/packages/storage-s3, /Users/serro/Documents/dev/n/superfunctions/uifn/files
  - Excluded from direct pass/fail except as dependency context: unrelated non-FileFn packages elsewhere in the monorepo
- Commands executed during audit:
  - `rg --files ...` over the current bundle, FileFn packages, and shared dependency packages
  - `sed -n` / `nl -ba` reads across the current bundle, prior bundle references, README inputs, prior audit, implementation files, and tests
  - `git -C /Users/serro/Documents/dev/n/superfunctions status --short --branch`
  - `git -C /Users/serro/Documents/dev/n/superfunctions branch --show-current`
  - `git -C /Users/serro/Documents/dev/n/superfunctions rev-parse HEAD`
  - `uname -a`
  - `date -u +"%Y-%m-%dT%H:%M:%SZ"`
  - `(cd filefn/server && npm test -- --run && npm run typecheck && npm run build)`
  - `(cd filefn/client && npm test -- --run && npm run typecheck && npm run build)`
  - `(cd filefn/processing && npm test -- --run && npm run typecheck && npm run build)`
  - `(cd uifn/files && npm test -- --run && npm run typecheck && npm run build)`
  - `(cd packages/files && npm test -- --run && npm run typecheck && npm run build)`
  - `(cd packages/middleware && npm test -- --run && npm run typecheck && npm run build)`
  - `(cd packages/db && npm test -- --run && npm run typecheck && npm run build)`
  - package sweeps over `packages/storage*` and `packages/storage`
  - `(cd filefn/python && python3 -m pytest)`
  - `node -p "require('.../filefn/client/package.json').name"`
  - `node -e "import('@superfunctions/files')..."`
  - Python import sanity for `filefn`, `create_file_fn`, and `FileFnConfig`
  - demo smoke run via `node filefn/examples/full-demo/smoke.mjs` against live example server/client

# Audit scope
This was a full, read-only audit of the implemented FileFn codebase against:
1. the authoritative intent named by the current audit-fix bundle, and
2. every spec file in the provided `2026-03-20-audit-fix-kevfp02n-spec` bundle.

Because the current bundle explicitly derives intent from the 2026-03-20 prior audit, the FileFn Python README, the full-demo README, and the two earlier FileFn bundles, those referenced materials were also read and used to validate intent coverage and regression expectations. No implementation code was changed during this audit. Only this report and the required log row were written.

# Inputs audited (intent + spec bundles)
## Intent / notes inputs
- `2026-03-20-t8w3b4h3-full-audit.md`
  - authoritative unresolved-findings baseline for what this bundle intended to fix
- `filefn/python/README.md`
  - authoritative shipped Python-package claims, including resumable uploads, sharing, dedupe, policies, and observability
- `filefn/examples/full-demo/README.md`
  - authoritative demo claim for upload, list, download, and delete
- prior FileFn bundle documents from `2026-01-24-new-h3m9k2s-spec` and `2026-01-26-audit-fix-k7n2m9p4-spec`
  - used to validate the carry-forward intent described in current intent item 28

## Spec bundle 1: `2026-03-20-audit-fix-kevfp02n-spec`
- `SPEC.md`
  - corrective production-readiness spec for unresolved March 20 audit gaps
- `REQUIREMENTS.md`
  - 24 requirements spanning build/package readiness, canonical envelopes, upload auth/idempotency/cleanup, file semantics, dedupe, rate limits, processing, observability, client parity, Python parity, and the demo
- `TEST_VECTORS.md`
  - golden vectors for the corrected behaviors
- `PLAN.md`
  - dependency ordering for the audit-fix work
- `INTENT_AUDIT.md`
  - 28-item intent inventory and coverage map, used as a starting point and independently validated
- `phases/PHASE_00.md` ... `phases/PHASE_09.md`
  - implementation phasing and verification expectations for each requirement cluster

# High-level findings
1. Overall verdict: the bundle is close but not fully compliant. Verification gates are green and the example demo smoke passed, but 3 requirements still fail and 5 remain partial.
2. Production-readiness gates that the bundle explicitly called out are green:
   - `filefn/server`, `filefn/client`, `filefn/processing`, `uifn/files`, `packages/files`, `packages/middleware`, `packages/db`, and all `packages/storage*` sweeps passed local test/typecheck/build verification
   - `filefn/python` collected and passed 16 tests
   - the full demo upload/list/download/delete smoke succeeded against live server and client instances
3. The remaining TypeScript P0 issue is replace-flow authorization at completion. `filefn/server/src/upload-sessions/service.ts:324-329` enforces replace authorization at init, but `completeSession()` in `filefn/server/src/upload-sessions/service.ts:666-714` never re-checks `fileWriteChecker`, so a caller who was authorized at init but no longer authorized at completion can still publish a replacement version.
4. Anonymous init idempotency is still wrong on both surfaces. In TypeScript, the replay path rotates `uploadSessionToken` instead of returning the original success payload (`filefn/server/src/upload-sessions/service.ts:284-303`). In Python, the replay path drops the token entirely (`filefn/python/filefn/server/upload_sessions/service.py:195-215`). That violates `UPLOAD-004`'s requirement to return the original success result for identical init replays.
5. Python parity is still incomplete. The highest-signal mismatches are:
   - `get_file(..., version_id=...)` validates binding but still returns the current file record rather than version-aware metadata (`filefn/python/filefn/server/files/service.py:88-102`)
   - proxy share descriptors increment download counters before proxy streaming begins (`filefn/python/filefn/server/shares/service.py:145-178`)
   - `list_files()` still uses an unsorted fixed-size prefetch with a plain `fileId` cursor (`filefn/python/filefn/server/files/service.py:104-150`)
   - `delete_file()` still omits cascade/reference-safe cleanup for permissions, shares, artifacts, and pending upload metadata (`filefn/python/filefn/server/files/service.py:196-235`)

# Intent Inventory
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

# Intent → Spec coverage matrix
| Intent # | Requirement IDs | Coverage verdict | Implementation verdict | Notes |
|---|---|---|---|---|
| 1 | BUILD-001, PKG-001, API-001, AUTH-001..002, UPLOAD-001..005, FILE-001..004, DEDUPE-001, RATE-001, PROCESS-001, OBS-001, CLIENT-001..002, PY-001..003, DEMO-001 | Covered | FAIL | Three current-bundle requirements still fail. |
| 2 | BUILD-001 | Covered | PASS | `filefn/server` test/typecheck/build all passed. |
| 3 | AUTH-001 | Covered | PASS | TS and Python bind follow-up operations to principal/tenant or anonymous session token. |
| 4 | AUTH-001 | Covered | PASS | Anonymous session tokens are minted and stored hashed on both surfaces. |
| 5 | UPLOAD-001, CLIENT-001 | Covered | PASS | TS/Python status shape and browser resume contract are aligned; tests and live demo smoke passed. |
| 6 | UPLOAD-002 | Covered | PASS | Bare `signed-url` is gone; only `multipart-signed-url` or `proxy` are selected. |
| 7 | UPLOAD-003 | Covered | PASS | Proxy upload path works end-to-end and is covered by TS/Python tests plus demo smoke. |
| 8 | FILE-001 | Covered | PARTIAL | TS satisfies deterministic ordering/cursor behavior; Python `list_files()` still uses unsorted `limit=1000` prefetch and plain cursor semantics. |
| 9 | FILE-002, AUTH-002 | Covered | PARTIAL | TS honors version binding; Python `get_file(version_id=...)` validates binding but returns current-file metadata. |
| 10 | FILE-003 | Covered | PASS | No audited public response returns `proxy://...`; TS/Python download descriptors are real HTTP/relative HTTP URLs. |
| 11 | AUTH-002, PROCESS-001 | Covered | PASS | Artifact list/download authorization is enforced on both audited surfaces. |
| 12 | FILE-004 | Covered | PARTIAL | TS delete cascade is compliant; Python delete still removes only files/fileVersions. |
| 13 | FILE-004, DEDUPE-001 | Covered | PARTIAL | TS delete is reference-safe; Python delete still performs blind physical deletion. |
| 14 | DEDUPE-001 | Covered | PASS | TS and Python public config surfaces expose dedupe; tenant scoping is covered by tests. |
| 15 | RATE-001 | Covered | PASS | Route-category limits and ISO8601 `resetAt` are implemented. |
| 16 | PROCESS-001 | Covered | PASS | Upload completion triggers processing and deterministic enqueue semantics are exercised by tests. |
| 17 | OBS-001 | Covered | PARTIAL | TS redaction/correlation behavior is covered; Python lacks equivalent redaction-specific helper/tests. |
| 18 | PKG-001, CLIENT-001 | Covered | PASS | `@filefn/client` publishes under the canonical scope. |
| 19 | BUILD-001, PKG-001 | Covered | PASS | `packages/files` now contains and runs conformance tests. |
| 20 | PY-001, PY-002, PY-003 | Covered | PARTIAL | Imports/config/tests are real, but Python behavior still diverges on version-aware reads and share/download semantics. |
| 21 | PY-001 | Covered | PASS | Python auth/rate-limit/dedup config is implemented and importable. |
| 22 | PY-002 | Covered | FAIL | Python still diverges from canonical TS semantics in multiple places. |
| 23 | PY-002 | Covered | PASS | Python processing/storage protocol usage is internally consistent in the audited code/tests. |
| 24 | PY-003 | Covered | PASS | `pytest` collected and passed 16 tests. |
| 25 | DEMO-001 | Covered | PASS | Live smoke run succeeded for upload/list/download/delete. |
| 26 | API-001 | Covered | PASS | Canonical envelopes and stable error codes are present on audited control-plane routes. |
| 27 | FILE-003 | Covered | PASS | No placeholder `proxy://...` responses were found. |
| 28 | All current-bundle requirements plus prior bundle regression expectations | Covered | PASS | Carry-forward surfaces stayed green in the regression/build sweep. |

# Requirement coverage summary
## Bundle 1: `2026-03-20-audit-fix-kevfp02n-spec`
- PASS: 16
- PARTIAL: 5
- FAIL: 3
- UNVERIFIED: 0

# Requirement-by-requirement results
| ID | Status | Evidence / notes |
|---|---|---|
| BUILD-001 | PASS | `filefn/server`, `filefn/client`, `filefn/processing`, `uifn/files`, `packages/files`, `packages/middleware`, `packages/db`, and `packages/storage*` all passed the required local verification commands; `filefn/python` ran 16 passing tests; the demo smoke passed. |
| PKG-001 | PASS | `filefn/client/package.json` publishes `@filefn/client`; `@superfunctions/files` imports cleanly; `filefn.__init__`, `filefn.server`, and `filefn.processing` export the documented Python surfaces. |
| API-001 | PASS | Canonical success/error envelopes are consistently returned on audited TS control-plane routes (`filefn/server/src/upload-sessions/routes.ts`, `filefn/server/src/files/routes.ts`, `filefn/server/src/shares/routes.ts`, `filefn/server/src/processing/routes.ts`); request IDs echo when provided. |
| AUTH-001 | PASS | TS `assertSessionAccess()` and Python `_assert_session_binding()` enforce authenticated principal/tenant binding or anonymous session-token binding across status/sign/proxy-put/complete/abort flows (`filefn/server/src/upload-sessions/service.ts:225-257`, `filefn/python/filefn/server/upload_sessions/service.py:121-149`). |
| AUTH-002 | FAIL | Replace authorization is checked at init in TS (`filefn/server/src/upload-sessions/service.ts:324-329`) but not re-checked in `completeSession()` (`filefn/server/src/upload-sessions/service.ts:666-714`). Python does re-check (`filefn/python/filefn/server/upload_sessions/service.py:528-530`), so the remaining failure is specifically on the TS surface. |
| UPLOAD-001 | PASS | TS status returns `recordedParts`, `chunkSizeBytes`, and `fileSize`; Python does the same; browser resume tests and live demo smoke both succeeded. |
| UPLOAD-002 | PASS | TS `selectUploadMode()` and Python `_select_upload_mode()` return only `multipart-signed-url` or `proxy`. |
| UPLOAD-003 | PASS | TS and Python proxy upload paths support durable part recording, idempotent retries of identical bytes, and deterministic conflicts for mismatched retries. |
| UPLOAD-004 | FAIL | Anonymous init replays do not return the original success result. TS rotates a new `uploadSessionToken` on replay (`filefn/server/src/upload-sessions/service.ts:284-303`); Python replay drops the token entirely (`filefn/python/filefn/server/upload_sessions/service.py:195-215`). |
| UPLOAD-005 | PASS | Abort/GC semantics are present and covered by TS/Python tests; proxy temp parts and multipart state are cleaned up, and completed sessions are preserved. |
| FILE-001 | PARTIAL | TS `listFiles()` is deterministic and cursor-based, but Python `list_files()` still uses unsorted `limit=1000` prefetch plus plain `fileId` pagination (`filefn/python/filefn/server/files/service.py:104-150`). |
| FILE-002 | PARTIAL | TS honors provider/file/version binding; Python `get_file(version_id=...)` checks binding but returns the current file record instead of version-aware metadata (`filefn/python/filefn/server/files/service.py:88-102`). |
| FILE-003 | PARTIAL | TS file/share/artifact download descriptors and proxy routes are compliant. Python share-link proxy descriptors increment `downloads` before proxy streaming begins (`filefn/python/filefn/server/shares/service.py:145-178`), which violates the bundle’s counter semantics. |
| FILE-004 | PARTIAL | TS delete cascade is metadata-complete and reference-safe. Python `delete_file()` still removes only file/fileVersions and blindly deletes storage keys, skipping grants, shares, artifacts, upload metadata, and dedupe/reference accounting (`filefn/python/filefn/server/files/service.py:196-235`). |
| DEDUPE-001 | PASS | TS and Python public config surfaces expose dedupe; tenant scoping and cross-tenant isolation are covered by passing tests. |
| RATE-001 | PASS | Route-category limits (`uploadInit`, `uploadSign`, `uploadComplete`, `download`, `shareDownload`, `artifactDownload`) and ISO8601 `resetAt` are implemented and tested. |
| PROCESS-001 | PASS | Upload completion triggers processing when enabled, enqueue failures surface the correct code, artifact access is bound to parent-file readability, and request IDs flow through events. |
| OBS-001 | PARTIAL | TS logger/event redaction preserves safe IDs and redacts secrets (`filefn/server/src/observability/logger.ts`, `filefn/server/src/events.ts`) with passing tests. Python has no equivalent audited redaction helper or test coverage, so full parity is not yet evidenced. |
| CLIENT-001 | PASS | Browser client now uses canonical init/status fields, handles anonymous session tokens, and supports both upload modes; tests passed and the full demo smoke exercised the live package. |
| CLIENT-002 | PASS | Offline mode tests passed, including deterministic staging/progress/abort behavior and unsupported-environment handling. |
| PY-001 | PASS | Python exports/config are real: `AuthConfig`, route-category `rate_limit`, `DedupConfig`, `ProcessingConfig`, and documented processor factories all import correctly and are covered by tests. |
| PY-002 | FAIL | Python still diverges from canonical TS semantics in version-aware reads (`filefn/python/filefn/server/files/service.py:88-102`) and proxy share-download counter timing (`filefn/python/filefn/server/shares/service.py:145-178`). Additional parity drift remains in list/delete semantics (`filefn/python/filefn/server/files/service.py:104-150`, `196-235`). |
| PY-003 | PASS | `python3 -m pytest` collected and passed 16 tests covering core flows, downloads, processing, and upload behavior. |
| DEMO-001 | PASS | Running the documented demo stack plus `node filefn/examples/full-demo/smoke.mjs` succeeded for upload, list, download, and delete. |

# Spec conflicts / spec gaps
## Conflicts across the audited inputs
- No material conflict was found inside the provided `2026-03-20-audit-fix-kevfp02n-spec` bundle.
- The current bundle consistently acts as a corrective refinement over the earlier FileFn specs rather than contradicting them.

## Spec gaps surfaced by this audit
1. The current bundle’s carry-forward rule (intent item 28) depends on earlier bundles for unaffected surfaces but does not restate those unaffected requirement IDs. That makes current-bundle pass/fail for inherited surfaces inherently regression-based.
2. `PY-002` explicitly names upload/download/share/artifact/dedupe/processing parity, but the Python public surface also includes `list_files()` and `delete_file()`. The bundle implies parity for those methods via the broader “Python semantics MUST match TypeScript semantics” statement, but does not spell them out as dedicated Python acceptance bullets.
3. `OBS-001` requires Python logging parity, but the bundle does not define a Python-side logger/redaction contract equivalent to the TS helper layer.

# Cross-cutting audits
## Security / authz / validation boundaries
- Upload-session binding is now correctly enforced on both audited surfaces.
- The remaining authz break is TS replace completion: the file write check is missing in `completeSession()`, so the authorization decision can drift between init and complete.
- Artifact read authorization is enforced on the audited TS and Python paths.
- Anonymous session tokens and share tokens are stored hashed rather than plaintext.

## Determinism invariants
- The most important determinism regression is anonymous init idempotency: the same `(idempotencyKey, payload, caller)` does not reproduce the same semantic success result.
- TS list semantics are deterministic, but Python list pagination still depends on unsorted limited prefetch and a legacy-style cursor.
- The demo smoke passing is a useful end-to-end check that the corrected TS/browser path is stable under real package wiring.

## Limits / caps
- Default chunk size, upload-session TTL, and signed URL TTL are wired on both surfaces.
- TS enforces `listFiles.limit` clamping; Python list parity still lacks the same audited semantics.
- Route-category rate limiting and ISO reset timestamps are working.

## Error handling + canonical envelopes
- TS control-plane routes consistently return canonical `{ ok, data|error, requestId }` envelopes.
- No public audited response returned `proxy://...`.
- Request ID echoing is correct when present. I did not find a generated request ID path when absent, but the bundle only uses SHOULD-level language for generation.

## Compatibility / versioning / migrations
- Package boundaries and shared conformance expectations are now aligned (`@filefn/client`, `@superfunctions/files` tests present).
- The temporary `uploadedParts` alias still exists in TS upload status; that is allowed by the current bundle as a compatibility alias.
- Python parity remains the main compatibility risk because some public methods still diverge from the canonical TS semantics.

# Recommendations
1. Fix TS replace completion auth first. Re-run `fileWriteChecker.canWriteFile(session.fileId, ctx)` inside `completeSession()` before publishing the version. Reference: intent 3, 4, 9; requirement `AUTH-002`.
2. Make anonymous init idempotency return the original success result on both surfaces. Do not rotate or drop `uploadSessionToken` on replay; persist and replay the original semantic result instead. Reference: intent 3, 4, 16, 22; requirement `UPLOAD-004`.
3. Finish Python version-aware read parity. `get_file(version_id=...)` should return metadata for the requested version, not merely validate the binding. Reference: intent 9, 22; requirements `FILE-002`, `PY-002`.
4. Fix Python proxy share counter timing. For proxy descriptors, increment `downloads` only once proxy streaming begins, matching the TS surface and current bundle semantics. Reference: intent 10, 22; requirements `FILE-003`, `PY-002`.
5. Either complete Python list/delete parity or narrow the public/documented Python surface until parity is delivered. Reference: intent 8, 12, 13, 20, 22; requirements `FILE-001`, `FILE-004`, `PY-002`.
6. Add explicit Python observability/redaction coverage so `OBS-001` is no longer only evidenced on the TS side. Reference: intent 17; requirement `OBS-001`.

# Appendix: commands run + environment details
## Verification summary
- `filefn/server`
  - `npm test -- --run`: PASS (`24` files, `189` tests)
  - `npm run typecheck`: PASS
  - `npm run build`: PASS
- `filefn/client`
  - `npm test -- --run`: PASS (`7` files, `41` tests)
  - `npm run typecheck`: PASS
  - `npm run build`: PASS
- `filefn/processing`
  - `npm test -- --run`: PASS (`4` files, `55` tests)
  - `npm run typecheck`: PASS
  - `npm run build`: PASS
- `uifn/files`
  - `npm test -- --run`: PASS (`1` file, `38` tests)
  - `npm run typecheck`: PASS
  - `npm run build`: PASS
- shared dependencies used by FileFn
  - `packages/files`: PASS (`5` tests + typecheck/build)
  - `packages/middleware`: PASS (`15` tests + typecheck/build)
  - `packages/db`: PASS (`146` tests + typecheck/build)
  - `packages/storage` and `packages/storage-*`: PASS across the audit sweep
- Python
  - `python3 -m pytest`: PASS (`16` tests collected and passed)
- Demo
  - live example server/client started on `3101` and `5174`
  - `FILEFN_DEMO_BASE_URL=http://127.0.0.1:3101/filefn FILEFN_DEMO_CLIENT_BASE=http://127.0.0.1:5174 node filefn/examples/full-demo/smoke.mjs`: PASS

## Key implementation references
- TS replace auth checked only at init:
  - `filefn/server/src/upload-sessions/service.ts:324-329`
- TS replace auth not re-checked at complete:
  - `filefn/server/src/upload-sessions/service.ts:666-714`
- TS anonymous init replay rotates token:
  - `filefn/server/src/upload-sessions/service.ts:284-303`
- Python anonymous init replay omits token:
  - `filefn/python/filefn/server/upload_sessions/service.py:195-215`
- Python version-aware read still returns current file record:
  - `filefn/python/filefn/server/files/service.py:88-102`
- Python list parity drift:
  - `filefn/python/filefn/server/files/service.py:104-150`
- Python delete parity drift:
  - `filefn/python/filefn/server/files/service.py:196-235`
- Python proxy share descriptor increments downloads immediately:
  - `filefn/python/filefn/server/shares/service.py:145-178`

## Environment details
- Working directory during audit: `/Users/serro/Documents/dev/n/superfunctions`
- Function project root: `/Users/serro/Documents/dev/n/superfunctions/filefn`
- User context date/time zone: `2026-03-22`, `Asia/Kolkata`
- UTC timestamp used for report/logging: `2026-03-22T08:14:20Z`

# Plan (audit-fix: k7n2m9p4)

## Architecture sketch
This audit-fix touches these modules/packages:

- `@filefn/client`
  - `src/client.ts`: HTTP request wrapper (canonical envelopes)
  - `src/upload-manager.ts`: upload init payload + upload mode handling
  - `src/index.ts` / `src/types.ts`: public API conformance
  - `src/offline/*`: OPFS staging + sync integration (behind config)

- `@filefn/server`
  - `src/router.ts`: route registration (add missing routes)
  - `src/upload-sessions/routes.ts` + `src/upload-sessions/service.ts`: upload modes, idempotency, proxy upload endpoints
  - `src/files/routes.ts` + `src/files/service.ts`: list accessible, proxy download URLs/streaming, version binding
  - `src/authz/*`: pluggable Authorizer interface + `composeAuthorizers` signature
  - `src/events.ts`: canonical event names
  - `src/observability/*`: LogFn logger integration + redaction rules
  - `src/processing/*`: trigger/enqueue processing on completion
  - `src/errors.ts`: add any new stable error codes required by new vectors

- Shared packages
  - `packages/db/*`: `KVStoreAdapter` exported API shape
  - `packages/middleware/*`: `createRateLimiter` and `RateLimiter.check` API shape
  - `packages/storage-azure/*`: remove per-instance mutable multipart state

## Dependency graph
1. `packages/db` KVStoreAdapter shape (PKG-007)
2. `packages/middleware` RateLimiter shape (PKG-006)
3. `@filefn/server` rateLimit integration + ISO resetAt (RATE-001)
4. `@filefn/server` canonical routes/envelopes + missing routes (SERVER-002/POLICY-001/VERSION-001)
5. `@filefn/client` envelope unwrapping + request payload alignment (CLIENT-001)
6. Authz enforcement and list accessible semantics (AUTHZ-001/FILE-001/FILE-004)
7. Proxy upload/download data-plane endpoints (UPLOAD-005/FILE-002)
8. Idempotency + completion validation + GC (UPLOAD-004/STORAGE-005/UPLOAD-006)
9. Observability: events + logging (PROCESS-001/OBS-001)
10. Processing enqueue on completion (PROCESS-003)
11. Storage-azure statelessness (STORAGE-001)
12. Offline mode integration (CLIENT-002)

## Phases overview
| Phase | Goal | Delivered capability | Verification |
|---:|---|---|---|
| 00 | Add/align conformance tests for new vectors | Failing tests that encode audit gaps | `npm test -- --filter=@filefn/server --filter=@filefn/client` (expected FAIL initially) |
| 01 | Fix client/server contract for upload init + envelope unwrapping | Upload session ID is never `undefined`; client parses envelopes | `npm test -- --filter=@filefn/client` |
| 02 | Server route/envelope completion + missing routes | `/policies`, `/quota/storage`, version metadata route | `npm test -- --filter=@filefn/server` |
| 03 | Authz interface alignment + enforcement | Replace authz fixed; list accessible fixed; version binding fixed | `npm test -- --filter=@filefn/server` |
| 04 | Implement proxy upload + proxy download endpoints | Local/proxy adapters can upload/download | `npm test -- --filter=@filefn/server --filter=@filefn/client` |
| 05 | Idempotency + size validation + GC | Repeatable init/complete; part conflict; size mismatch; cleanup entrypoint | `npm test -- --filter=@filefn/server` |
| 06 | Align KVStoreAdapter + RateLimiter APIs + FileFn rateLimit integration | Spec-compatible shared APIs and ISO resetAt | `npm test -- --filter=@superfunctions/db --filter=@superfunctions/middleware --filter=@filefn/server` |
| 07 | Observability fixes | Canonical event names + LogFn logger integration without over-redaction | `npm test -- --filter=@filefn/server` |
| 08 | Processing trigger integration | Processing is triggered on completion; FlowFn enqueue path covered | `npm test -- --filter=@filefn/server --filter=@filefn/processing` |
| 09 | Storage-azure statelessness | Azure adapter conformance for stateless multipart | `npm test -- --filter=@superfunctions/storage-azure` |
| 10 | Offline mode integration | OPFS staging behind config works end-to-end | `npm test -- --filter=@filefn/client` |

## Definition of Done (global)
No phase is complete unless:
1. All verification steps for that phase pass.
2. The change set satisfies the phase’s listed requirements.
3. No regressions in previously-passing FileFn test suites for the affected packages.

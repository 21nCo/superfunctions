# PLAN.md

## Architecture sketch
This audit-fix spans these modules and responsibilities:

- `filefn/server`
  - `src/upload-sessions/*`: session identity binding, status shape, upload mode selection, proxy upload, idempotency, cleanup
  - `src/files/*`: deterministic listing, version-aware provider behavior, delete cascade semantics, download descriptors
  - `src/shares/*`: real proxy share downloads and download-counter semantics
  - `src/processing/*`: artifact auth/download behavior and idempotent enqueue semantics
  - `src/auth*`: caller resolution and authorizer integration
  - `src/observability/*` and `src/events.ts`: secret-safe logging and canonical events
  - `src/index.ts`: public config surfaces (`rateLimit`, `dedup`) and FileProvider conformance
  - `src/__tests__/*` and `tests/*`: conformance coverage and build-green fixture fixes

- `filefn/client`
  - `src/client.ts`, `src/upload-manager.ts`, `src/types.ts`, `src/index.ts`, `src/offline/*`
  - package manifest rename to `@filefn/client`

- `filefn/processing`
  - processor contracts remain, but integration tests must cover idempotent enqueue + artifact semantics

- `packages/files`
  - FileProvider conformance tests

- `packages/middleware`, `packages/db`
  - route-category rate-limit shape and continued ISO resetAt semantics

- `filefn/python`
  - `filefn/__init__.py`
  - `filefn/server/*.py`
  - `filefn/processing/__init__.py`
  - `tests/*`

- `filefn/examples/full-demo`
  - smoke-verifiable demo alignment with canonical packages and routes

## Dependency graph
1. Add/repair conformance tests and build gates first.
2. Fix upload-session identity binding and resumability contract.
3. Fix upload mode selection, proxy upload, idempotency, and cleanup.
4. Fix deterministic listing, version-aware provider behavior, and real download descriptors.
5. Fix delete cascade and dedupe/reference semantics.
6. Align rate-limit config and observability invariants.
7. Bring Python exports/config to parity, then Python flow behavior.
8. Finish with demo smoke verification and full-package regression verification.

## Phases overview
| Phase | Goal | Delivered capability | Verification |
|---:|---|---|---|
| 00 | Lock the audit findings into tests and build gates | Failing conformance tests for unresolved TS/Python issues | `npm test -- --run` / `pytest` expected to expose the current gaps |
| 01 | Bind upload sessions to the initiating caller and fix the resume contract | Session auth, anonymous session tokens, canonical status payload, client package boundary, server build-green fixtures | `cd filefn/server && npm test -- --run && npm run typecheck`; `cd filefn/client && npm test -- --run && npm run typecheck` |
| 02 | Fix upload mode selection and proxy upload semantics | No bare `signed-url`, durable proxy upload path, deterministic idempotency | `cd filefn/server && npm test -- --run`; `cd filefn/client && npm test -- --run` |
| 03 | Make file/version reads deterministic and binding-safe | Stable list pagination, provider `versionId` semantics, version-bound reads/downloads | `cd filefn/server && npm test -- --run` |
| 04 | Replace all placeholder proxy downloads and secure artifact/share access | Real file/share/artifact proxy routes and authz-safe access | `cd filefn/server && npm test -- --run` |
| 05 | Implement delete cascade and dedupe-safe storage semantics | Full metadata cleanup and reference-safe deletion | `cd filefn/server && npm test -- --run` |
| 06 | Finish shared package and observability invariants | Route-category rate limits, FileProvider conformance tests, secret-safe events/logs | `cd packages/middleware && npm test -- --run`; `cd packages/files && npm test -- --run`; `cd filefn/server && npm test -- --run` |
| 07 | Repair Python public surfaces and config parity | Python exports, auth/rate_limit/dedup config, test scaffold | `cd filefn/python && python3 -m pytest -k core` |
| 08 | Repair Python behavior parity | Python upload/download/share/processing/dedupe semantics match TS | `cd filefn/python && python3 -m pytest` |
| 09 | Verify the full demo and full package readiness | Smoke-tested demo and complete regression pass | full verification command set from `TV-BUILD-001` plus demo smoke steps |

## Definition of Done (global)
No phase is complete unless:
1. all listed verification steps pass locally;
2. all requirements mapped to that phase are satisfied;
3. previously-passing tests for affected packages still pass;
4. no placeholder behavior remains for the surfaces touched by that phase.

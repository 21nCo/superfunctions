# Plan

## Architecture sketch

### TypeScript modules

- `sendfn/typescript/src/sendfn.ts`
  - client construction, lifecycle, optional admin router mounting
- `sendfn/typescript/src/types.ts`
  - public request/response/model types and query filter types
- `sendfn/typescript/src/errors.ts`
  - canonical typed runtime errors
- `sendfn/typescript/src/email/*`
  - provider contract, SES adapter, email orchestration
- `sendfn/typescript/src/templates/*`
  - deterministic template rendering and built-in templates
- `sendfn/typescript/src/database/*`
  - sendfn-specific query helpers over `@superfunctions/db`
- `sendfn/typescript/src/events/*`
  - event recording, SNS verification, SES webhook processing
- `sendfn/typescript/src/push/*`
  - FCM/APNS fan-out and device lifecycle helpers
- `sendfn/typescript/tests/*`
  - release-gate, contract, and regression tests

### Python modules

- `sendfn/python/sendfn/__init__.py`
  - public exports only; no eager optional imports
- `sendfn/python/sendfn/client.py`
  - client construction, lifecycle, parity surface
- `sendfn/python/sendfn/errors.py`
  - canonical typed runtime errors
- `sendfn/python/sendfn/models.py`
  - Pydantic model surface and query filter types
- `sendfn/python/sendfn/email/*`
  - SES adapter, template engine, email orchestration
- `sendfn/python/sendfn/database/*`
  - helper queries and memory adapter fidelity
- `sendfn/python/sendfn/events/*`
  - event tracking, SNS verification, webhook processing
- `sendfn/python/sendfn/http/*`
  - admin API route envelopes and optional integrations
- `sendfn/python/sendfn/push/*`
  - FCM/APNS fan-out and device lifecycle
- `sendfn/python/tests/*`
  - import, parity, webhook, performance, and adapter-fidelity tests

## Dependency graph

1. Packaging/import hygiene MUST land before release-gate verification.
2. Public error and API surface changes MUST land before HTTP/admin route envelope work.
3. Template engine and email validation MUST land before webhook/event correlation tests can be trusted end-to-end.
4. Query-layer provider-message-id lookup MUST land before webhook correlation work.
5. SNS verification MUST land before webhook route hardening can be called complete.
6. Push/device lifecycle improvements MUST land before performance and determinism verification.
7. Test-double fidelity MUST land before final release-gate signoff.
8. Documentation alignment MUST land after public API, packaging, and route semantics are stable.

## Phases overview

| Phase | Goal | Delivered capability | Verification method |
| --- | --- | --- | --- |
| 00 | Establish clean-checkout release-gate baseline and package identity | runnable build/lint/test/import baseline and package-name alignment guardrails | repo-root install/build/lint/test/import commands |
| 01 | Align public API surface and lifecycle across TS/Python | coherent exports, lazy optional imports, typed errors, `close()` parity, and explicit device/suppression lifecycle method parity | public-surface tests and base-import tests |
| 02 | Fix template and email orchestration correctness | deterministic templates, validated email sends, bounded retry/limits | template/email service regression tests |
| 03 | Extend query/persistence behavior for correlation | provider-message-id lookups, richer event filters, deterministic suppression bulk/export behavior, and stronger adapter fidelity | DB helper contract tests |
| 04 | Secure and correlate webhook processing | SNS verification, idempotent lifecycle updates, orphan-event handling, suppression correctness | webhook verification and correlation tests |
| 05 | Fix push/device scalability and determinism | FCM chunking, APNS concurrency cap, token refresh/cleanup, deterministic push return behavior | push/device regression and timing tests |
| 06 | Harden test doubles and full release gate | realistic memory/mock behavior and comprehensive regression suite | full repo-root build/lint/test matrix |
| 07 | Align docs/examples and ship final verification evidence | README/example correctness and operator setup guidance | docs/example validation plus release gate rerun |

## Definition of Done

No phase is complete unless its verification steps pass.

Global Definition of Done:

1. All P0 requirements in `REQUIREMENTS.md` pass their positive and negative vectors.
2. Repo-root TypeScript and Python release-gate commands pass after documented installation steps.
3. Webhook verification and transaction correlation tests pass in both SDKs.
4. No shipped README or example uses a mismatched package name or unsupported feature description.
5. No new local generic DB/HTTP abstraction is introduced under `sendfn`.
